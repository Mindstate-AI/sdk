# @mindstate/sdk

[![npm version](https://img.shields.io/npm/v/@mindstate/sdk)](https://www.npmjs.com/package/@mindstate/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@mindstate/sdk)](https://www.npmjs.com/package/@mindstate/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/@mindstate/sdk)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![GitHub stars](https://img.shields.io/github/stars/Mindstate-AI/sdk)](https://github.com/Mindstate-AI/sdk)

TypeScript SDK for the **Mindstate protocol** — publish, consume, and verify encrypted AI state on Ethereum.

Mindstate lets AI agents (or any publisher) commit versioned, encrypted state snapshots ("capsules") on-chain as ERC-20 tokens. Consumers burn tokens to redeem access to decrypted state. The protocol is schema-agnostic: capsules can hold agent identity, model weights, conversation logs, memory, or anything else.

## Install

```bash
npm install @mindstate/sdk
```

Peer dependency: the SDK uses [ethers v6](https://docs.ethers.org/v6/) for on-chain interactions.

```bash
npm install ethers
```

## Quick Start

### 1. Create a client

```ts
import { ethers } from 'ethers';
import { MindstateClient } from '@mindstate/sdk';

const provider = new ethers.JsonRpcProvider('https://...');
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const client = new MindstateClient({ provider, signer });
```

### 2. Build a capsule

Capsules are schema-agnostic — put whatever you want in the payload:

```ts
import { createCapsule } from '@mindstate/sdk';

const capsule = createCapsule(
  { model: 'gpt-4o', memory: ['...'], preferences: { theme: 'dark' } },
  { schema: 'my-app/v1' },
);
```

Or use the built-in **agent/v1** schema for AI agent state:

```ts
import { createAgentCapsule } from '@mindstate/sdk';

const capsule = createAgentCapsule({
  identityKernel: { id: '0x...', constraints: { purpose: 'assistant' } },
  executionManifest: {
    modelId: 'gpt-4o',
    modelVersion: '2025-01-01',
    toolVersions: { web: '1.0.0' },
    determinismParams: { temperature: 0.7 },
    environment: { runtime: 'node' },
    timestamp: new Date().toISOString(),
  },
});
```

### 3. Publish

```ts
import { IpfsStorage } from '@mindstate/sdk';

const storage = new IpfsStorage({ gateway: 'https://ipfs.io' });

const { checkpointId, sealedCapsule } = await client.publish(
  TOKEN_ADDRESS,
  capsule,
  { storage },
);

console.log('Published checkpoint:', checkpointId);
// sealedCapsule.encryptionKey is the symmetric key K — store it securely!
```

### 4. Consume (as a token holder)

```ts
import {
  MindstateClient,
  StorageKeyDelivery,
  generateEncryptionKeyPair,
  IpfsStorage,
} from '@mindstate/sdk';

const keyPair = generateEncryptionKeyPair();
const storage = new IpfsStorage({ gateway: 'https://ipfs.io' });
const keyDelivery = new StorageKeyDelivery(storage);

// Load the publisher's key index
await keyDelivery.loadIndex(INDEX_URI);

// Register your encryption key on-chain (once)
await client.registerEncryptionKey(TOKEN_ADDRESS, keyPair.publicKey);

// Consume — burns tokens, downloads, decrypts, and verifies
const { capsule, checkpoint } = await client.consume(
  TOKEN_ADDRESS,
  checkpointId,
  { keyDelivery, encryptionKeyPair: keyPair, storage },
);

console.log('Decrypted capsule:', capsule.payload);
```

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Capsule** | A versioned, schema-agnostic container holding arbitrary state. |
| **Checkpoint** | An on-chain record linking a state commitment to encrypted storage. |
| **State Commitment** | `keccak256(canonicalize(capsule))` — binds the capsule to the chain. |
| **Sealed Capsule** | The result of encrypting a capsule (AES-256-GCM). |
| **Key Envelope** | A content key K wrapped for a specific consumer via NaCl box (X25519 ECDH + XSalsa20-Poly1305). Safe to store anywhere — on IPFS, on-chain, or in transit. |
| **Key Delivery** | The transport mechanism for envelopes. Off-chain (IPFS/Arweave) or on-chain (`deliverKeyEnvelope()`). Both implement `KeyDeliveryProvider`. |
| **Redeem** | Burn tokens to gain access to a checkpoint's decryption key. |

## API Reference

### Classes

#### `MindstateClient`

High-level client for interacting with MindstateToken contracts.

| Method | Description |
|--------|-------------|
| `publish(tokenAddress, capsule, options)` | Full flow: serialize, encrypt, upload, publish on-chain. |
| `consume(tokenAddress, checkpointId, options)` | Full flow: redeem, download, decrypt, verify. |
| `publishCheckpoint(...)` | Low-level: publish a pre-sealed checkpoint on-chain. |
| `redeem(tokenAddress, checkpointId)` | Burn tokens to redeem a checkpoint. |
| `registerEncryptionKey(tokenAddress, publicKey)` | Register an X25519 public key on-chain. |
| `tagCheckpoint(tokenAddress, checkpointId, tag)` | Tag a checkpoint (e.g. `"stable"`). |
| `resolveTag(tokenAddress, tag)` | Resolve a tag to a checkpoint ID. |
| `updateCiphertextUri(tokenAddress, checkpointId, uri)` | Migrate storage URI (e.g. IPFS to Arweave). |
| `getHead(tokenAddress)` | Get the latest checkpoint ID. |
| `getCheckpoint(tokenAddress, checkpointId)` | Get a checkpoint record. |
| `getCheckpointCount(tokenAddress)` | Get total checkpoint count. |
| `hasRedeemed(tokenAddress, account, checkpointId)` | Check if an account has redeemed. |

#### `MindstateExplorer`

Read-only utility for browsing checkpoint history (no signer needed).

| Method | Description |
|--------|-------------|
| `getTimeline(tokenAddress)` | Full checkpoint history (oldest first). |
| `getRecent(tokenAddress, count)` | N most recent checkpoints (newest first). |
| `getLineage(tokenAddress, checkpointId)` | Walk predecessor chain back to genesis. |
| `resolveTag(tokenAddress, tag)` | Resolve a tag to a full checkpoint record. |
| `getAllTags(tokenAddress)` | Scan all tag assignments. |
| `getEnrichedTimeline(tokenAddress, options)` | Timeline with on-chain tags and off-chain descriptions. |

#### `PublisherKeyManager`

Publisher-side key management for **off-chain** delivery — stores symmetric keys, wraps them via NaCl box, and uploads envelopes to a `StorageProvider`.

#### `StorageKeyDelivery`

**Off-chain** key delivery via any `StorageProvider` (IPFS, Arweave, S3). Publishers upload wrapped key envelopes; consumers download them by loading the publisher's index URI. Implements `KeyDeliveryProvider`.

#### `OnChainKeyDelivery`

**On-chain** key delivery via the MindstateToken contract. Publishers deliver envelopes by calling `deliverKeyEnvelope()` on the contract; consumers read them directly from contract state via `getKeyEnvelope()`. No index URI, no external storage needed. Implements `KeyDeliveryProvider`. **Recommended on L2s like Base** where gas is negligible.

| Method | Description |
|--------|-------------|
| `storeEnvelope(params)` | Deliver envelope on-chain (sends a transaction). |
| `fetchEnvelope(params)` | Read envelope from contract state (free, no gas). |
| `hasEnvelope(tokenAddress, consumer, checkpointId)` | Check if an on-chain envelope exists (free). |

#### `OnChainPublisherKeyManager`

Publisher-side key management for **on-chain** delivery — same API as `PublisherKeyManager`, but delivers envelopes via the contract instead of IPFS. Drop-in replacement.

#### `StorageRouter`

Multi-backend storage router — auto-routes downloads by URI scheme (`ipfs://`, `ar://`, `fil://`).

### Storage Providers

| Class | Backend | Description |
|-------|---------|-------------|
| `IpfsStorage` | IPFS | Upload via HTTP API, download via gateway. |
| `ArweaveStorage` | Arweave | Permanent storage (coming soon). |
| `FilecoinStorage` | Filecoin | Deal-based storage (coming soon). |

Implement the `StorageProvider` interface for custom backends:

```ts
interface StorageProvider {
  upload(data: Uint8Array): Promise<string>;
  download(uri: string): Promise<Uint8Array>;
}
```

### Tier Policies

| Class | Behavior |
|-------|----------|
| `DefaultTierPolicy` | Everything goes to hot tier (IPFS). |
| `PromotionTierPolicy` | Auto-promotes to warm/cold based on labels and tags. |

### Standalone Functions

#### Capsule Construction

- `createCapsule(payload, options?)` — Create a generic capsule.
- `createAgentCapsule(params)` — Create an agent/v1 capsule.
- `serializeCapsule(capsule)` — Deterministic canonical JSON serialization.
- `deserializeCapsule(bytes)` — Deserialize and validate a capsule.

#### Encryption

- `generateContentKey()` — Generate a 32-byte AES-256-GCM key.
- `encrypt(plaintext, key)` — AES-256-GCM encryption.
- `decrypt(sealed, key)` — AES-256-GCM decryption.
- `generateEncryptionKeyPair()` — Generate an X25519 key pair.
- `wrapKey(contentKey, recipientPublicKey, senderSecretKey)` — Wrap a key via NaCl box.
- `unwrapKey(envelope, recipientSecretKey)` — Unwrap a key envelope.

#### Commitments

- `computeStateCommitment(capsule)` — `keccak256(canonicalize(capsule))`.
- `computeCiphertextHash(ciphertext)` — `keccak256(ciphertext)`.
- `computeMetadataHash(value)` — `keccak256(canonicalize(value))`.

#### Verification

- `verifyStateCommitment(capsule, expected)` — Verify a state commitment.
- `verifyCiphertextHash(ciphertext, expected)` — Verify a ciphertext hash.
- `verifyCheckpointLineage(checkpoints)` — Verify linked-list integrity.
- `verifyAndDecrypt(ciphertext, key, commitment, hash)` — Full verify + decrypt flow.

## Key Delivery

The SDK provides two `KeyDeliveryProvider` implementations. Both produce identical NaCl box encrypted envelopes — only the transport differs.

### Off-chain delivery (IPFS / Arweave)

```ts
import {
  StorageKeyDelivery, PublisherKeyManager, IpfsStorage,
} from '@mindstate/sdk';

const storage = new IpfsStorage({ gateway: 'https://ipfs.io' });
const delivery = new StorageKeyDelivery(storage);
const keyManager = new PublisherKeyManager(publisherKeys, delivery);

// Publisher: wrap K and upload envelope
await keyManager.fulfillRedemption(tokenAddress, checkpointId, consumer, pubKey);
const indexUri = await delivery.publishIndex(); // share this with consumers

// Consumer: load index, fetch envelope
const consumerDelivery = new StorageKeyDelivery(storage);
await consumerDelivery.loadIndex(indexUri);
const envelope = await consumerDelivery.fetchEnvelope({ tokenAddress, checkpointId, consumerAddress });
```

### On-chain delivery (recommended on Base / L2s)

```ts
import {
  OnChainKeyDelivery, OnChainPublisherKeyManager,
} from '@mindstate/sdk';

// Publisher: wrap K and deliver via contract transaction
const delivery = new OnChainKeyDelivery(signer);
const keyManager = new OnChainPublisherKeyManager(publisherKeys, delivery);
await keyManager.fulfillRedemption(tokenAddress, checkpointId, consumer, pubKey);

// Consumer: read from contract (free, no gas, no index URI)
const consumerDelivery = new OnChainKeyDelivery(provider);
const envelope = await consumerDelivery.fetchEnvelope({ tokenAddress, checkpointId, consumerAddress });
```

### Security

Key envelopes are encrypted with NaCl box (X25519 ECDH + XSalsa20-Poly1305). The wrapped key is indistinguishable from random noise to anyone who does not hold the consumer's X25519 private key. Envelopes are safe to store on IPFS, on-chain, or anywhere else — the security guarantee comes from the encryption, not the transport.

An attacker who reads the envelope (from IPFS or from on-chain state) sees: the wrapped key (encrypted), a random nonce, and the sender's public key. To decrypt, they would need to compute an ECDH shared secret, which requires either the consumer's or publisher's X25519 private key. Neither is ever stored on-chain or transmitted.

## Storage Architecture

Mindstate supports a three-tier storage model:

| Tier | Backend | Use Case | Cost |
|------|---------|----------|------|
| **Hot** | IPFS | Active development, recent checkpoints | Infrastructure only |
| **Warm** | Filecoin | Production snapshots, compliance archives | ~$0.001/GB/mo |
| **Cold** | Arweave | Canonical releases, genesis states | ~$8/GB one-time |

Use `PromotionTierPolicy` for automatic tier selection, or implement the `TierPolicy` interface for custom logic.

## Deployed Contracts (Base Mainnet)

The protocol is live on [Base](https://base.org) (chain ID 8453).

```ts
import { DEPLOYMENTS } from '@mindstate/sdk';
const { factory, vault, implementation } = DEPLOYMENTS[8453];
```

| Contract | Address |
|----------|---------|
| **MindstateLaunchFactory** | [`0x866B4b99be3847a9ed6Db6ce0a02946B839b735A`](https://basescan.org/address/0x866B4b99be3847a9ed6Db6ce0a02946B839b735A) |
| **MindstateVault** | [`0xC5B2Dc478e75188a454e33E89bc4F768c7079068`](https://basescan.org/address/0xC5B2Dc478e75188a454e33E89bc4F768c7079068) |
| **FeeCollector** | [`0x19175b230dfFAb8da216Ae29f9596Ac349755D16`](https://basescan.org/address/0x19175b230dfFAb8da216Ae29f9596Ac349755D16) |
| **MindstateToken** (impl) | [`0x69511A29958867A96D28a15b3Ac614D1e8A4c47B`](https://basescan.org/address/0x69511A29958867A96D28a15b3Ac614D1e8A4c47B) |
| **MindstateFactory** | [`0x8c67b8ff38f4F497c8796AC28547FE93D1Ce1C97`](https://basescan.org/address/0x8c67b8ff38f4F497c8796AC28547FE93D1Ce1C97) |

## Community

- [Website](https://mindstate.dev)
- [Twitter](https://x.com/mindstatecoin)
- [Telegram](https://t.me/mindstatedev)
- [GitHub](https://github.com/Mindstate-AI)

## License

[MIT](./LICENSE)
