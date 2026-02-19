// ============================================================================
// @mindstate/sdk — Sealed Mode (Off-Chain Only)
//
// Provides the full capsule lifecycle — create, seal, unseal, verify — without
// any blockchain interaction. Same capsule format, same encryption, same storage
// backends. The chain is replaced by direct key sharing.
//
// Use this when you want portability and encryption but don't need an on-chain
// ledger, token, or market.
//
//   Tier 1 of the three-tier Mindstate model:
//     SDK-only  →  no chain, no token, out-of-band key sharing
//     Registry  →  on-chain commitments, no token, allowlist access
//     Token     →  on-chain commitments, ERC-20, burn-to-redeem market
// ============================================================================

import { serializeCapsule, deserializeCapsule, createCapsule, createAgentCapsule } from './capsule.js';
import { computeStateCommitment, computeCiphertextHash, computeMetadataHash, hashBytes } from './commitment.js';
import { encrypt, decrypt, generateContentKey, generateEncryptionKeyPair, wrapKey, unwrapKey } from './encryption.js';
import { verifyCiphertextHash, verifyStateCommitment } from './verify.js';
import type { Capsule, SealedCapsule, KeyEnvelope, StorageProvider } from './types.js';

// ---------------------------------------------------------------------------
// Core: seal / unseal
// ---------------------------------------------------------------------------

/**
 * Seal a capsule: serialize, compute commitments, encrypt.
 *
 * This is the off-chain equivalent of `MindstateClient.publish()` — it performs
 * every step except the on-chain transaction. The returned {@link SealedCapsule}
 * contains the ciphertext (ready for upload) and the symmetric key K (to be
 * shared out-of-band or via direct key wrapping).
 *
 * @param capsule  - The capsule to seal.
 * @param metadata - Optional metadata for computing a secondary commitment.
 * @returns The sealed capsule including ciphertext, commitments, and the content key K.
 *
 * @example
 * ```ts
 * import { createCapsule, seal } from '@mindstate/sdk';
 *
 * const capsule = createCapsule({ model: 'gpt-4o', memory: [...] });
 * const sealed = seal(capsule);
 *
 * // Upload ciphertext to storage
 * const uri = await storage.upload(sealed.ciphertext);
 *
 * // Share K directly with your recipient (DM, API, file, etc.)
 * console.log('Content key:', Buffer.from(sealed.encryptionKey).toString('hex'));
 * ```
 */
export function seal(capsule: Capsule, metadata?: unknown): SealedCapsule {
  const plaintext = serializeCapsule(capsule);
  const stateCommitment = computeStateCommitment(capsule);
  const metadataHash = metadata ? computeMetadataHash(metadata) : '0x' + '0'.repeat(64);

  const encryptionKey = generateContentKey();
  const ciphertext = encrypt(plaintext, encryptionKey);
  const contentHash = computeCiphertextHash(ciphertext);

  return {
    ciphertext,
    contentHash,
    stateCommitment,
    metadataHash,
    encryptionKey,
  };
}

/**
 * Unseal a sealed capsule: decrypt, deserialize, and verify.
 *
 * This is the off-chain equivalent of the consumer side of `MindstateClient.consume()`.
 *
 * @param ciphertext       - The encrypted capsule bytes.
 * @param key              - The 32-byte AES-256-GCM content key K.
 * @param stateCommitment  - Optional expected state commitment to verify against.
 * @param ciphertextHash   - Optional expected ciphertext hash to verify against.
 * @returns The decrypted and verified capsule.
 *
 * @example
 * ```ts
 * import { unseal } from '@mindstate/sdk';
 *
 * const ciphertext = await storage.download(uri);
 * const capsule = unseal(ciphertext, key);
 * console.log(capsule.payload);
 * ```
 */
export function unseal(
  ciphertext: Uint8Array,
  key: Uint8Array,
  stateCommitment?: string,
  ciphertextHash?: string,
): Capsule {
  if (ciphertextHash) {
    verifyCiphertextHash(ciphertext, ciphertextHash);
  }

  const plaintext = decrypt(ciphertext, key);
  const capsule = deserializeCapsule(plaintext);

  if (stateCommitment) {
    verifyStateCommitment(capsule, stateCommitment);
  }

  return capsule;
}

// ---------------------------------------------------------------------------
// High-level: seal + upload
// ---------------------------------------------------------------------------

/**
 * Seal a capsule and upload the ciphertext to storage.
 *
 * Convenience wrapper that combines {@link seal} with a storage upload.
 *
 * @param capsule  - The capsule to seal and upload.
 * @param storage  - The storage provider for ciphertext upload.
 * @param metadata - Optional metadata for the secondary commitment.
 * @returns The sealed capsule, the storage URI, and a receipt with all commitments.
 *
 * @example
 * ```ts
 * import { createCapsule, sealAndUpload, IpfsStorage } from '@mindstate/sdk';
 *
 * const storage = new IpfsStorage({ gateway: 'https://ipfs.io' });
 * const capsule = createCapsule({ data: '...' });
 *
 * const { uri, sealed, receipt } = await sealAndUpload(capsule, storage);
 *
 * // Share these with your recipient:
 * //   uri           — where to download the ciphertext
 * //   receipt       — commitments for verification
 * //   sealed.encryptionKey — the key K (share securely!)
 * ```
 */
export async function sealAndUpload(
  capsule: Capsule,
  storage: StorageProvider,
  metadata?: unknown,
): Promise<{
  sealed: SealedCapsule;
  uri: string;
  receipt: SealReceipt;
}> {
  const sealed = seal(capsule, metadata);
  const uri = await storage.upload(sealed.ciphertext);

  return {
    sealed,
    uri,
    receipt: {
      stateCommitment: sealed.stateCommitment,
      ciphertextHash: sealed.contentHash,
      metadataHash: sealed.metadataHash,
      ciphertextUri: uri,
      sealedAt: new Date().toISOString(),
    },
  };
}

/**
 * Download ciphertext from storage and unseal it.
 *
 * @param uri              - Storage URI of the ciphertext.
 * @param key              - The 32-byte content key K.
 * @param storage          - The storage provider for download.
 * @param stateCommitment  - Optional commitment to verify.
 * @param ciphertextHash   - Optional ciphertext hash to verify.
 * @returns The decrypted and verified capsule.
 *
 * @example
 * ```ts
 * import { downloadAndUnseal, IpfsStorage } from '@mindstate/sdk';
 *
 * const storage = new IpfsStorage({ gateway: 'https://ipfs.io' });
 * const capsule = await downloadAndUnseal(uri, key, storage);
 * ```
 */
export async function downloadAndUnseal(
  uri: string,
  key: Uint8Array,
  storage: StorageProvider,
  stateCommitment?: string,
  ciphertextHash?: string,
): Promise<Capsule> {
  const ciphertext = await storage.download(uri);
  return unseal(ciphertext, key, stateCommitment, ciphertextHash);
}

// ---------------------------------------------------------------------------
// Key sharing helpers
// ---------------------------------------------------------------------------

/**
 * Wrap the content key K for a specific recipient.
 *
 * Use this to securely share the decryption key with a known recipient
 * via any channel (DM, email, API response, QR code, etc.).
 *
 * @param contentKey         - The 32-byte symmetric key K from sealing.
 * @param recipientPublicKey - Recipient's X25519 public key (32 bytes).
 * @param senderSecretKey    - Sender's X25519 secret key (32 bytes).
 * @returns A key envelope that can be serialized and transmitted.
 */
export function wrapKeyForRecipient(
  contentKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): KeyEnvelope {
  return wrapKey(contentKey, recipientPublicKey, senderSecretKey);
}

/**
 * Unwrap a content key K from a key envelope.
 *
 * @param envelope           - The key envelope received from the sender.
 * @param recipientSecretKey - Recipient's X25519 secret key (32 bytes).
 * @returns The 32-byte content key K.
 */
export function unwrapKeyFromEnvelope(
  envelope: KeyEnvelope,
  recipientSecretKey: Uint8Array,
): Uint8Array {
  return unwrapKey(envelope, recipientSecretKey);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Receipt returned after sealing (for sharing commitments out-of-band). */
export interface SealReceipt {
  /** keccak256 of the canonical capsule plaintext. */
  stateCommitment: string;
  /** keccak256 of the encrypted ciphertext. */
  ciphertextHash: string;
  /** keccak256 of the metadata (bytes32(0) if none). */
  metadataHash: string;
  /** Storage URI where ciphertext was uploaded. */
  ciphertextUri: string;
  /** ISO 8601 timestamp of sealing. */
  sealedAt: string;
}
