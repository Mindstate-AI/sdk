// ============================================================================
// @mindstate/sdk — On-Chain Client (ethers v6)
// ============================================================================

import { ethers } from 'ethers';
import { serializeCapsule, deserializeCapsule } from './capsule.js';
import { computeCiphertextHash, computeMetadataHash, computeStateCommitment } from './commitment.js';
import { encrypt, decrypt, generateContentKey, unwrapKey } from './encryption.js';
import { verifyCiphertextHash, verifyStateCommitment } from './verify.js';
import { MINDSTATE_ABI, ZERO_BYTES32 } from './abi.js';
import type {
  Capsule,
  CheckpointRecord,
  KeyDeliveryProvider,
  MindstateConfig,
  SealedCapsule,
  StorageProvider,
} from './types.js';
import { RedeemMode } from './types.js';
import type { TierPolicy, TierContext } from './tierPolicy.js';
import { StorageTier } from './tierPolicy.js';

// ---------------------------------------------------------------------------
// MindstateClient
// ---------------------------------------------------------------------------

/**
 * High-level client for interacting with MindstateToken contracts.
 *
 * Read operations require only a `provider`. Write operations (publishing,
 * registering keys) also require a `signer`.
 */
export class MindstateClient {
  private readonly provider: ethers.Provider;
  private readonly signer?: ethers.Signer;

  constructor(config: MindstateConfig) {
    if (!config.provider) {
      throw new Error('Mindstate: a provider is required');
    }
    this.provider = config.provider;
    this.signer = config.signer;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private readContract(tokenAddress: string): ethers.Contract {
    return new ethers.Contract(tokenAddress, MINDSTATE_ABI, this.provider);
  }

  private writeContract(tokenAddress: string): ethers.Contract {
    if (!this.signer) {
      throw new Error('Mindstate: a signer is required for write operations');
    }
    return new ethers.Contract(tokenAddress, MINDSTATE_ABI, this.signer);
  }

  // -----------------------------------------------------------------------
  // Read operations
  // -----------------------------------------------------------------------

  async getHead(tokenAddress: string): Promise<string> {
    return this.readContract(tokenAddress).head() as Promise<string>;
  }

  async getCheckpoint(tokenAddress: string, checkpointId: string): Promise<CheckpointRecord> {
    const cp = await this.readContract(tokenAddress).getCheckpoint(checkpointId);
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

  async getCheckpointCount(tokenAddress: string): Promise<number> {
    const count: bigint = await this.readContract(tokenAddress).checkpointCount();
    return Number(count);
  }

  async getRedeemMode(tokenAddress: string): Promise<RedeemMode> {
    const mode: bigint = await this.readContract(tokenAddress).redeemMode();
    return Number(mode) as RedeemMode;
  }

  async getRedeemCost(tokenAddress: string): Promise<bigint> {
    return this.readContract(tokenAddress).redeemCost() as Promise<bigint>;
  }

  async hasRedeemed(tokenAddress: string, account: string, checkpointId: string): Promise<boolean> {
    return this.readContract(tokenAddress).hasRedeemed(account, checkpointId) as Promise<boolean>;
  }

  async getEncryptionKey(tokenAddress: string, account: string): Promise<string> {
    return this.readContract(tokenAddress).getEncryptionKey(account) as Promise<string>;
  }

  async getPublisher(tokenAddress: string): Promise<string> {
    return this.readContract(tokenAddress).publisher() as Promise<string>;
  }

  // -----------------------------------------------------------------------
  // Write operations
  // -----------------------------------------------------------------------

  async publishCheckpoint(
    tokenAddress: string,
    stateCommitment: string,
    ciphertextHash: string,
    ciphertextUri: string,
    manifestHash: string,
    label: string = '',
  ): Promise<string> {
    const contract = this.writeContract(tokenAddress);
    const tx = await contract.publish(stateCommitment, ciphertextHash, ciphertextUri, manifestHash, label);
    const receipt: ethers.TransactionReceipt = await tx.wait();

    if (!receipt) {
      throw new Error('Mindstate: publish transaction failed — no receipt');
    }

    const iface = new ethers.Interface(MINDSTATE_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed && parsed.name === 'CheckpointPublished') {
          return parsed.args.checkpointId as string;
        }
      } catch { /* not our event */ }
    }

    throw new Error('Mindstate: CheckpointPublished event not found in transaction receipt');
  }

  async registerEncryptionKey(tokenAddress: string, publicKey: Uint8Array): Promise<void> {
    if (publicKey.length !== 32) {
      throw new Error(`Mindstate: encryption public key must be 32 bytes, got ${publicKey.length}`);
    }
    const contract = this.writeContract(tokenAddress);
    const tx = await contract.registerEncryptionKey(ethers.hexlify(publicKey));
    await tx.wait();
  }

  async redeem(tokenAddress: string, checkpointId: string): Promise<void> {
    const contract = this.writeContract(tokenAddress);
    const tx = await contract.redeem(checkpointId);
    await tx.wait();
  }

  // -----------------------------------------------------------------------
  // Storage Migration
  // -----------------------------------------------------------------------

  /**
   * Update the ciphertext URI for an existing checkpoint.
   *
   * Used when migrating data between storage backends (e.g. IPFS → Arweave).
   * The checkpoint ID is unaffected — it is derived from content hashes, not
   * the storage URI.
   *
   * @param tokenAddress      - Address of the MindstateToken contract.
   * @param checkpointId      - The checkpoint whose URI to update.
   * @param newCiphertextUri  - The new storage URI (e.g. "ar://...", "fil://...").
   */
  async updateCiphertextUri(
    tokenAddress: string,
    checkpointId: string,
    newCiphertextUri: string,
  ): Promise<void> {
    const contract = this.writeContract(tokenAddress);
    const tx = await contract.updateCiphertextUri(checkpointId, newCiphertextUri);
    await tx.wait();
  }

  // -----------------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------------

  async tagCheckpoint(tokenAddress: string, checkpointId: string, tag: string): Promise<void> {
    const contract = this.writeContract(tokenAddress);
    const tx = await contract.tagCheckpoint(checkpointId, tag);
    await tx.wait();
  }

  async resolveTag(tokenAddress: string, tag: string): Promise<string> {
    return this.readContract(tokenAddress).resolveTag(tag) as Promise<string>;
  }

  async getCheckpointTag(tokenAddress: string, checkpointId: string): Promise<string> {
    return this.readContract(tokenAddress).getCheckpointTag(checkpointId) as Promise<string>;
  }

  // -----------------------------------------------------------------------
  // High-level convenience: publish
  // -----------------------------------------------------------------------

  /**
   * Full publish flow: serialize → commit → encrypt → upload → publish on-chain.
   *
   * Supports optional tier-aware storage: if a `tierPolicy` and `tierProviders`
   * map are provided, the policy determines which storage backend to use based
   * on the publication context (label, tags, checkpoint index, etc.). If not
   * provided, the single `storage` provider is used — preserving backward
   * compatibility (default: IPFS).
   *
   * @returns The checkpoint ID, sealed capsule (including the symmetric key
   *          K that the publisher must store via a PublisherKeyManager), and
   *          the resolved storage tier (if tier policy was used).
   */
  async publish(
    tokenAddress: string,
    capsule: Capsule,
    options: {
      storage: StorageProvider;
      metadata?: unknown;
      label?: string;
      /** Optional tier policy for automatic storage tier selection. */
      tierPolicy?: TierPolicy;
      /** Storage providers for each tier. Falls back to `storage` if a tier's provider is missing. */
      tierProviders?: Partial<Record<StorageTier, StorageProvider>>;
      /** Extra context for tier policy resolution (e.g. isGenesis, tags). */
      tierContext?: Partial<TierContext>;
    },
  ): Promise<{ checkpointId: string; sealedCapsule: SealedCapsule; tier?: StorageTier }> {
    const { storage, metadata, label, tierPolicy, tierProviders, tierContext } = options;

    const plaintext = serializeCapsule(capsule);
    const stateCommitment = computeStateCommitment(capsule);
    const metadataHash = metadata ? computeMetadataHash(metadata) : ZERO_BYTES32;

    const encryptionKey = generateContentKey();
    const ciphertext = encrypt(plaintext, encryptionKey);
    const contentHash = computeCiphertextHash(ciphertext);

    // Resolve storage tier and provider
    let resolvedTier: StorageTier | undefined;
    let uploadProvider = storage;

    if (tierPolicy) {
      const context: TierContext = {
        label: label ?? undefined,
        ...tierContext,
      };
      resolvedTier = tierPolicy.resolveTier(context);

      if (tierProviders && tierProviders[resolvedTier]) {
        uploadProvider = tierProviders[resolvedTier]!;
      }
    }

    const ciphertextUri = await uploadProvider.upload(ciphertext);

    const checkpointId = await this.publishCheckpoint(
      tokenAddress, stateCommitment, contentHash, ciphertextUri, metadataHash, label ?? '',
    );

    return {
      checkpointId,
      sealedCapsule: { ciphertext, contentHash, stateCommitment, metadataHash, encryptionKey },
      tier: resolvedTier,
    };
  }

  // -----------------------------------------------------------------------
  // High-level convenience: consume
  // -----------------------------------------------------------------------

  /**
   * Full consume flow: fetch envelope → verify availability → redeem (burn
   * tokens) → download ciphertext → unwrap key → decrypt → verify.
   *
   * **Important:** The method verifies that the key envelope is available
   * BEFORE burning tokens, preventing the consumer from losing tokens when
   * the publisher hasn't fulfilled the redemption yet.
   *
   * If the consumer has already redeemed, the burn step is skipped.
   */
  async consume(
    tokenAddress: string,
    checkpointId: string,
    options: {
      keyDelivery: KeyDeliveryProvider;
      encryptionKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
      storage: StorageProvider;
    },
  ): Promise<{ capsule: Capsule; checkpoint: CheckpointRecord }> {
    const { keyDelivery, encryptionKeyPair, storage } = options;

    const signerAddress = this.signer
      ? await (this.signer as ethers.Signer).getAddress()
      : undefined;

    if (!signerAddress) {
      throw new Error('Mindstate: a signer is required to consume checkpoints (needed for redemption)');
    }

    // 1. Check redemption status and fetch key envelope
    const alreadyRedeemed = await this.hasRedeemed(tokenAddress, signerAddress, checkpointId);
    let keyEnvelope;

    if (!alreadyRedeemed) {
      // 2. Pre-flight: verify the key envelope is available BEFORE burning tokens
      try {
        keyEnvelope = await keyDelivery.fetchEnvelope({ tokenAddress, checkpointId, consumerAddress: signerAddress });
      } catch {
        throw new Error(
          'Mindstate: key envelope is not yet available for this checkpoint. ' +
          'The publisher may not have fulfilled this redemption yet. ' +
          'Call redeem() manually after confirming with the publisher, or wait and retry.',
        );
      }

      // 3. Burn tokens (envelope confirmed available)
      await this.redeem(tokenAddress, checkpointId);
    } else {
      // Already redeemed — fetch envelope directly
      keyEnvelope = await keyDelivery.fetchEnvelope({
        tokenAddress, checkpointId, consumerAddress: signerAddress,
      });
    }

    // 4. Fetch on-chain checkpoint metadata
    const checkpoint = await this.getCheckpoint(tokenAddress, checkpointId);

    // 5. Download ciphertext from storage
    const ciphertext = await storage.download(checkpoint.ciphertextUri);

    // 6. Verify ciphertext hash
    verifyCiphertextHash(ciphertext, checkpoint.ciphertextHash);

    // 7. Unwrap the content key (envelope already fetched above)
    const contentKey = unwrapKey(keyEnvelope, encryptionKeyPair.secretKey);

    // 9. Decrypt
    const plaintext = decrypt(ciphertext, contentKey);

    // 10. Deserialize
    const capsule = deserializeCapsule(plaintext);

    // 11. Verify state commitment
    verifyStateCommitment(capsule, checkpoint.stateCommitment);

    return { capsule, checkpoint };
  }
}
