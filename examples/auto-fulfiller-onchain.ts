#!/usr/bin/env npx tsx
// ============================================================================
// Mindstate Auto-Fulfillment Watcher — On-Chain Delivery
// ============================================================================
//
// Watches for Redeemed events and delivers decryption keys via the contract's
// deliverKeyEnvelope(). Consumers fetch directly from the contract (no IPFS).
//
// Two modes:
//   1. CATCH-UP — If CREATED_AT_BLOCK is set, scans all historical Redeemed
//      events from that block to HEAD in batched chunks. Deduplicates consumers,
//      checks hasKeyEnvelope on-chain, and delivers any missing key envelopes.
//      Get the block number from Basescan → Contract Creation tx.
//   2. LIVE WATCH — After catch-up (or immediately if no CREATED_AT_BLOCK),
//      polls for new Redeemed events every POLL_INTERVAL_MS from the current block.
//
// Designed to be bulletproof:
//   • Checks hasKeyEnvelope before every delivery (no duplicate txs / wasted gas)
//   • Batched historical log queries (safe for public RPCs with 2k–10k block limits)
//   • Deduplicates (account, checkpointId) pairs so each consumer is processed once
//   • Sequential polling loop (no overlapping polls)
//   • lastBlock only advances after the full batch succeeds
//   • Retry with exponential backoff on transient failures
//   • Graceful shutdown — waits for in-flight deliveries before exiting
//   • Consecutive RPC failure tracking with clear diagnostics
//
// Usage:
//   cd sdk && npx tsx examples/auto-fulfiller-onchain.ts
//
// Required environment variables:
//   MINDSTATE_TOKEN    — Token contract address (0x...)
//   RPC_URL            — Ethereum JSON-RPC endpoint (e.g. Base mainnet)
//   PUBLISHER_KEY      — Publisher's Ethereum private key (sends deliverKeyEnvelope tx)
//   PUBLISHER_X25519   — Publisher's X25519 secret key (hex, 64 chars) — same key
//                        you used when publishing checkpoints
//
// Optional:
//   CREATED_AT_BLOCK   — Block at which the token was deployed. Enables catch-up
//                        scan of all historical Redeemed events. Get from Basescan
//                        "Contract Creation" tx. If omitted, live-watch only.
//   KEY_STORE_PATH     — Path to JSON file for checkpoint keys (default: .mindstate-keys.json)
//   POLL_INTERVAL_MS   — Polling interval in milliseconds (default: 12000)
//   MAX_RETRIES        — Max delivery retry attempts per event (default: 5)
//   LOG_BATCH_SIZE     — Max blocks per queryFilter call during catch-up (default: 2000)
//
// Key store format: { "<checkpointId>": "<contentKeyHex>" }
// Add keys manually after each publish, or the script will warn about missing keys.
//
// ============================================================================

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from cwd or script directory before reading config
function loadEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '.env'),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) {
          const key = m[1].trim();
          let val = m[2].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) process.env[key] = val;
        }
      }
      return;
    }
  }
}
loadEnv();

import {
  MINDSTATE_ABI,
  ZERO_BYTES32,
  OnChainKeyDelivery,
  OnChainPublisherKeyManager,
} from '@mindstate/sdk';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TOKEN_ADDRESS = requireEnv('MINDSTATE_TOKEN');
const RPC_URL = requireEnv('RPC_URL');
const PUBLISHER_PRIVATE_KEY = requireEnv('PUBLISHER_KEY');
const X25519_SECRET_HEX = requireEnv('PUBLISHER_X25519');
const CREATED_AT_BLOCK = process.env.CREATED_AT_BLOCK
  ? parseInt(process.env.CREATED_AT_BLOCK, 10)
  : undefined;
const KEY_STORE_PATH = process.env.KEY_STORE_PATH || path.resolve(process.cwd(), '.mindstate-keys.json');
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '12000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '5', 10);
const LOG_BATCH_SIZE = parseInt(process.env.LOG_BATCH_SIZE || '2000', 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Key Persistence
// ---------------------------------------------------------------------------

function loadKeyStore(): Record<string, string> {
  try {
    if (fs.existsSync(KEY_STORE_PATH)) {
      return JSON.parse(fs.readFileSync(KEY_STORE_PATH, 'utf-8'));
    }
  } catch {
    log('Warning: could not load key store, starting fresh');
  }
  return {};
}

// ---------------------------------------------------------------------------
// Retry wrapper with exponential backoff
// ---------------------------------------------------------------------------

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts: number = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);

      if (isNonRetryable(msg)) {
        throw err;
      }

      if (attempt < maxAttempts) {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
        log(`  Retry ${attempt}/${maxAttempts} for "${label}" in ${delayMs}ms — ${msg}`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function isNonRetryable(msg: string): boolean {
  const permanent = [
    'insufficient funds',
    'nonce too low',
    'execution reverted',
    'UNPREDICTABLE_GAS_LIMIT',
    'already known',
  ];
  return permanent.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Shutdown coordination
// ---------------------------------------------------------------------------

let shutdownRequested = false;
let inFlightCount = 0;

function beginWork(): void {
  inFlightCount++;
}

function endWork(): void {
  inFlightCount--;
}

async function awaitInFlight(timeoutMs: number = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlightCount > 0 && Date.now() < deadline) {
    log(`  Waiting for ${inFlightCount} in-flight delivery(ies)...`);
    await sleep(1000);
  }
  if (inFlightCount > 0) {
    log(`  Warning: ${inFlightCount} delivery(ies) still in-flight after timeout.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('Mindstate Auto-Fulfillment Watcher (On-Chain Delivery)');
  log('========================================================');
  log(`Token:     ${TOKEN_ADDRESS}`);
  log(`RPC:       ${RPC_URL}`);
  log(`Keys:      ${KEY_STORE_PATH}`);
  log(`Catch-up:  ${CREATED_AT_BLOCK !== undefined ? `from block ${CREATED_AT_BLOCK}` : 'disabled (set CREATED_AT_BLOCK to enable)'}`);
  log(`Poll:      ${POLL_MS}ms`);
  log(`Batch:     ${LOG_BATCH_SIZE} blocks`);
  log(`Retries:   ${MAX_RETRIES}`);
  log('');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PUBLISHER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(TOKEN_ADDRESS, MINDSTATE_ABI, wallet);

  // Verify publisher
  const onChainPublisher: string = await contract.publisher();
  if (onChainPublisher.toLowerCase() !== wallet.address.toLowerCase()) {
    log(`Error: wallet ${wallet.address} is not the publisher (${onChainPublisher}).`);
    process.exit(1);
  }
  log(`Publisher: ${wallet.address} (verified)`);

  // X25519 key pair (same one used when publishing)
  const secretKey = fromHex(X25519_SECRET_HEX);
  if (secretKey.length !== 32) {
    log('Error: PUBLISHER_X25519 must be 64 hex chars (32 bytes).');
    process.exit(1);
  }
  const naclMod = await import('tweetnacl');
  const nacl = naclMod.default ?? naclMod;
  const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);
  const publisherKeys = { publicKey: keyPair.publicKey, secretKey: keyPair.secretKey };

  // On-chain delivery
  const delivery = new OnChainKeyDelivery(wallet);
  const keyManager = new OnChainPublisherKeyManager(publisherKeys, delivery);

  const storedKeys = loadKeyStore();
  for (const [cpId, keyHex] of Object.entries(storedKeys)) {
    const key = fromHex(keyHex);
    if (key.length === 32) {
      keyManager.storeKey(cpId.toLowerCase(), key);
    }
  }
  log(`Loaded ${Object.keys(storedKeys).length} key(s) from key store.`);

  const cpCount = await contract.checkpointCount();
  log(`Token has ${cpCount} checkpoint(s).`);

  let missingKeys = 0;
  for (let i = 0; i < Number(cpCount); i++) {
    const cpId = await contract.getCheckpointIdAtIndex(i);
    if (!keyManager.hasKey(cpId)) {
      missingKeys++;
      log(`Warning: no key for checkpoint #${i} (${cpId.slice(0, 18)}...). Add to key store.`);
    }
  }
  if (missingKeys > 0) {
    log(`${missingKeys} checkpoint(s) missing keys. Format: { "<checkpointId>": "<contentKeyHex>" }`);
  }

  const redeemMode = await contract.redeemMode();
  const isUniversal = redeemMode === 1n || redeemMode === 1;
  log(`Redeem mode: ${isUniversal ? 'Universal' : 'PerCheckpoint'}`);

  let fulfillmentCount = 0;
  let skippedDuplicates = 0;

  // -----------------------------------------------------------------------
  // Deliver keys for a single redemption, with duplicate guard
  // -----------------------------------------------------------------------

  async function handleRedemption(
    account: string,
    checkpointId: string,
    cost: bigint,
    blockNumber?: number,
  ) {
    const label = blockNumber !== undefined ? `block ${blockNumber}` : 'live';
    log(`--- Redemption (${label}) ---`);
    log(`  Consumer:   ${account}`);
    log(`  Checkpoint: ${checkpointId}`);
    log(`  Cost:       ${ethers.formatEther(cost)} tokens`);

    beginWork();
    try {
      const consumerKeyHex: string = await contract.getEncryptionKey(account);
      if (consumerKeyHex === ZERO_BYTES32) {
        log('  Skip: consumer has no encryption key registered.');
        return;
      }

      const consumerPubKey = fromHex(consumerKeyHex);

      if (isUniversal) {
        const total = Number(await contract.checkpointCount());
        log(`  Universal: checking ${total} checkpoint(s)...`);
        let delivered = 0;
        let alreadyDone = 0;
        let noKey = 0;

        for (let i = 0; i < total; i++) {
          if (shutdownRequested) {
            log('  Shutdown requested, stopping mid-batch.');
            break;
          }

          const cpId = await contract.getCheckpointIdAtIndex(i);

          // Duplicate guard: check on-chain before sending tx
          const alreadyDelivered: boolean = await contract.hasKeyEnvelope(account, cpId);
          if (alreadyDelivered) {
            alreadyDone++;
            continue;
          }

          if (!keyManager.hasKey(cpId)) {
            noKey++;
            continue;
          }

          await withRetry(`deliver #${i} to ${account.slice(0, 10)}`, () =>
            keyManager.fulfillRedemption(TOKEN_ADDRESS, cpId, account, consumerPubKey),
          );
          delivered++;
        }

        log(`  Results: ${delivered} delivered, ${alreadyDone} already done, ${noKey} no key`);
        skippedDuplicates += alreadyDone;
      } else {
        // Duplicate guard: check on-chain before sending tx
        const alreadyDelivered: boolean = await contract.hasKeyEnvelope(account, checkpointId);
        if (alreadyDelivered) {
          log('  Skip: key envelope already delivered on-chain.');
          skippedDuplicates++;
          return;
        }

        if (!keyManager.hasKey(checkpointId)) {
          log('  Skip: no key for this checkpoint.');
          return;
        }

        await withRetry(`deliver to ${account.slice(0, 10)}`, () =>
          keyManager.fulfillRedemption(TOKEN_ADDRESS, checkpointId, account, consumerPubKey),
        );
        log('  Delivered on-chain.');
      }

      fulfillmentCount++;
      log(`  Session total: ${fulfillmentCount} fulfilled, ${skippedDuplicates} skipped (already delivered)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  FAILED (after retries): ${msg}`);
    } finally {
      endWork();
    }
  }

  // -----------------------------------------------------------------------
  // Catch-up: scan historical Redeemed events in batched chunks
  // -----------------------------------------------------------------------

  async function catchUp(fromBlock: number, toBlock: number) {
    log(`Catch-up: scanning blocks ${fromBlock}–${toBlock} (${toBlock - fromBlock + 1} blocks, batch size ${LOG_BATCH_SIZE})`);

    // Phase 1: collect all Redeemed events in batched queries
    const allEvents: Array<{ account: string; checkpointId: string; cost: bigint; blockNumber: number }> = [];
    let cursor = fromBlock;

    while (cursor <= toBlock) {
      if (shutdownRequested) break;

      const batchEnd = Math.min(cursor + LOG_BATCH_SIZE - 1, toBlock);
      const pct = ((cursor - fromBlock) / (toBlock - fromBlock + 1) * 100).toFixed(1);
      log(`  Scanning blocks ${cursor}–${batchEnd} (${pct}%)...`);

      const events = await withRetry(`queryFilter ${cursor}–${batchEnd}`, () =>
        contract.queryFilter(catchUpFilter, cursor, batchEnd),
      );

      for (const ev of events) {
        const account = ev.args?.account ?? ev.args?.[0];
        const checkpointId = ev.args?.checkpointId ?? ev.args?.[1];
        const cost = ev.args?.cost ?? ev.args?.[2] ?? 0n;
        if (account && checkpointId !== undefined) {
          allEvents.push({ account, checkpointId, cost, blockNumber: ev.blockNumber ?? 0 });
        }
      }

      cursor = batchEnd + 1;
    }

    log(`  Found ${allEvents.length} total Redeemed event(s).`);

    // Phase 2: deduplicate by (account, checkpointId) — only need to deliver once per pair
    const seen = new Set<string>();
    const unique: typeof allEvents = [];
    for (const ev of allEvents) {
      const key = `${ev.account.toLowerCase()}:${ev.checkpointId.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(ev);
      }
    }

    if (unique.length < allEvents.length) {
      log(`  Deduplicated: ${allEvents.length} events → ${unique.length} unique (account, checkpoint) pairs`);
    }

    // Phase 3: process each unique redemption (hasKeyEnvelope guard is inside handleRedemption)
    let catchUpDelivered = 0;
    let catchUpSkipped = 0;

    for (const ev of unique) {
      if (shutdownRequested) break;
      const beforeFulfillments = fulfillmentCount;
      await handleRedemption(ev.account, ev.checkpointId, ev.cost, ev.blockNumber);
      if (fulfillmentCount > beforeFulfillments) {
        catchUpDelivered++;
      } else {
        catchUpSkipped++;
      }
    }

    log(`Catch-up complete: ${catchUpDelivered} delivered, ${catchUpSkipped} already fulfilled or skipped.`);
    log('');
  }

  const catchUpFilter = contract.filters.Redeemed();
  const currentHeadBlock = await provider.getBlockNumber();

  if (CREATED_AT_BLOCK !== undefined) {
    if (CREATED_AT_BLOCK > currentHeadBlock) {
      log(`Warning: CREATED_AT_BLOCK (${CREATED_AT_BLOCK}) is ahead of chain head (${currentHeadBlock}). Skipping catch-up.`);
    } else {
      await catchUp(CREATED_AT_BLOCK, currentHeadBlock);
    }
  } else {
    log('No CREATED_AT_BLOCK set — skipping catch-up. Set it to scan historical redemptions.');
  }

  if (shutdownRequested) return;

  // -----------------------------------------------------------------------
  // Sequential polling loop (live watch from HEAD onward)
  // -----------------------------------------------------------------------

  let lastBlock = await provider.getBlockNumber();
  log(`Starting live watch from block ${lastBlock}`);
  log('Consumers will see keys in Fetch & Decrypt on the redeem page.');
  log('Press Ctrl+C to stop.');
  log('');

  const liveFilter = contract.filters.Redeemed();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  async function pollOnce() {
    const currentBlock = await provider.getBlockNumber();
    if (currentBlock <= lastBlock) return;

    const fromBlock = lastBlock + 1;
    const toBlock = currentBlock;
    const events = await contract.queryFilter(liveFilter, fromBlock, toBlock);

    if (events.length > 0) {
      log(`Polled blocks ${fromBlock}–${toBlock}: ${events.length} Redeemed event(s)`);
    }

    // Process every event; only advance lastBlock after the full batch
    for (const ev of events) {
      if (shutdownRequested) break;

      const account = ev.args?.account ?? ev.args?.[0];
      const evCheckpointId = ev.args?.checkpointId ?? ev.args?.[1];
      const cost = ev.args?.cost ?? ev.args?.[2] ?? 0n;

      if (!account || evCheckpointId === undefined) {
        log(`  Warning: malformed event in block ${ev.blockNumber}, skipping.`);
        continue;
      }

      await handleRedemption(account, evCheckpointId, cost, ev.blockNumber);
    }

    // Only advance after successfully iterating the full batch
    lastBlock = toBlock;
  }

  // Sequential loop: wait for poll to finish, then sleep, then poll again.
  // This guarantees no overlapping polls.
  async function pollLoop() {
    while (!shutdownRequested) {
      try {
        await pollOnce();
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        log(`Poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${msg}`);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log(`${MAX_CONSECUTIVE_ERRORS} consecutive RPC failures. The RPC endpoint may be down.`);
          log(`Will keep retrying with extended backoff...`);
        }

        // Extended backoff on sustained failures: up to 2 minutes
        const backoffMs = Math.min(POLL_MS * 2 ** Math.min(consecutiveErrors - 1, 4), 120_000);
        await sleep(backoffMs);
        continue;
      }

      if (!shutdownRequested) {
        await sleep(POLL_MS);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Graceful shutdown
  // -----------------------------------------------------------------------

  process.on('SIGINT', async () => {
    if (shutdownRequested) {
      log('Force exit.');
      process.exit(1);
    }

    shutdownRequested = true;
    log('');
    log('Shutdown requested. Finishing in-flight deliveries...');

    await awaitInFlight();

    log(`Session summary: ${fulfillmentCount} fulfilled, ${skippedDuplicates} skipped (already delivered)`);
    log(`Last processed block: ${lastBlock}`);
    process.exit(0);
  });

  await pollLoop();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
