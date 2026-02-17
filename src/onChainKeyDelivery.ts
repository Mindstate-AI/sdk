// ============================================================================
// @mindstate/sdk — On-Chain Key Delivery (via MindstateToken contract)
// ============================================================================

import { ethers } from 'ethers';
import { wrapKey } from './encryption.js';
import { MINDSTATE_ABI } from './abi.js';
import type { KeyEnvelope, KeyDeliveryProvider } from './types.js';

// ---------------------------------------------------------------------------
// OnChainKeyDelivery — key delivery stored on-chain in the MindstateToken
// ---------------------------------------------------------------------------

/**
 * Key delivery backed by on-chain storage in the MindstateToken contract.
 *
 * Envelopes are delivered via a `deliverKeyEnvelope()` transaction and
 * stored in contract state. Consumers retrieve them with `getKeyEnvelope()`.
 *
 * This is an OPTIONAL alternative to the off-chain {@link StorageKeyDelivery}.
 * It trades a small amount of gas per delivery for guaranteed availability,
 * simpler discovery, and no dependency on external storage infrastructure.
 *
 * On L2s like Base the gas cost is negligible (~$0.001 per envelope).
 *
 * **Publisher workflow:**
 * 1. Watch for `Redeemed` events.
 * 2. Call `storeEnvelope()` — this sends a transaction to the contract.
 *
 * **Consumer workflow:**
 * 1. Call `fetchEnvelope()` — this reads from the contract (free, no gas).
 *
 * @example
 * ```ts
 * // Publisher side
 * const delivery = new OnChainKeyDelivery(signer);
 * await delivery.storeEnvelope({ tokenAddress, checkpointId, consumerAddress, envelope });
 *
 * // Consumer side
 * const delivery = new OnChainKeyDelivery(provider);
 * const envelope = await delivery.fetchEnvelope({ tokenAddress, checkpointId, consumerAddress });
 * ```
 */
export class OnChainKeyDelivery implements KeyDeliveryProvider {
  private readonly providerOrSigner: ethers.Provider | ethers.Signer;

  /**
   * @param providerOrSigner - An ethers v6 Provider (for read-only / consumer)
   *                           or Signer (for write / publisher). A Signer is
   *                           required for `storeEnvelope()`.
   */
  constructor(providerOrSigner: ethers.Provider | ethers.Signer) {
    this.providerOrSigner = providerOrSigner;
  }

  /** @inheritdoc */
  async storeEnvelope(params: {
    tokenAddress: string;
    checkpointId: string;
    consumerAddress: string;
    envelope: KeyEnvelope;
  }): Promise<void> {
    const contract = new ethers.Contract(
      params.tokenAddress,
      MINDSTATE_ABI,
      this.providerOrSigner,
    );

    if (!('getAddress' in this.providerOrSigner)) {
      throw new Error(
        'Mindstate: a Signer is required for on-chain key delivery (storeEnvelope)',
      );
    }

    const { wrappedKey, nonce, senderPublicKey } = params.envelope;

    // Pack the 24-byte nonce into bytes24 hex
    const nonceHex = '0x' + Buffer.from(nonce).toString('hex');

    const tx = await contract.deliverKeyEnvelope(
      params.consumerAddress,
      params.checkpointId,
      wrappedKey,
      nonceHex,
      ethers.hexlify(senderPublicKey),
    );
    await tx.wait();
  }

  /** @inheritdoc */
  async fetchEnvelope(params: {
    tokenAddress: string;
    checkpointId: string;
    consumerAddress: string;
  }): Promise<KeyEnvelope> {
    const contract = new ethers.Contract(
      params.tokenAddress,
      MINDSTATE_ABI,
      this.providerOrSigner,
    );

    // Check existence first for a clear error message
    const exists: boolean = await contract.hasKeyEnvelope(
      params.consumerAddress,
      params.checkpointId,
    );

    if (!exists) {
      throw new Error(
        'Mindstate: on-chain key envelope not found. ' +
          'The publisher may not have delivered it yet, or may be using off-chain delivery.',
      );
    }

    const result = await contract.getKeyEnvelope(
      params.consumerAddress,
      params.checkpointId,
    );

    const wrappedKeyHex: string = result.wrappedKey ?? result[0];
    const nonceHex: string = result.nonce ?? result[1];
    const senderPubKeyHex: string = result.senderPublicKey ?? result[2];

    return {
      checkpointId: params.checkpointId,
      wrappedKey: ethers.getBytes(wrappedKeyHex),
      nonce: ethers.getBytes(nonceHex),
      senderPublicKey: ethers.getBytes(senderPubKeyHex),
    };
  }

  // -----------------------------------------------------------------------
  // Convenience: check availability without throwing
  // -----------------------------------------------------------------------

  /**
   * Check whether an on-chain key envelope has been delivered for a consumer
   * and checkpoint. This is a free read call (no gas).
   *
   * @param tokenAddress    - Address of the MindstateToken contract.
   * @param consumerAddress - The consumer's Ethereum address.
   * @param checkpointId    - The checkpoint to check.
   * @returns `true` if an envelope exists on-chain.
   */
  async hasEnvelope(
    tokenAddress: string,
    consumerAddress: string,
    checkpointId: string,
  ): Promise<boolean> {
    const contract = new ethers.Contract(
      tokenAddress,
      MINDSTATE_ABI,
      this.providerOrSigner,
    );
    return contract.hasKeyEnvelope(consumerAddress, checkpointId) as Promise<boolean>;
  }
}

// ---------------------------------------------------------------------------
// OnChainPublisherKeyManager — publisher-side convenience for on-chain delivery
// ---------------------------------------------------------------------------

/**
 * Publisher-side key manager that delivers envelopes on-chain.
 *
 * Drop-in replacement for {@link PublisherKeyManager} when you want on-chain
 * delivery instead of off-chain. The API is identical.
 *
 * @example
 * ```ts
 * const delivery = new OnChainKeyDelivery(signer);
 * const manager = new OnChainPublisherKeyManager(publisherKeys, delivery);
 *
 * // After publishing
 * manager.storeKey(checkpointId, sealedCapsule.encryptionKey);
 *
 * // When a Redeemed event fires
 * const consumerPubKey = await client.getEncryptionKey(token, consumerAddress);
 * await manager.fulfillRedemption(token, checkpointId, consumerAddress, fromHex(consumerPubKey));
 * ```
 */
export class OnChainPublisherKeyManager {
  private keys = new Map<string, Uint8Array>();

  constructor(
    private readonly keyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
    private readonly delivery: OnChainKeyDelivery,
  ) {}

  /**
   * Store the symmetric key K for a checkpoint. Call this after publishing.
   */
  storeKey(checkpointId: string, key: Uint8Array): void {
    this.keys.set(checkpointId.toLowerCase(), key);
  }

  /**
   * Wrap K for a redeemed consumer and deliver the envelope on-chain.
   */
  async fulfillRedemption(
    tokenAddress: string,
    checkpointId: string,
    consumerAddress: string,
    consumerPublicKey: Uint8Array,
  ): Promise<void> {
    const normalizedId = checkpointId.toLowerCase();
    const K = this.keys.get(normalizedId);

    if (!K) {
      throw new Error(
        `Mindstate: no key stored for checkpoint ${checkpointId}. ` +
          'Was storeKey() called after publishing?',
      );
    }

    if (consumerPublicKey.length !== 32) {
      throw new Error(
        `Mindstate: consumer public key must be 32 bytes, got ${consumerPublicKey.length}`,
      );
    }

    const envelope = wrapKey(K, consumerPublicKey, this.keyPair.secretKey);
    envelope.checkpointId = checkpointId;

    await this.delivery.storeEnvelope({
      tokenAddress,
      checkpointId,
      consumerAddress,
      envelope,
    });
  }

  hasKey(checkpointId: string): boolean {
    return this.keys.has(checkpointId.toLowerCase());
  }
}
