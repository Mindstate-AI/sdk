#!/usr/bin/env npx tsx
// ============================================================================
// Mindstate Auto-Fulfillment Watcher — On-Chain Delivery
// ============================================================================
//
// Watches for Redeemed events and delivers decryption keys via the contract's
// deliverKeyEnvelope(). Consumers fetch directly from the contract (no IPFS).
// Matches the Fetch & Decrypt flow in the redeem page.
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
//   CREATED_AT_BLOCK   — Block at which the token was deployed (catch-up start). Get from Basescan "Contract Creation".
//   KEY_STORE_PATH     — Path to JSON file for checkpoint keys (default: .mindstate-keys.json)
//
// Key store format: { "<checkpointId>": "<contentKeyHex>" }
// Add keys manually after each publish, or the script will prompt for missing keys.
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

// ---------------------------------------------------------------------------
// Key Persistence (same format as IPFS auto-fulfiller for compatibility)
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

function saveKeyStore(keys: Record<string, string>) {
  fs.writeFileSync(KEY_STORE_PATH, JSON.stringify(keys, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('Mindstate Auto-Fulfillment Watcher (On-Chain Delivery)');
  log('========================================================');
  log(`Token: ${TOKEN_ADDRESS}`);
  log(`RPC:  ${RPC_URL}`);
  log(`Keys: ${KEY_STORE_PATH}`);
  if (CREATED_AT_BLOCK !== undefined) {
    log(`Catch-up from: block ${CREATED_AT_BLOCK}`);
  }
  log('');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PUBLISHER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(TOKEN_ADDRESS, MINDSTATE_ABI, wallet);

  // Verify publisher
  const onChainPublisher = await contract.publisher();
  if (onChainPublisher.toLowerCase() !== wallet.address.toLowerCase()) {
    log(`Error: wallet ${wallet.address} is not the publisher (${onChainPublisher}).`);
    process.exit(1);
  }

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
  log(`Loaded ${Object.keys(storedKeys).length} key(s) from ${KEY_STORE_PATH}.`);

  const cpCount = await contract.checkpointCount();
  log(`Token has ${cpCount} checkpoint(s).`);

  let missingKeys = 0;
  for (let i = 0; i < Number(cpCount); i++) {
    const cpId = await contract.getCheckpointIdAtIndex(i);
    if (!keyManager.hasKey(cpId)) {
      missingKeys++;
      log(`Warning: no key for checkpoint #${i} (${cpId.slice(0, 18)}...). Add to ${KEY_STORE_PATH}.`);
    }
  }
  if (missingKeys > 0) {
    log(`${missingKeys} checkpoint(s) missing keys. Format: { "<checkpointId>": "<contentKeyHex>" }`);
  }

  const redeemMode = await contract.redeemMode();
  const isUniversal = redeemMode === 1n || redeemMode === 1;
  log(`Redeem mode: ${isUniversal ? 'Universal' : 'PerCheckpoint'}`);

  let fulfillmentCount = 0;

  async function handleRedemption(account: string, checkpointId: string, cost: bigint, label?: string) {
    log(`--- Redemption ${label ? `(${label})` : ''} ---`);
    log(`  Consumer: ${account}`);
    log(`  Checkpoint: ${checkpointId}`);
    log(`  Cost: ${ethers.formatEther(cost)} tokens`);

    try {
      const consumerKeyHex: string = await contract.getEncryptionKey(account);
      if (consumerKeyHex === ZERO_BYTES32) {
        log('  ⚠ Consumer has no encryption key. Cannot deliver. Skipping.');
        return;
      }

      const consumerPubKey = fromHex(consumerKeyHex);

      if (isUniversal) {
        const total = Number(await contract.checkpointCount());
        log(`  Universal: delivering for all ${total} checkpoint(s)...`);
        for (let i = 0; i < total; i++) {
          const cpId = await contract.getCheckpointIdAtIndex(i);
          if (keyManager.hasKey(cpId)) {
            await keyManager.fulfillRedemption(TOKEN_ADDRESS, cpId, account, consumerPubKey);
            log(`  ✓ Delivered #${i}`);
          } else {
            log(`  ✗ No key #${i}`);
          }
        }
      } else {
        if (keyManager.hasKey(checkpointId)) {
          await keyManager.fulfillRedemption(TOKEN_ADDRESS, checkpointId, account, consumerPubKey);
          log('  ✓ Key delivered on-chain');
        } else {
          log(`  ✗ No key for this checkpoint`);
        }
      }

      fulfillmentCount++;
      log(`  Total: ${fulfillmentCount}`);
    } catch (err) {
      log(`  ✗ Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Catch up: process historical Redeemed events ---
  if (CREATED_AT_BLOCK !== undefined) {
    log(`Catch-up from block ${CREATED_AT_BLOCK}...`);
    const currentBlock = await provider.getBlockNumber();
    const filter = contract.filters.Redeemed();
    const events = await contract.queryFilter(filter, CREATED_AT_BLOCK, currentBlock);
    log(`  Found ${events.length} Redeemed event(s).`);

    let caughtUp = 0;
    let skipped = 0;
    for (const ev of events) {
      const account = ev.args?.account ?? ev.args?.[0];
      const evCheckpointId = ev.args?.checkpointId ?? ev.args?.[1];
      const cost = ev.args?.cost ?? ev.args?.[2] ?? 0n;
      if (!account || evCheckpointId === undefined) continue;

      if (isUniversal) {
        const total = Number(await contract.checkpointCount());
        let anyUndelivered = false;
        for (let i = 0; i < total; i++) {
          const cpId = await contract.getCheckpointIdAtIndex(i);
          const delivered = await contract.hasKeyEnvelope(account, cpId);
          if (!delivered) {
            anyUndelivered = true;
            break;
          }
        }
        if (!anyUndelivered) {
          skipped++;
          continue;
        }
        await handleRedemption(account, evCheckpointId, cost, `catch-up block ${ev.blockNumber}`);
        caughtUp++;
      } else {
        const delivered = await contract.hasKeyEnvelope(account, evCheckpointId);
        if (delivered) {
          skipped++;
          continue;
        }
        await handleRedemption(account, evCheckpointId, cost, `catch-up block ${ev.blockNumber}`);
        caughtUp++;
      }
    }
    log(`  Caught up: ${caughtUp} delivered, ${skipped} already delivered.`);
    log('');
  }

  log('Watching for Redeemed events (polling every 12s)...');
  log('Consumers will see keys in Fetch & Decrypt on the redeem page.');
  log('Press Ctrl+C to stop.');
  log('');

  // Poll instead of contract.on() — public RPCs often don't support log filters
  const POLL_MS = 12_000;
  let lastBlock = await provider.getBlockNumber();
  const filter = contract.filters.Redeemed();

  const poll = async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastBlock) return;
      const events = await contract.queryFilter(filter, lastBlock + 1, currentBlock);
      lastBlock = currentBlock;
      for (const ev of events) {
        const account = ev.args?.account ?? ev.args?.[0];
        const evCheckpointId = ev.args?.checkpointId ?? ev.args?.[1];
        const cost = ev.args?.cost ?? ev.args?.[2] ?? 0n;
        if (account && evCheckpointId !== undefined) {
          await handleRedemption(account, evCheckpointId, cost);
        }
      }
    } catch (err) {
      log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const interval = setInterval(poll, POLL_MS);
  await poll();

  process.on('SIGINT', () => {
    clearInterval(interval);
    log('');
    log('Stopping...');
    log(`Fulfillments this session: ${fulfillmentCount}`);
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
