#!/usr/bin/env npx tsx
// ============================================================================
// Mindstate Auto-Fulfillment Watcher
// ============================================================================
//
// A standalone script that watches for Redeemed events on a Mindstate token
// contract and automatically wraps + delivers decryption keys to consumers.
//
// Usage:
//   npx tsx auto-fulfiller.ts
//
// Required environment variables:
//   MINDSTATE_TOKEN    — Token contract address (0x...)
//   RPC_URL            — Ethereum JSON-RPC endpoint
//   PUBLISHER_KEY      — Publisher's Ethereum private key (for reading on-chain state)
//   PUBLISHER_X25519   — Publisher's X25519 secret key (hex, 64 chars)
//   IPFS_API_URL       — IPFS API endpoint (e.g. http://localhost:5001)
//   IPFS_GATEWAY       — IPFS gateway (e.g. https://ipfs.io)
//   KEY_INDEX_URI      — (Optional) Existing key index URI to resume from
//
// The script:
//   1. Connects to the token contract
//   2. Loads any existing key index from IPFS
//   3. Watches for Redeemed events in real-time
//   4. For each redemption:
//      a. Reads the consumer's X25519 public key from on-chain
//      b. Wraps the content-encryption key K for that consumer
//      c. Uploads the wrapped envelope to IPFS
//      d. Publishes an updated key index
//   5. Handles restarts gracefully via the persisted key store
//
// ============================================================================

import { ethers } from 'ethers';
import {
  MINDSTATE_ABI,
  ZERO_BYTES32,
  PublisherKeyManager,
  StorageKeyDelivery,
  IpfsStorage,
} from '@mindstate/sdk';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TOKEN_ADDRESS = requireEnv('MINDSTATE_TOKEN');
const RPC_URL = requireEnv('RPC_URL');
const PUBLISHER_PRIVATE_KEY = requireEnv('PUBLISHER_KEY');
const X25519_SECRET_HEX = requireEnv('PUBLISHER_X25519');
const IPFS_API_URL = requireEnv('IPFS_API_URL');
const IPFS_GATEWAY = requireEnv('IPFS_GATEWAY');
const KEY_INDEX_URI = process.env.KEY_INDEX_URI || '';

const KEY_STORE_PATH = path.resolve(process.cwd(), '.mindstate-keys.json');
const INDEX_URI_PATH = path.resolve(process.cwd(), '.mindstate-index-uri');

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

function saveKeyStore(keys: Record<string, string>) {
  fs.writeFileSync(KEY_STORE_PATH, JSON.stringify(keys, null, 2));
}

function saveIndexUri(uri: string) {
  fs.writeFileSync(INDEX_URI_PATH, uri);
  log(`Index URI saved to ${INDEX_URI_PATH}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('Mindstate Auto-Fulfillment Watcher');
  log('===================================');
  log(`Token:    ${TOKEN_ADDRESS}`);
  log(`RPC:      ${RPC_URL}`);
  log(`IPFS API: ${IPFS_API_URL}`);
  log('');

  // --- Provider + Contract ---
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PUBLISHER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(TOKEN_ADDRESS, MINDSTATE_ABI, wallet);

  // --- Verify publisher ---
  const onChainPublisher = await contract.publisher();
  if (onChainPublisher.toLowerCase() !== wallet.address.toLowerCase()) {
    log(`Warning: wallet ${wallet.address} is not the publisher (${onChainPublisher}).`);
    log('The watcher will still run but fulfillment may fail for key wrapping.');
  }

  // --- Storage + Delivery ---
  const storage = new IpfsStorage({ gateway: IPFS_GATEWAY, apiUrl: IPFS_API_URL });
  const delivery = new StorageKeyDelivery(storage);

  // Load existing index if provided
  if (KEY_INDEX_URI) {
    log(`Loading existing key index from ${KEY_INDEX_URI}...`);
    await delivery.loadIndex(KEY_INDEX_URI);
    log('Index loaded.');
  }

  // --- Publisher Key Pair ---
  const secretKey = fromHex(X25519_SECRET_HEX);
  // Derive the public key (NaCl convention: first 32 bytes of crypto_scalarmult_base)
  // For simplicity, import nacl if available or use the SDK's generateEncryptionKeyPair
  const nacl = await import('tweetnacl');
  const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);
  const publisherKeys = { publicKey: keyPair.publicKey, secretKey: keyPair.secretKey };

  // --- Key Manager ---
  const keyManager = new PublisherKeyManager(publisherKeys, delivery);

  // Load persisted keys
  const storedKeys = loadKeyStore();
  if (Object.keys(storedKeys).length > 0) {
    keyManager.importKeys(storedKeys);
    log(`Loaded ${Object.keys(storedKeys).length} stored key(s) from disk.`);
  }

  // --- Read existing checkpoint count ---
  const cpCount = await contract.checkpointCount();
  log(`Token has ${cpCount} checkpoint(s).`);

  // Verify we have keys for all checkpoints
  let missingKeys = 0;
  for (let i = 0; i < Number(cpCount); i++) {
    const cpId = await contract.getCheckpointIdAtIndex(i);
    if (!keyManager.hasKey(cpId)) {
      missingKeys++;
      log(`Warning: no key stored for checkpoint #${i} (${cpId.slice(0, 18)}...)`);
    }
  }
  if (missingKeys > 0) {
    log(`${missingKeys} checkpoint(s) missing keys. Use keyManager.storeKey() to add them.`);
  }

  // --- Get current redeem mode ---
  const redeemMode = await contract.redeemMode();
  const isUniversal = redeemMode === 1n || redeemMode === 1;
  log(`Redeem mode: ${isUniversal ? 'Universal' : 'PerCheckpoint'}`);

  // --- Fulfillment handler ---
  let fulfillmentCount = 0;

  async function handleRedemption(account: string, checkpointId: string, cost: bigint) {
    log(`--- Redemption detected ---`);
    log(`  Consumer: ${account}`);
    log(`  Checkpoint: ${checkpointId}`);
    log(`  Cost: ${ethers.formatEther(cost)} tokens burned`);

    try {
      // Read consumer's encryption key
      const consumerKeyHex: string = await contract.getEncryptionKey(account);

      if (consumerKeyHex === ZERO_BYTES32) {
        log(`  ⚠ Consumer has no encryption key registered. Cannot deliver.`);
        log(`  Will retry when they register (listen for EncryptionKeyRegistered).`);
        return;
      }

      const consumerPubKey = fromHex(consumerKeyHex);

      // For Universal mode, we need to fulfill for ALL checkpoints
      if (isUniversal) {
        const total = Number(await contract.checkpointCount());
        log(`  Universal mode: fulfilling for all ${total} checkpoint(s)...`);

        for (let i = 0; i < total; i++) {
          const cpId = await contract.getCheckpointIdAtIndex(i);
          if (keyManager.hasKey(cpId)) {
            await keyManager.fulfillRedemption(TOKEN_ADDRESS, cpId, account, consumerPubKey);
            log(`  ✓ Delivered key for checkpoint #${i}`);
          } else {
            log(`  ✗ No key for checkpoint #${i} — skipped`);
          }
        }
      } else {
        // PerCheckpoint mode: fulfill for the specific checkpoint
        if (keyManager.hasKey(checkpointId)) {
          await keyManager.fulfillRedemption(TOKEN_ADDRESS, checkpointId, account, consumerPubKey);
          log(`  ✓ Key delivered for checkpoint`);
        } else {
          log(`  ✗ No key for this checkpoint — cannot fulfill`);
          return;
        }
      }

      // Publish updated index
      const indexUri = await delivery.publishIndex();
      saveIndexUri(indexUri);
      log(`  ✓ Index published: ${indexUri}`);

      fulfillmentCount++;
      log(`  Total fulfillments: ${fulfillmentCount}`);
    } catch (err) {
      log(`  ✗ Fulfillment error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Watch for Redeemed events ---
  log('');
  log('Watching for Redeemed events...');
  log('Press Ctrl+C to stop.');
  log('');

  contract.on('Redeemed', handleRedemption);

  // --- Also watch for EncryptionKeyRegistered (retry pending fulfillments) ---
  contract.on('EncryptionKeyRegistered', async (account: string) => {
    log(`Encryption key registered by ${account}`);
    log(`(If they have pending redemptions, re-run fulfillment manually or restart the watcher.)`);
  });

  // --- Graceful shutdown ---
  process.on('SIGINT', () => {
    log('');
    log('Shutting down...');
    log(`Total fulfillments this session: ${fulfillmentCount}`);

    // Save keys on exit
    const allKeys = keyManager.exportKeys();
    saveKeyStore(allKeys);
    log(`Key store saved (${Object.keys(allKeys).length} key(s)).`);

    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
