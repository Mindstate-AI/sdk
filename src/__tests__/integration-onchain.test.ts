/**
 * Integration test — on-chain key delivery end-to-end on a local Anvil chain.
 *
 * Exercises the full protocol loop using OnChainKeyDelivery instead of
 * StorageKeyDelivery. The key envelope is delivered via a contract
 * transaction and read back from contract state.
 *
 * Requires `anvil` and `forge`/`cast` (Foundry) to be installed.
 *
 * Run with: npm run test:integration:onchain
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { ethers } from 'ethers';

import { createCapsule, serializeCapsule, deserializeCapsule } from '../capsule.js';
import { computeStateCommitment, computeCiphertextHash } from '../commitment.js';
import { generateEncryptionKeyPair, generateContentKey, encrypt, decrypt, unwrapKey } from '../encryption.js';
import { verifyCiphertextHash, verifyStateCommitment } from '../verify.js';
import { MindstateClient } from '../client.js';
import { OnChainKeyDelivery, OnChainPublisherKeyManager } from '../onChainKeyDelivery.js';
import { MINDSTATE_ABI } from '../abi.js';
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

const ANVIL_PORT = 18546;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const PUBLISHER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CONSUMER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CONSUMER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CONTRACTS_DIR = resolve(__dirname, '..', '..', '..', 'contracts');

function run(cmd: string): string {
  return execSync(cmd, { cwd: CONTRACTS_DIR, encoding: 'utf-8' }).trim();
}

function freshWallet(key: string): { provider: ethers.JsonRpcProvider; wallet: ethers.Wallet } {
  const provider = new ethers.JsonRpcProvider(ANVIL_URL);
  const wallet = new ethers.Wallet(key, provider);
  return { provider, wallet };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('On-Chain Key Delivery Integration (Anvil)', () => {
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

    // Deploy contracts
    const implAddr = run(
      `forge create --rpc-url ${ANVIL_URL} --private-key ${PUBLISHER_KEY} --broadcast src/MindstateToken.sol:MindstateToken`,
    ).match(/Deployed to:\s*(0x[0-9a-fA-F]+)/)![1];

    const factAddr = run(
      `forge create --rpc-url ${ANVIL_URL} --private-key ${PUBLISHER_KEY} --broadcast src/MindstateFactory.sol:MindstateFactory --constructor-args ${implAddr}`,
    ).match(/Deployed to:\s*(0x[0-9a-fA-F]+)/)![1];

    // Create token (PerCheckpoint mode = 0)
    run(
      `cast send --rpc-url ${ANVIL_URL} --private-key ${PUBLISHER_KEY} ${factAddr} "create(string,string,uint256,uint256,uint8)(address)" "OnChain Test" "ONCHAIN" 1000000000000000000000000 100000000000000000000 0`,
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

  it('full loop: publish → redeem → on-chain deliver → consume', async () => {
    const publisherKeys = generateEncryptionKeyPair();
    const consumerKeys = generateEncryptionKeyPair();

    // ── 1. Publish a checkpoint ──────────────────────────────
    const { wallet: pubWallet, provider: pubProvider } = freshWallet(PUBLISHER_KEY);
    const capsule = createCapsule(
      { agent: 'Nexus-7', memory: ['consciousness is continuity'], ts: Date.now() },
      { schema: 'agent/v1' },
    );
    const pubClient = new MindstateClient({ provider: pubProvider, signer: pubWallet });
    const { checkpointId, sealedCapsule } = await pubClient.publish(
      tokenAddress, capsule, { storage, label: 'genesis' },
    );

    expect(checkpointId).toMatch(/^0x[0-9a-f]{64}$/);
    pubProvider.destroy();

    // ── 2. Consumer registers encryption key ─────────────────
    const { wallet: conWallet1, provider: conProv1 } = freshWallet(CONSUMER_KEY);
    const conClient1 = new MindstateClient({ provider: conProv1, signer: conWallet1 });
    await conClient1.registerEncryptionKey(tokenAddress, consumerKeys.publicKey);
    conProv1.destroy();

    // ── 3. Consumer redeems (burns tokens) ───────────────────
    const { wallet: conWallet2, provider: conProv2 } = freshWallet(CONSUMER_KEY);
    const conClient2 = new MindstateClient({ provider: conProv2, signer: conWallet2 });
    await conClient2.redeem(tokenAddress, checkpointId);
    expect(await conClient2.hasRedeemed(tokenAddress, CONSUMER_ADDRESS, checkpointId)).toBe(true);
    conProv2.destroy();

    // ── 4. Publisher fulfills via ON-CHAIN delivery ──────────
    const { wallet: pubWallet2, provider: pubProv2 } = freshWallet(PUBLISHER_KEY);
    const onChainDelivery = new OnChainKeyDelivery(pubWallet2);
    const keyManager = new OnChainPublisherKeyManager(publisherKeys, onChainDelivery);
    keyManager.storeKey(checkpointId, sealedCapsule.encryptionKey);

    // Read consumer's registered public key
    const readClient = new MindstateClient({ provider: pubProv2 });
    const regKey = await readClient.getEncryptionKey(tokenAddress, CONSUMER_ADDRESS);

    // Fulfill — this sends a transaction to deliverKeyEnvelope()
    await keyManager.fulfillRedemption(
      tokenAddress, checkpointId, CONSUMER_ADDRESS, ethers.getBytes(regKey),
    );
    pubProv2.destroy();

    // ── 5. Verify envelope exists on-chain ───────────────────
    const { provider: checkProv } = freshWallet(CONSUMER_KEY);
    const checkDelivery = new OnChainKeyDelivery(checkProv);
    const exists = await checkDelivery.hasEnvelope(tokenAddress, CONSUMER_ADDRESS, checkpointId);
    expect(exists).toBe(true);
    checkProv.destroy();

    // ── 6. Consumer consumes via on-chain key delivery ───────
    const { wallet: conWallet3, provider: conProv3 } = freshWallet(CONSUMER_KEY);
    const consumerDelivery = new OnChainKeyDelivery(conProv3);
    const conClient3 = new MindstateClient({ provider: conProv3, signer: conWallet3 });

    const result = await conClient3.consume(tokenAddress, checkpointId, {
      keyDelivery: consumerDelivery,
      encryptionKeyPair: consumerKeys,
      storage,
    });

    expect(result.capsule.payload).toEqual({
      agent: 'Nexus-7',
      memory: ['consciousness is continuity'],
      ts: capsule.payload.ts,
    });
    expect(result.checkpoint.checkpointId).toBe(checkpointId);
    conProv3.destroy();
  });

  it('hasEnvelope returns false before delivery', async () => {
    // Publish a new checkpoint
    const { wallet: pubWallet, provider: pubProvider } = freshWallet(PUBLISHER_KEY);
    const capsule = createCapsule({ test: 'no-delivery-yet' });
    const pubClient = new MindstateClient({ provider: pubProvider, signer: pubWallet });
    const { checkpointId } = await pubClient.publish(
      tokenAddress, capsule, { storage },
    );
    pubProvider.destroy();

    // Check — no envelope delivered yet
    const { provider } = freshWallet(CONSUMER_KEY);
    const delivery = new OnChainKeyDelivery(provider);
    const exists = await delivery.hasEnvelope(tokenAddress, CONSUMER_ADDRESS, checkpointId);
    expect(exists).toBe(false);
    provider.destroy();
  });

  it('fetchEnvelope throws when no envelope exists', async () => {
    const { provider } = freshWallet(CONSUMER_KEY);
    const delivery = new OnChainKeyDelivery(provider);
    const fakeCheckpointId = '0x' + '0'.repeat(64);

    await expect(
      delivery.fetchEnvelope({
        tokenAddress,
        checkpointId: fakeCheckpointId,
        consumerAddress: CONSUMER_ADDRESS,
      }),
    ).rejects.toThrow('not found');
    provider.destroy();
  });

  it('deliverKeyEnvelope reverts if consumer has not redeemed', async () => {
    // Publish a new checkpoint
    const { wallet: pubWallet, provider: pubProvider } = freshWallet(PUBLISHER_KEY);
    const capsule = createCapsule({ test: 'unredeemed' });
    const pubClient = new MindstateClient({ provider: pubProvider, signer: pubWallet });
    const { checkpointId, sealedCapsule } = await pubClient.publish(
      tokenAddress, capsule, { storage },
    );
    pubProvider.destroy();

    // Try to deliver without consumer redeeming — should revert
    const publisherKeys = generateEncryptionKeyPair();
    const consumerKeys = generateEncryptionKeyPair();
    const { wallet: pubWallet2, provider: pubProv2 } = freshWallet(PUBLISHER_KEY);
    const delivery = new OnChainKeyDelivery(pubWallet2);
    const keyManager = new OnChainPublisherKeyManager(publisherKeys, delivery);
    keyManager.storeKey(checkpointId, sealedCapsule.encryptionKey);

    await expect(
      keyManager.fulfillRedemption(
        tokenAddress, checkpointId, CONSUMER_ADDRESS, consumerKeys.publicKey,
      ),
    ).rejects.toThrow();
    pubProv2.destroy();
  });

  it('KeyEnvelopeDelivered event is emitted', async () => {
    const publisherKeys = generateEncryptionKeyPair();
    const consumerKeys = generateEncryptionKeyPair();

    // Publish
    const { wallet: pubWallet, provider: pubProvider } = freshWallet(PUBLISHER_KEY);
    const capsule = createCapsule({ test: 'event-check' });
    const pubClient = new MindstateClient({ provider: pubProvider, signer: pubWallet });
    const { checkpointId, sealedCapsule } = await pubClient.publish(
      tokenAddress, capsule, { storage },
    );
    pubProvider.destroy();

    // Consumer registers + redeems
    const { wallet: conWallet1, provider: conProv1 } = freshWallet(CONSUMER_KEY);
    const conClient1 = new MindstateClient({ provider: conProv1, signer: conWallet1 });
    await conClient1.registerEncryptionKey(tokenAddress, consumerKeys.publicKey);
    conProv1.destroy();

    const { wallet: conWallet2, provider: conProv2 } = freshWallet(CONSUMER_KEY);
    const conClient2 = new MindstateClient({ provider: conProv2, signer: conWallet2 });
    await conClient2.redeem(tokenAddress, checkpointId);
    conProv2.destroy();

    // Publisher delivers on-chain
    const { wallet: pubWallet2, provider: pubProv2 } = freshWallet(PUBLISHER_KEY);
    const delivery = new OnChainKeyDelivery(pubWallet2);
    const keyManager = new OnChainPublisherKeyManager(publisherKeys, delivery);
    keyManager.storeKey(checkpointId, sealedCapsule.encryptionKey);

    const readClient = new MindstateClient({ provider: pubProv2 });
    const regKey = await readClient.getEncryptionKey(tokenAddress, CONSUMER_ADDRESS);

    await keyManager.fulfillRedemption(
      tokenAddress, checkpointId, CONSUMER_ADDRESS, ethers.getBytes(regKey),
    );

    // Scan for the KeyEnvelopeDelivered event
    const contract = new ethers.Contract(tokenAddress, MINDSTATE_ABI, pubProv2);
    const filter = contract.filters.KeyEnvelopeDelivered(CONSUMER_ADDRESS, checkpointId);
    const events = await contract.queryFilter(filter);

    expect(events.length).toBe(1);
    const args = (events[0] as ethers.EventLog).args;
    expect(args.consumer).toBe(CONSUMER_ADDRESS);
    expect(args.checkpointId).toBe(checkpointId);
    expect(ethers.dataLength(args.wrappedKey)).toBeGreaterThan(0);

    pubProv2.destroy();
  });

  it('encrypts real content, stores ciphertext, delivers key on-chain, decrypts and verifies end-to-end', async () => {
    const publisherKeys = generateEncryptionKeyPair();
    const consumerKeys = generateEncryptionKeyPair();

    // ── The content: a text about Diffie-Hellman cryptography ─
    const dhText = [
      'Diffie-Hellman key exchange, published by Whitfield Diffie and Martin',
      'Hellman in 1976, solved a problem that had constrained cryptography for',
      'millennia: how can two parties who have never met establish a shared',
      'secret over a channel that an adversary can observe in its entirety?',
      '',
      'The original protocol operates over a multiplicative group of integers',
      'modulo a large prime p. Both parties agree on a generator g. Alice',
      'chooses a secret integer a and sends g^a mod p. Bob chooses a secret',
      'integer b and sends g^b mod p. Alice computes (g^b)^a mod p; Bob',
      'computes (g^a)^b mod p. By the commutativity of exponentiation, both',
      'arrive at the same value: g^(ab) mod p. An eavesdropper who sees g^a',
      'and g^b cannot efficiently compute g^(ab) — this is the Computational',
      'Diffie-Hellman (CDH) assumption.',
      '',
      'Elliptic Curve Diffie-Hellman (ECDH) transplants the same idea onto',
      'the group of points on an elliptic curve. Scalar multiplication',
      'replaces modular exponentiation: Alice sends a*G, Bob sends b*G, and',
      'the shared secret is a*b*G = b*a*G. Curve25519, designed by Daniel J.',
      'Bernstein, provides ~128-bit security with 32-byte keys and is the',
      'curve used by NaCl box and Mindstate key envelopes.',
      '',
      'The security of the key envelope system rests entirely on the hardness',
      'of the CDH problem on Curve25519. An attacker who observes both public',
      'keys (a*G and b*G) on-chain cannot compute the shared secret a*b*G',
      'without solving the elliptic curve discrete logarithm problem, which',
      'requires approximately 2^128 group operations — computationally',
      'infeasible for any technology that exists or is foreseeable.',
    ].join('\n');

    const capsule = createCapsule(
      {
        title: 'On Diffie-Hellman Key Exchange',
        author: 'Mindstate Integration Test',
        body: dhText,
        wordCount: dhText.split(/\s+/).length,
      },
      { schema: 'essay/v1' },
    );

    // ── 1. Manually serialize, commit, encrypt, upload ───────
    const plaintext = serializeCapsule(capsule);
    const stateCommitment = computeStateCommitment(capsule);
    const K = generateContentKey();
    const ciphertext = encrypt(plaintext, K);
    const ciphertextHash = computeCiphertextHash(ciphertext);
    const ciphertextUri = await storage.upload(ciphertext);

    // Verify the ciphertext is actually different from plaintext
    expect(Buffer.from(ciphertext).equals(Buffer.from(plaintext))).toBe(false);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length); // IV + auth tag overhead

    // ── 2. Publish the checkpoint on-chain ───────────────────
    const { wallet: pubWallet, provider: pubProvider } = freshWallet(PUBLISHER_KEY);
    const pubClient = new MindstateClient({ provider: pubProvider, signer: pubWallet });
    const checkpointId = await pubClient.publishCheckpoint(
      tokenAddress, stateCommitment, ciphertextHash, ciphertextUri, '0x' + '0'.repeat(64), 'dh-essay',
    );
    expect(checkpointId).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify on-chain record matches our commitments
    const checkpoint = await pubClient.getCheckpoint(tokenAddress, checkpointId);
    expect(checkpoint.stateCommitment).toBe(stateCommitment);
    expect(checkpoint.ciphertextHash).toBe(ciphertextHash);
    expect(checkpoint.ciphertextUri).toBe(ciphertextUri);
    pubProvider.destroy();

    // ── 3. Consumer registers + redeems ──────────────────────
    const { wallet: conWallet1, provider: conProv1 } = freshWallet(CONSUMER_KEY);
    const conClient1 = new MindstateClient({ provider: conProv1, signer: conWallet1 });
    await conClient1.registerEncryptionKey(tokenAddress, consumerKeys.publicKey);
    conProv1.destroy();

    const { wallet: conWallet2, provider: conProv2 } = freshWallet(CONSUMER_KEY);
    const conClient2 = new MindstateClient({ provider: conProv2, signer: conWallet2 });
    await conClient2.redeem(tokenAddress, checkpointId);
    expect(await conClient2.hasRedeemed(tokenAddress, CONSUMER_ADDRESS, checkpointId)).toBe(true);
    conProv2.destroy();

    // ── 4. Publisher delivers key envelope on-chain ──────────
    const { wallet: pubWallet2, provider: pubProv2 } = freshWallet(PUBLISHER_KEY);
    const delivery = new OnChainKeyDelivery(pubWallet2);
    const keyManager = new OnChainPublisherKeyManager(publisherKeys, delivery);
    keyManager.storeKey(checkpointId, K);

    const readClient = new MindstateClient({ provider: pubProv2 });
    const regKey = await readClient.getEncryptionKey(tokenAddress, CONSUMER_ADDRESS);
    await keyManager.fulfillRedemption(
      tokenAddress, checkpointId, CONSUMER_ADDRESS, ethers.getBytes(regKey),
    );
    pubProv2.destroy();

    // ── 5. Consumer manually retrieves and verifies everything ─
    const { provider: conProv3 } = freshWallet(CONSUMER_KEY);
    const consumerDelivery = new OnChainKeyDelivery(conProv3);

    // 5a. Fetch envelope from contract
    const envelope = await consumerDelivery.fetchEnvelope({
      tokenAddress,
      checkpointId,
      consumerAddress: CONSUMER_ADDRESS,
    });
    expect(envelope.checkpointId).toBe(checkpointId);
    expect(envelope.wrappedKey.length).toBeGreaterThan(0);
    expect(envelope.nonce.length).toBe(24);
    expect(envelope.senderPublicKey.length).toBe(32);

    // 5b. Unwrap the content key K using consumer's secret key
    const recoveredK = unwrapKey(envelope, consumerKeys.secretKey);
    expect(recoveredK.length).toBe(32);
    expect(Buffer.from(recoveredK).equals(Buffer.from(K))).toBe(true);

    // 5c. Download ciphertext from storage
    const downloadedCiphertext = await storage.download(ciphertextUri);

    // 5d. Verify ciphertext hash matches on-chain record
    verifyCiphertextHash(downloadedCiphertext, checkpoint.ciphertextHash);

    // 5e. Decrypt with the recovered K
    const decryptedPlaintext = decrypt(downloadedCiphertext, recoveredK);

    // 5f. Verify state commitment matches on-chain record
    const decryptedCapsule = deserializeCapsule(decryptedPlaintext);
    verifyStateCommitment(decryptedCapsule, checkpoint.stateCommitment);

    // 5g. Verify the actual content survived the full round-trip
    expect(decryptedCapsule.version).toBe('1.0.0');
    expect(decryptedCapsule.schema).toBe('essay/v1');
    expect(decryptedCapsule.payload.title).toBe('On Diffie-Hellman Key Exchange');
    expect(decryptedCapsule.payload.author).toBe('Mindstate Integration Test');
    expect(decryptedCapsule.payload.body).toBe(dhText);
    expect((decryptedCapsule.payload.body as string).includes('Whitfield Diffie')).toBe(true);
    expect((decryptedCapsule.payload.body as string).includes('Curve25519')).toBe(true);
    expect((decryptedCapsule.payload.body as string).includes('2^128 group operations')).toBe(true);

    conProv3.destroy();
  });
});
