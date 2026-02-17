// ============================================================================
// @mindstate/sdk — Key Delivery (Publisher-Direct, No Centralized Service)
// ============================================================================

import { keccak_256 } from '@noble/hashes/sha3';
import { wrapKey } from './encryption.js';
import type { KeyEnvelope, KeyDeliveryProvider, StorageProvider, CheckpointDescription } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Convert a Uint8Array to a 0x-prefixed lowercase hex string.
 * @internal
 */
function toHex(bytes: Uint8Array): string {
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert a hex string (with or without 0x prefix) to Uint8Array.
 * @internal
 */
function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Envelope ID — deterministic identifier for a key envelope
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic ID for a key envelope from its addressing tuple.
 *
 * Both the publisher and consumer can independently compute this ID for the
 * same (tokenAddress, checkpointId, consumerAddress) tuple.
 *
 * @param tokenAddress - Address of the MindstateToken contract.
 * @param checkpointId - bytes32 hex checkpoint identifier.
 * @param consumerAddress - Ethereum address of the consumer.
 * @returns 0x-prefixed bytes32 hex string.
 */
export function computeEnvelopeId(
  tokenAddress: string,
  checkpointId: string,
  consumerAddress: string,
): string {
  const input = `${tokenAddress.toLowerCase()}:${checkpointId.toLowerCase()}:${consumerAddress.toLowerCase()}`;
  return toHex(keccak_256(encoder.encode(input)));
}

// ---------------------------------------------------------------------------
// Envelope Serialization
// ---------------------------------------------------------------------------

/** JSON-safe representation of a KeyEnvelope. */
interface EnvelopeJson {
  checkpointId: string;
  wrappedKey: string;   // hex
  nonce: string;        // hex
  senderPublicKey: string; // hex
}

/**
 * Serialize a {@link KeyEnvelope} to bytes (JSON encoding with hex fields).
 *
 * @param envelope - The key envelope to serialize.
 * @returns UTF-8 encoded JSON bytes.
 */
export function serializeEnvelope(envelope: KeyEnvelope): Uint8Array {
  const json: EnvelopeJson = {
    checkpointId: envelope.checkpointId,
    wrappedKey: toHex(envelope.wrappedKey),
    nonce: toHex(envelope.nonce),
    senderPublicKey: toHex(envelope.senderPublicKey),
  };
  return encoder.encode(JSON.stringify(json));
}

/**
 * Deserialize bytes into a {@link KeyEnvelope}.
 *
 * @param data - UTF-8 encoded JSON bytes.
 * @returns The deserialized key envelope.
 * @throws If the data is not a valid envelope.
 */
export function deserializeEnvelope(data: Uint8Array): KeyEnvelope {
  let json: EnvelopeJson;
  try {
    json = JSON.parse(decoder.decode(data)) as EnvelopeJson;
  } catch (err) {
    throw new Error(
      `Mindstate: failed to parse key envelope — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!json.checkpointId || !json.wrappedKey || !json.nonce || !json.senderPublicKey) {
    throw new Error('Mindstate: invalid key envelope — missing required fields');
  }

  return {
    checkpointId: json.checkpointId,
    wrappedKey: fromHex(json.wrappedKey),
    nonce: fromHex(json.nonce),
    senderPublicKey: fromHex(json.senderPublicKey),
  };
}

// ---------------------------------------------------------------------------
// StorageKeyDelivery — key delivery via any StorageProvider
// ---------------------------------------------------------------------------

/**
 * Key delivery backed by a {@link StorageProvider} (e.g. IPFS, S3, Arweave).
 *
 * Envelopes are uploaded as content-addressed blobs. An in-memory index maps
 * envelope IDs to storage URIs. The index can be exported, uploaded, and
 * loaded by consumers for discovery.
 *
 * **Publisher workflow:**
 * 1. Call `storeEnvelope()` for each redeemed consumer.
 * 2. Call `publishIndex()` to upload the index — share the returned URI.
 *
 * **Consumer workflow:**
 * 1. Create a `StorageKeyDelivery` with the same storage provider.
 * 2. Call `loadIndex(indexUri)` using the publisher's index URI.
 * 3. Call `fetchEnvelope()` to retrieve the wrapped key.
 *
 * @example
 * ```ts
 * // Publisher side
 * const delivery = new StorageKeyDelivery(ipfsStorage);
 * await delivery.storeEnvelope({ tokenAddress, checkpointId, consumerAddress, envelope });
 * const indexUri = await delivery.publishIndex();
 *
 * // Consumer side
 * const delivery = new StorageKeyDelivery(ipfsStorage);
 * await delivery.loadIndex(indexUri);
 * const envelope = await delivery.fetchEnvelope({ tokenAddress, checkpointId, consumerAddress });
 * ```
 */
export class StorageKeyDelivery implements KeyDeliveryProvider {
  private index = new Map<string, string>();
  private descriptions = new Map<string, CheckpointDescription>();

  /**
   * @param storage - The storage backend for uploading/downloading envelopes.
   * @param existingIndex - Optional pre-loaded index entries.
   */
  constructor(
    private readonly storage: StorageProvider,
    existingIndex?: Record<string, string>,
  ) {
    if (existingIndex) {
      for (const [k, v] of Object.entries(existingIndex)) {
        this.index.set(k, v);
      }
    }
  }

  /** @inheritdoc */
  async storeEnvelope(params: {
    tokenAddress: string;
    checkpointId: string;
    consumerAddress: string;
    envelope: KeyEnvelope;
  }): Promise<void> {
    const id = computeEnvelopeId(
      params.tokenAddress,
      params.checkpointId,
      params.consumerAddress,
    );
    const data = serializeEnvelope(params.envelope);
    const uri = await this.storage.upload(data);
    this.index.set(id, uri);
  }

  /** @inheritdoc */
  async fetchEnvelope(params: {
    tokenAddress: string;
    checkpointId: string;
    consumerAddress: string;
  }): Promise<KeyEnvelope> {
    const id = computeEnvelopeId(
      params.tokenAddress,
      params.checkpointId,
      params.consumerAddress,
    );
    const uri = this.index.get(id);
    if (!uri) {
      throw new Error(
        `Mindstate: key envelope not found — no entry for envelope ID ${id}. ` +
          'Has the publisher fulfilled this redemption and published their index?',
      );
    }
    const data = await this.storage.download(uri);
    return deserializeEnvelope(data);
  }

  /**
   * Upload the current index to storage. Share the returned URI with
   * consumers so they can discover wrapped key envelopes.
   *
   * @returns The storage URI of the uploaded index.
   */
  async publishIndex(): Promise<string> {
    const entries = Object.fromEntries(this.index);
    const data = encoder.encode(JSON.stringify(entries));
    return this.storage.upload(data);
  }

  /**
   * Load an index from storage by URI. Call this before `fetchEnvelope()`
   * to populate the envelope lookup table.
   *
   * @param indexUri - The storage URI of the publisher's key index.
   */
  async loadIndex(indexUri: string): Promise<void> {
    const data = await this.storage.download(indexUri);
    let entries: Record<string, string>;
    try {
      entries = JSON.parse(decoder.decode(data)) as Record<string, string>;
    } catch (err) {
      throw new Error(
        `Mindstate: failed to parse key index from ${indexUri} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const [k, v] of Object.entries(entries)) {
      this.index.set(k, v);
    }
  }

  /**
   * Export the current index as a plain object (for local persistence).
   */
  exportIndex(): Record<string, string> {
    return Object.fromEntries(this.index);
  }

  // -----------------------------------------------------------------------
  // Checkpoint Descriptions (off-chain)
  // -----------------------------------------------------------------------

  /**
   * Set an off-chain description for a checkpoint. Call `publishIndex()`
   * afterwards to make it available to consumers.
   *
   * @param desc - The checkpoint description.
   */
  setDescription(desc: CheckpointDescription): void {
    if (!desc.checkpointId) {
      throw new Error('Mindstate: checkpointId is required in description');
    }
    this.descriptions.set(desc.checkpointId.toLowerCase(), desc);
  }

  /**
   * Get the off-chain description for a checkpoint, if available.
   *
   * @param checkpointId - bytes32 hex checkpoint ID.
   * @returns The description, or undefined if not set.
   */
  getDescription(checkpointId: string): CheckpointDescription | undefined {
    return this.descriptions.get(checkpointId.toLowerCase());
  }

  /**
   * Get all stored descriptions.
   */
  getAllDescriptions(): CheckpointDescription[] {
    return Array.from(this.descriptions.values());
  }

  /**
   * Upload the combined index (key envelopes + descriptions) to storage.
   * This supersedes the base `publishIndex()` — the returned URI contains
   * both envelope mappings and descriptions.
   *
   * @returns The storage URI of the uploaded combined index.
   */
  async publishFullIndex(): Promise<string> {
    const combined = {
      envelopes: Object.fromEntries(this.index),
      descriptions: Object.fromEntries(this.descriptions),
    };
    const data = encoder.encode(JSON.stringify(combined));
    return this.storage.upload(data);
  }

  /**
   * Load a combined index (envelopes + descriptions) from storage.
   * Supports both the simple envelope-only format and the combined format.
   *
   * @param indexUri - The storage URI of the publisher's index.
   */
  async loadFullIndex(indexUri: string): Promise<void> {
    const data = await this.storage.download(indexUri);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(decoder.decode(data)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Mindstate: failed to parse full index from ${indexUri} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Detect format: combined (has 'envelopes' key) vs simple (flat map)
    if (parsed.envelopes && typeof parsed.envelopes === 'object') {
      // Combined format
      const envelopes = parsed.envelopes as Record<string, string>;
      for (const [k, v] of Object.entries(envelopes)) {
        this.index.set(k, v);
      }
      if (parsed.descriptions && typeof parsed.descriptions === 'object') {
        const descriptions = parsed.descriptions as Record<string, CheckpointDescription>;
        for (const [k, v] of Object.entries(descriptions)) {
          this.descriptions.set(k, v);
        }
      }
    } else {
      // Simple envelope-only format (backward compatible)
      for (const [k, v] of Object.entries(parsed)) {
        this.index.set(k, v as string);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PublisherKeyManager — publisher-side key management and fulfillment
// ---------------------------------------------------------------------------

/**
 * Publisher-side key manager. Stores symmetric keys as they are generated
 * during publishing, and handles wrapping + delivery when consumers redeem.
 *
 * **Usage:**
 * 1. After calling `client.publish()`, call `storeKey(checkpointId, sealedCapsule.encryptionKey)`.
 * 2. Watch for `Redeemed` events on the token contract.
 * 3. For each redemption, call `fulfillRedemption()` to wrap K and deliver it.
 *
 * @example
 * ```ts
 * const publisherKeys = generateEncryptionKeyPair();
 * const delivery = new StorageKeyDelivery(ipfsStorage);
 * const manager = new PublisherKeyManager(publisherKeys, delivery);
 *
 * // After publishing
 * const { checkpointId, sealedCapsule } = await client.publish(token, capsule, { storage });
 * manager.storeKey(checkpointId, sealedCapsule.encryptionKey);
 *
 * // When a Redeemed event fires
 * const consumerPubKey = await client.getEncryptionKey(token, consumerAddress);
 * await manager.fulfillRedemption(token, checkpointId, consumerAddress, fromHex(consumerPubKey));
 *
 * // Publish the updated index so consumers can find their envelopes
 * const indexUri = await delivery.publishIndex();
 * ```
 */
export class PublisherKeyManager {
  private keys = new Map<string, Uint8Array>();

  /**
   * @param keyPair - The publisher's X25519 key pair (used as the sender in NaCl box).
   * @param delivery - The key delivery provider for storing wrapped envelopes.
   */
  constructor(
    private readonly keyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
    private readonly delivery: KeyDeliveryProvider,
  ) {}

  /**
   * Store the symmetric key K for a checkpoint. Call this after publishing.
   *
   * @param checkpointId - The checkpoint ID (bytes32 hex).
   * @param key - The 32-byte symmetric content-encryption key.
   */
  storeKey(checkpointId: string, key: Uint8Array): void {
    this.keys.set(checkpointId.toLowerCase(), key);
  }

  /**
   * Wrap K for a redeemed consumer and deliver the envelope.
   *
   * Reads the consumer's X25519 public key, wraps K using NaCl box,
   * and stores the envelope via the configured {@link KeyDeliveryProvider}.
   *
   * @param tokenAddress - Address of the MindstateToken contract.
   * @param checkpointId - The redeemed checkpoint ID.
   * @param consumerAddress - The consumer's Ethereum address.
   * @param consumerPublicKey - The consumer's 32-byte X25519 public key.
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

    // Wrap K using NaCl box (X25519 + XSalsa20-Poly1305)
    const envelope = wrapKey(K, consumerPublicKey, this.keyPair.secretKey);
    envelope.checkpointId = checkpointId;

    // Store the envelope for the consumer to retrieve
    await this.delivery.storeEnvelope({
      tokenAddress,
      checkpointId,
      consumerAddress,
      envelope,
    });
  }

  /**
   * Check if a key is stored for a given checkpoint.
   *
   * @param checkpointId - The checkpoint ID (bytes32 hex).
   * @returns `true` if the key is stored.
   */
  hasKey(checkpointId: string): boolean {
    return this.keys.has(checkpointId.toLowerCase());
  }

  /**
   * Export all stored keys as a hex map (for backup / persistence).
   * **Handle with extreme care — these are the raw symmetric keys.**
   *
   * @returns A map of checkpointId → hex-encoded key.
   */
  exportKeys(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [id, key] of this.keys) {
      result[id] = toHex(key);
    }
    return result;
  }

  /**
   * Import stored keys from a backup.
   *
   * @param keys - A map of checkpointId → hex-encoded key.
   */
  importKeys(keys: Record<string, string>): void {
    for (const [id, hex] of Object.entries(keys)) {
      this.keys.set(id.toLowerCase(), fromHex(hex));
    }
  }
}
