// ============================================================================
// @mindstate/sdk — Registry Client (On-Chain Checkpoint Ledger, No Token)
//
// High-level client for MindstateRegistry — the standalone checkpoint ledger
// that provides on-chain commitments and verifiable continuity without an
// ERC-20 token or burn-to-redeem market.
//
//   Tier 2 of the three-tier Mindstate model:
//     SDK-only  →  no chain, no token, out-of-band key sharing
//     Registry  →  on-chain commitments, no token, allowlist access
//     Token     →  on-chain commitments, ERC-20, burn-to-redeem market
// ============================================================================

import { ethers } from 'ethers';
import { serializeCapsule, deserializeCapsule } from './capsule.js';
import { computeCiphertextHash, computeMetadataHash, computeStateCommitment } from './commitment.js';
import { encrypt, decrypt, generateContentKey, unwrapKey } from './encryption.js';
import { verifyCiphertextHash, verifyStateCommitment } from './verify.js';
import { REGISTRY_ABI } from './registryAbi.js';
import { ZERO_BYTES32 } from './abi.js';
import type {
  Capsule,
  CheckpointRecord,
  KeyDeliveryProvider,
  SealedCapsule,
  StorageProvider,
} from './types.js';

// ---------------------------------------------------------------------------
// Types specific to the registry
// ---------------------------------------------------------------------------

/** Access mode for a registry stream. */
export enum RegistryAccessMode {
  /** Anyone can receive key envelopes. */
  Open = 0,
  /** Only publisher-approved readers can receive key envelopes. */
  Allowlist = 1,
}

/** Metadata for a registered stream. */
export interface StreamInfo {
  publisher: string;
  accessMode: RegistryAccessMode;
  head: string;
  checkpointCount: number;
  name: string;
}

// ---------------------------------------------------------------------------
// MindstateRegistryClient
// ---------------------------------------------------------------------------

/**
 * High-level client for interacting with MindstateRegistry contracts.
 *
 * Provides the same publish/consume workflow as {@link MindstateClient} but
 * uses the Registry's stream-based model instead of per-token contracts.
 *
 * Read operations require only a `provider`. Write operations also require
 * a `signer`.
 *
 * @example
 * ```ts
 * import { MindstateRegistryClient, RegistryAccessMode } from '@mindstate/sdk';
 *
 * const client = new MindstateRegistryClient({
 *   registryAddress: '0x...',
 *   provider,
 *   signer,
 * });
 *
 * // Create a stream
 * const streamId = await client.createStream('My Agent State', RegistryAccessMode.Allowlist);
 *
 * // Publish a capsule
 * const { checkpointId, sealedCapsule } = await client.publish(streamId, capsule, { storage });
 * ```
 */
export class MindstateRegistryClient {
  private readonly provider: ethers.Provider;
  private readonly signer?: ethers.Signer;
  private readonly registryAddress: string;

  constructor(config: {
    registryAddress: string;
    provider: ethers.Provider;
    signer?: ethers.Signer;
  }) {
    if (!config.provider) throw new Error('Mindstate: a provider is required');
    if (!config.registryAddress) throw new Error('Mindstate: registryAddress is required');
    this.provider = config.provider;
    this.signer = config.signer;
    this.registryAddress = config.registryAddress;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private readContract(): ethers.Contract {
    return new ethers.Contract(this.registryAddress, REGISTRY_ABI, this.provider);
  }

  private writeContract(): ethers.Contract {
    if (!this.signer) throw new Error('Mindstate: a signer is required for write operations');
    return new ethers.Contract(this.registryAddress, REGISTRY_ABI, this.signer);
  }

  // -----------------------------------------------------------------------
  // Stream management
  // -----------------------------------------------------------------------

  /**
   * Create a new checkpoint stream. The caller becomes the publisher.
   *
   * @param name       - Human-readable stream name.
   * @param accessMode - Open or Allowlist.
   * @returns The deterministic stream ID.
   */
  async createStream(name: string, accessMode: RegistryAccessMode): Promise<string> {
    const contract = this.writeContract();
    const tx = await contract.createStream(name, accessMode);
    const receipt: ethers.TransactionReceipt = await tx.wait();
    if (!receipt) throw new Error('Mindstate: createStream transaction failed');

    const iface = new ethers.Interface(REGISTRY_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed && parsed.name === 'StreamCreated') {
          return parsed.args.streamId as string;
        }
      } catch { /* not our event */ }
    }
    throw new Error('Mindstate: StreamCreated event not found in receipt');
  }

  async getStream(streamId: string): Promise<StreamInfo> {
    const s = await this.readContract().getStream(streamId);
    return {
      publisher: s.publisher,
      accessMode: Number(s.accessMode) as RegistryAccessMode,
      head: s.head,
      checkpointCount: Number(s.checkpointCount),
      name: s.name,
    };
  }

  async getStreamCount(): Promise<number> {
    return Number(await this.readContract().streamCount());
  }

  async getPublisherStreams(publisher: string): Promise<string[]> {
    return this.readContract().getPublisherStreams(publisher) as Promise<string[]>;
  }

  async transferPublisher(streamId: string, newPublisher: string): Promise<void> {
    const tx = await this.writeContract().transferPublisher(streamId, newPublisher);
    await tx.wait();
  }

  // -----------------------------------------------------------------------
  // Checkpoint chain reads
  // -----------------------------------------------------------------------

  async getHead(streamId: string): Promise<string> {
    return this.readContract().head(streamId) as Promise<string>;
  }

  async getCheckpointCount(streamId: string): Promise<number> {
    return Number(await this.readContract().checkpointCount(streamId));
  }

  async getCheckpoint(streamId: string, checkpointId: string): Promise<CheckpointRecord> {
    const cp = await this.readContract().getCheckpoint(streamId, checkpointId);
    return {
      checkpointId,
      predecessorId: cp.predecessorId,
      stateCommitment: cp.stateCommitment,
      ciphertextHash: cp.ciphertextHash,
      ciphertextUri: cp.ciphertextUri,
      manifestHash: cp.manifestHash,
      publishedAt: Number(cp.publishedAt),
      blockNumber: Number(cp.blockNumber),
    };
  }

  async getCheckpointIdAtIndex(streamId: string, index: number): Promise<string> {
    return this.readContract().getCheckpointIdAtIndex(streamId, index) as Promise<string>;
  }

  /**
   * Returns the full timeline (oldest first) for a stream.
   */
  async getTimeline(streamId: string): Promise<CheckpointRecord[]> {
    const count = await this.getCheckpointCount(streamId);
    const timeline: CheckpointRecord[] = [];
    for (let i = 0; i < count; i++) {
      const id = await this.getCheckpointIdAtIndex(streamId, i);
      timeline.push(await this.getCheckpoint(streamId, id));
    }
    return timeline;
  }

  // -----------------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------------

  async publishCheckpoint(
    streamId: string,
    stateCommitment: string,
    ciphertextHash: string,
    ciphertextUri: string,
    manifestHash: string,
    label: string = '',
  ): Promise<string> {
    const contract = this.writeContract();
    const tx = await contract.publish(
      streamId, stateCommitment, ciphertextHash, ciphertextUri, manifestHash, label,
    );
    const receipt: ethers.TransactionReceipt = await tx.wait();
    if (!receipt) throw new Error('Mindstate: publish transaction failed');

    const iface = new ethers.Interface(REGISTRY_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed && parsed.name === 'CheckpointPublished') {
          return parsed.args.checkpointId as string;
        }
      } catch { /* not our event */ }
    }
    throw new Error('Mindstate: CheckpointPublished event not found in receipt');
  }

  /**
   * Full publish flow: serialize, encrypt, upload, publish on-chain.
   *
   * Same workflow as `MindstateClient.publish()` but targeting the registry.
   */
  async publish(
    streamId: string,
    capsule: Capsule,
    options: {
      storage: StorageProvider;
      metadata?: unknown;
      label?: string;
    },
  ): Promise<{ checkpointId: string; sealedCapsule: SealedCapsule }> {
    const { storage, metadata, label } = options;

    const plaintext = serializeCapsule(capsule);
    const stateCommitment = computeStateCommitment(capsule);
    const metadataHash = metadata ? computeMetadataHash(metadata) : ZERO_BYTES32;

    const encryptionKey = generateContentKey();
    const ciphertext = encrypt(plaintext, encryptionKey);
    const contentHash = computeCiphertextHash(ciphertext);
    const ciphertextUri = await storage.upload(ciphertext);

    const checkpointId = await this.publishCheckpoint(
      streamId, stateCommitment, contentHash, ciphertextUri, metadataHash, label ?? '',
    );

    return {
      checkpointId,
      sealedCapsule: { ciphertext, contentHash, stateCommitment, metadataHash, encryptionKey },
    };
  }

  // -----------------------------------------------------------------------
  // Consuming
  // -----------------------------------------------------------------------

  /**
   * Consume a checkpoint: download ciphertext, unwrap key, decrypt, verify.
   *
   * Unlike the token-based `MindstateClient.consume()`, there is no burn step.
   * Access is controlled by the publisher's allowlist (or open access).
   */
  async consume(
    streamId: string,
    checkpointId: string,
    options: {
      keyDelivery: KeyDeliveryProvider;
      encryptionKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
      storage: StorageProvider;
    },
  ): Promise<{ capsule: Capsule; checkpoint: CheckpointRecord }> {
    const { keyDelivery, encryptionKeyPair, storage } = options;

    const signerAddress = this.signer ? await this.signer.getAddress() : undefined;
    if (!signerAddress) throw new Error('Mindstate: a signer is required to consume');

    const envelope = await keyDelivery.fetchEnvelope({
      tokenAddress: this.registryAddress,
      checkpointId,
      consumerAddress: signerAddress,
    });

    const checkpoint = await this.getCheckpoint(streamId, checkpointId);
    const ciphertext = await storage.download(checkpoint.ciphertextUri);

    verifyCiphertextHash(ciphertext, checkpoint.ciphertextHash);

    const contentKey = unwrapKey(envelope, encryptionKeyPair.secretKey);
    const plaintext = decrypt(ciphertext, contentKey);
    const capsule = deserializeCapsule(plaintext);

    verifyStateCommitment(capsule, checkpoint.stateCommitment);

    return { capsule, checkpoint };
  }

  // -----------------------------------------------------------------------
  // Storage migration
  // -----------------------------------------------------------------------

  async updateCiphertextUri(
    streamId: string,
    checkpointId: string,
    newUri: string,
  ): Promise<void> {
    const tx = await this.writeContract().updateCiphertextUri(streamId, checkpointId, newUri);
    await tx.wait();
  }

  // -----------------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------------

  async tagCheckpoint(streamId: string, checkpointId: string, tag: string): Promise<void> {
    const tx = await this.writeContract().tagCheckpoint(streamId, checkpointId, tag);
    await tx.wait();
  }

  async resolveTag(streamId: string, tag: string): Promise<string> {
    return this.readContract().resolveTag(streamId, tag) as Promise<string>;
  }

  async getCheckpointTag(streamId: string, checkpointId: string): Promise<string> {
    return this.readContract().getCheckpointTag(streamId, checkpointId) as Promise<string>;
  }

  // -----------------------------------------------------------------------
  // Access control
  // -----------------------------------------------------------------------

  async addReader(streamId: string, reader: string): Promise<void> {
    const tx = await this.writeContract().addReader(streamId, reader);
    await tx.wait();
  }

  async removeReader(streamId: string, reader: string): Promise<void> {
    const tx = await this.writeContract().removeReader(streamId, reader);
    await tx.wait();
  }

  async addReaders(streamId: string, readers: string[]): Promise<void> {
    const tx = await this.writeContract().addReaders(streamId, readers);
    await tx.wait();
  }

  async isReader(streamId: string, account: string): Promise<boolean> {
    return this.readContract().isReader(streamId, account) as Promise<boolean>;
  }

  // -----------------------------------------------------------------------
  // Encryption key registry
  // -----------------------------------------------------------------------

  async registerEncryptionKey(publicKey: Uint8Array): Promise<void> {
    if (publicKey.length !== 32) {
      throw new Error(`Mindstate: encryption public key must be 32 bytes, got ${publicKey.length}`);
    }
    const tx = await this.writeContract().registerEncryptionKey(ethers.hexlify(publicKey));
    await tx.wait();
  }

  async getEncryptionKey(account: string): Promise<string> {
    return this.readContract().getEncryptionKey(account) as Promise<string>;
  }

  // -----------------------------------------------------------------------
  // On-chain key envelope delivery
  // -----------------------------------------------------------------------

  async deliverKeyEnvelope(
    streamId: string,
    consumer: string,
    checkpointId: string,
    wrappedKey: Uint8Array,
    nonce: Uint8Array,
    senderPublicKey: Uint8Array,
  ): Promise<void> {
    const nonceHex = '0x' + Buffer.from(nonce).toString('hex');
    const tx = await this.writeContract().deliverKeyEnvelope(
      streamId, consumer, checkpointId,
      wrappedKey, nonceHex, ethers.hexlify(senderPublicKey),
    );
    await tx.wait();
  }

  async hasKeyEnvelope(
    streamId: string,
    consumer: string,
    checkpointId: string,
  ): Promise<boolean> {
    return this.readContract().hasKeyEnvelope(streamId, consumer, checkpointId) as Promise<boolean>;
  }
}
