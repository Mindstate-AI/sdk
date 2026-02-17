/**
 * Integration test — full protocol loop on a local Anvil chain.
 *
 * Requires `anvil` and `forge`/`cast` (Foundry) to be installed.
 *
 * Run with: npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ethers } from 'ethers';

import { createCapsule, serializeCapsule } from '../capsule.js';
import { computeStateCommitment } from '../commitment.js';
import { generateEncryptionKeyPair, generateContentKey } from '../encryption.js';
import { MindstateClient } from '../client.js';
import { StorageKeyDelivery, PublisherKeyManager } from '../keyDelivery.js';
import { MindstateExplorer } from '../explorer.js';
import type { StorageProvider } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMemoryStorage(): StorageProvider {
  const store = new Map<string, Uint8Array>();
  let counter = 0;
  return {
    async upload(data: Uint8Array) {
      const uri = `mem://${counter++}`;
      store.set(uri, new Uint8Array(data));
      return uri;
    },
    async download(uri: string) {
      const data = store.get(uri);
      if (!data) throw new Error(`Not found: ${uri}`);
      return data;
    },
  };
}

function loadArtifact(name: string) {
  const artifactPath = resolve(
    __dirname, '..', '..', '..', 'contracts', 'out', `${name}.sol`, `${name}.json`,
  );
  const raw = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  return { abi: raw.abi, bytecode: raw.bytecode.object as string };
}

const ANVIL_PORT = 18545;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const PUBLISHER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CONSUMER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CONSUMER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CONTRACTS_DIR = resolve(__dirname, '..', '..', '..', 'contracts');

/** Run a cast/forge command and return stdout. */
function run(cmd: string): string {
  return execSync(cmd, { cwd: CONTRACTS_DIR, encoding: 'utf-8' }).trim();
}

/** Get a fresh provider + wallet (avoids ethers nonce caching). */
function freshWallet(key: string): { provider: ethers.JsonRpcProvider; wallet: ethers.Wallet } {
  const provider = new ethers.JsonRpcProvider(ANVIL_URL);
  const wallet = new ethers.Wallet(key, provider);
  return { provider, wallet };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Mindstate Integration (Anvil)', () => {
  let anvil: ChildProcess;
  let tokenAddress: string;
  let storage: StorageProvider;

  beforeAll(async () => {
    // Kill any stale Anvil on our port
    try {
      execSync(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${ANVIL_PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' },
      );
      await new Promise(r => setTimeout(r, 500));
    } catch { /* nothing running */ }

    // Start a fresh Anvil
    anvil = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'], {
      stdio: 'ignore',
      shell: true,
    });

    // Wait for Anvil to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Anvil startup timeout')), 15000);
      const check = async () => {
        try {
          const resp = await fetch(`${ANVIL_URL}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
          });
          if (resp.ok) { clearTimeout(timeout); resolve(); return; }
        } catch { /* not ready */ }
        setTimeout(check, 300);
      };
      check();
    });

    storage = createMemoryStorage();

    // Deploy all contracts via forge/cast (reliable nonce management)
    const implAddr = run(
      `forge create --rpc-url ${ANVIL_URL} --private-key ${PUBLISHER_KEY} --broadcast src/MindstateToken.sol:MindstateToken`,
    ).match(/Deployed to:\s*(0x[0-9a-fA-F]+)/)![1];

    const factAddr = run(
      `forge create --rpc-url ${ANVIL_URL} --private-key ${PUBLISHER_KEY} --broadcast src/MindstateFactory.sol:MindstateFactory --constructor-args ${implAddr}`,
    ).match(/Deployed to:\s*(0x[0-9a-fA-F]+)/)![1];

    // Create token via cast
    run(
      `cast send --rpc-url ${ANVIL_URL} --private-key ${PUBLISHER_KEY} ${factAddr} "create(string,string,uint256,uint256,uint8)(address)" "Test Agent" "TAGENT" 1000000000000000000000000 100000000000000000000 0`,
    );

    tokenAddress = run(
      `cast call --rpc-url ${ANVIL_URL} ${factAddr} "getDeployment(uint256)(address)" 0`,
    );

    // Transfer tokens to consumer
    run(
      `cast send --rpc-url ${ANVIL_URL} --private-key ${PUBLISHER_KEY} ${tokenAddress} "transfer(address,uint256)(bool)" ${CONSUMER_ADDRESS} 10000000000000000000000`,
    );
  }, 30000);

  afterAll(async () => {
    try {
      execSync(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${ANVIL_PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' },
      );
    } catch { /* already dead */ }
    if (anvil) anvil.kill();
  });

  it('publishes a checkpoint and stores the key', async () => {
    const { wallet: pubWallet, provider } = freshWallet(PUBLISHER_KEY);
    const publisherKeys = generateEncryptionKeyPair();
    const delivery = new StorageKeyDelivery(storage);
    const keyManager = new PublisherKeyManager(publisherKeys, delivery);

    const capsule = createCapsule(
      { message: 'hello from integration test', timestamp: Date.now() },
      { schema: 'test/v1' },
    );

    const client = new MindstateClient({ provider, signer: pubWallet });
    const { checkpointId, sealedCapsule } = await client.publish(
      tokenAddress, capsule, { storage, label: 'v1.0' },
    );

    expect(checkpointId).toMatch(/^0x[0-9a-f]{64}$/);
    keyManager.storeKey(checkpointId, sealedCapsule.encryptionKey);

    const head = await client.getHead(tokenAddress);
    expect(head).toBe(checkpointId);
    expect(await client.getCheckpointCount(tokenAddress)).toBe(1);

    const taggedId = await client.resolveTag(tokenAddress, 'v1.0');
    expect(taggedId).toBe(checkpointId);

    provider.destroy();
  });

  it('consumer redeems, publisher fulfills, consumer decrypts', async () => {
    const publisherKeys = generateEncryptionKeyPair();
    const consumerKeys = generateEncryptionKeyPair();
    const delivery = new StorageKeyDelivery(storage);
    const keyManager = new PublisherKeyManager(publisherKeys, delivery);

    // Publish (fresh wallet)
    const { wallet: pubWallet, provider: pubProvider } = freshWallet(PUBLISHER_KEY);
    const capsule = createCapsule({ secret: 'classified data' });
    const pubClient = new MindstateClient({ provider: pubProvider, signer: pubWallet });
    const { checkpointId, sealedCapsule } = await pubClient.publish(
      tokenAddress, capsule, { storage },
    );
    keyManager.storeKey(checkpointId, sealedCapsule.encryptionKey);
    pubProvider.destroy();

    // Consumer registers encryption key (fresh wallet)
    const { wallet: conWallet1, provider: conProv1 } = freshWallet(CONSUMER_KEY);
    const conClient1 = new MindstateClient({ provider: conProv1, signer: conWallet1 });
    await conClient1.registerEncryptionKey(tokenAddress, consumerKeys.publicKey);
    conProv1.destroy();

    // Consumer redeems (fresh wallet)
    const { wallet: conWallet2, provider: conProv2 } = freshWallet(CONSUMER_KEY);
    const conClient2 = new MindstateClient({ provider: conProv2, signer: conWallet2 });
    await conClient2.redeem(tokenAddress, checkpointId);
    expect(await conClient2.hasRedeemed(tokenAddress, CONSUMER_ADDRESS, checkpointId)).toBe(true);
    conProv2.destroy();

    // Publisher fulfills
    const { provider: readProv } = freshWallet(PUBLISHER_KEY);
    const readClient = new MindstateClient({ provider: readProv });
    const regKey = await readClient.getEncryptionKey(tokenAddress, CONSUMER_ADDRESS);
    await keyManager.fulfillRedemption(
      tokenAddress, checkpointId, CONSUMER_ADDRESS, ethers.getBytes(regKey),
    );
    readProv.destroy();

    // Consumer consumes (fresh wallet)
    const { wallet: conWallet3, provider: conProv3 } = freshWallet(CONSUMER_KEY);
    const conClient3 = new MindstateClient({ provider: conProv3, signer: conWallet3 });
    const result = await conClient3.consume(tokenAddress, checkpointId, {
      keyDelivery: delivery,
      encryptionKeyPair: consumerKeys,
      storage,
    });

    expect(result.capsule.payload).toEqual({ secret: 'classified data' });
    expect(result.checkpoint.checkpointId).toBe(checkpointId);
    conProv3.destroy();
  });

  it('explorer builds timeline and resolves tags', async () => {
    const { provider } = freshWallet(PUBLISHER_KEY);
    const explorer = new MindstateExplorer(provider);
    const timeline = await explorer.getTimeline(tokenAddress);

    expect(timeline.length).toBeGreaterThanOrEqual(2);

    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].predecessorId).toBe(timeline[i - 1].checkpointId);
    }

    const stable = await explorer.resolveTag(tokenAddress, 'v1.0');
    expect(stable.checkpointId).toBe(timeline[0].checkpointId);

    const recent = await explorer.getRecent(tokenAddress, 1);
    expect(recent.length).toBe(1);
    expect(recent[0].checkpointId).toBe(timeline[timeline.length - 1].checkpointId);

    provider.destroy();
  });

  it('tagging works independently of publishing', async () => {
    const { wallet, provider } = freshWallet(PUBLISHER_KEY);
    const client = new MindstateClient({ provider, signer: wallet });
    const head = await client.getHead(tokenAddress);

    await client.tagCheckpoint(tokenAddress, head, 'latest-stable');
    const resolved = await client.resolveTag(tokenAddress, 'latest-stable');
    expect(resolved).toBe(head);

    const tag = await client.getCheckpointTag(tokenAddress, head);
    expect(tag).toBe('latest-stable');

    provider.destroy();
  });
});
