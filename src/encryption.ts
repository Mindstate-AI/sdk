// ============================================================================
// @mindstate/sdk — Encryption & Key Wrapping
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import type { KeyEnvelope } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AES-256-GCM initialisation vector length in bytes. */
const IV_LENGTH = 12;

/** AES-256-GCM authentication tag length in bytes. */
const AUTH_TAG_LENGTH = 16;

/** Required symmetric key length in bytes (256 bits). */
const KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// Content Encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random 32-byte content-encryption key.
 *
 * @returns A 32-byte `Uint8Array` suitable for AES-256-GCM.
 */
export function generateContentKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_LENGTH));
}

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * The output layout is: `[IV (12 bytes)] [ciphertext] [auth tag (16 bytes)]`.
 *
 * @param plaintext - Data to encrypt.
 * @param key - 32-byte symmetric key.
 * @returns Concatenated IV ‖ ciphertext ‖ auth tag.
 * @throws If the key length is not 32 bytes.
 */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Mindstate: encryption key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Layout: IV ‖ ciphertext ‖ authTag
  const result = new Uint8Array(IV_LENGTH + encrypted.length + AUTH_TAG_LENGTH);
  result.set(new Uint8Array(iv), 0);
  result.set(new Uint8Array(encrypted), IV_LENGTH);
  result.set(new Uint8Array(authTag), IV_LENGTH + encrypted.length);

  return result;
}

/**
 * Decrypt AES-256-GCM sealed data produced by {@link encrypt}.
 *
 * Expects the layout: `[IV (12)] [ciphertext] [auth tag (16)]`.
 *
 * @param sealed - The sealed payload (IV ‖ ciphertext ‖ auth tag).
 * @param key - 32-byte symmetric key used during encryption.
 * @returns The decrypted plaintext.
 * @throws If the key length is wrong, or decryption / authentication fails.
 */
export function decrypt(sealed: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Mindstate: decryption key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  if (sealed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(
      `Mindstate: sealed data too short — expected at least ${IV_LENGTH + AUTH_TAG_LENGTH} bytes, got ${sealed.length}`,
    );
  }

  const iv = sealed.slice(0, IV_LENGTH);
  const authTag = sealed.slice(sealed.length - AUTH_TAG_LENGTH);
  const ciphertext = sealed.slice(IV_LENGTH, sealed.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Uint8Array(decrypted);
  } catch (err) {
    throw new Error(
      `Mindstate: AES-256-GCM decryption failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Key Wrapping (X25519 via NaCl box)
// ---------------------------------------------------------------------------

/**
 * Generate an X25519 key pair for asymmetric key wrapping.
 *
 * @returns An object containing the 32-byte `publicKey` and `secretKey`.
 */
export function generateEncryptionKeyPair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * Wrap (encrypt) a content key for a specific recipient using NaCl box
 * (X25519 + XSalsa20-Poly1305).
 *
 * @param contentKey - The 32-byte symmetric key to wrap.
 * @param recipientPublicKey - Recipient's X25519 public key (32 bytes).
 * @param senderSecretKey - Sender's X25519 secret key (32 bytes).
 * @returns A {@link KeyEnvelope} containing the wrapped key, nonce, and sender public key.
 * @throws If wrapping fails.
 */
export function wrapKey(
  contentKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): KeyEnvelope {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const senderPublicKey = nacl.box.keyPair.fromSecretKey(senderSecretKey).publicKey;

  const wrappedKey = nacl.box(contentKey, nonce, recipientPublicKey, senderSecretKey);
  if (!wrappedKey) {
    throw new Error('Mindstate: NaCl box encryption failed during key wrapping');
  }

  return {
    checkpointId: '', // Populated by the caller after on-chain publication
    wrappedKey,
    nonce,
    senderPublicKey,
  };
}

/**
 * Unwrap (decrypt) a content key from a {@link KeyEnvelope} using the
 * recipient's secret key.
 *
 * @param envelope - The key envelope to unwrap.
 * @param recipientSecretKey - Recipient's X25519 secret key (32 bytes).
 * @returns The 32-byte content key.
 * @throws If decryption fails (invalid keys, tampered data, etc.).
 */
export function unwrapKey(
  envelope: KeyEnvelope,
  recipientSecretKey: Uint8Array,
): Uint8Array {
  const contentKey = nacl.box.open(
    envelope.wrappedKey,
    envelope.nonce,
    envelope.senderPublicKey,
    recipientSecretKey,
  );

  if (!contentKey) {
    throw new Error(
      'Mindstate: NaCl box decryption failed — the key envelope may be corrupt or the wrong secret key was provided',
    );
  }

  return contentKey;
}
