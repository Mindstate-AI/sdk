import { describe, it, expect } from 'vitest';
import {
  generateContentKey,
  encrypt,
  decrypt,
  generateEncryptionKeyPair,
  wrapKey,
  unwrapKey,
} from '../encryption.js';

describe('AES-256-GCM content encryption', () => {
  it('generateContentKey produces 32 bytes', () => {
    const key = generateContentKey();
    expect(key.length).toBe(32);
  });

  it('encrypt then decrypt round-trips', () => {
    const key = generateContentKey();
    const plaintext = new TextEncoder().encode('hello mindstate');
    const ciphertext = encrypt(plaintext, key);
    const decrypted = decrypt(ciphertext, key);
    expect(new TextDecoder().decode(decrypted)).toBe('hello mindstate');
  });

  it('ciphertext is longer than plaintext (IV + auth tag)', () => {
    const key = generateContentKey();
    const plaintext = new Uint8Array(100);
    const ciphertext = encrypt(plaintext, key);
    expect(ciphertext.length).toBe(100 + 12 + 16); // plaintext + IV + tag
  });

  it('wrong key fails decryption', () => {
    const key1 = generateContentKey();
    const key2 = generateContentKey();
    const ciphertext = encrypt(new Uint8Array([1, 2, 3]), key1);
    expect(() => decrypt(ciphertext, key2)).toThrow();
  });

  it('truncated ciphertext throws', () => {
    const key = generateContentKey();
    expect(() => decrypt(new Uint8Array(10), key)).toThrow();
  });

  it('rejects wrong key length', () => {
    expect(() => encrypt(new Uint8Array(10), new Uint8Array(16))).toThrow();
    expect(() => decrypt(new Uint8Array(30), new Uint8Array(16))).toThrow();
  });

  it('each encryption produces different ciphertext (random IV)', () => {
    const key = generateContentKey();
    const plaintext = new Uint8Array([1, 2, 3]);
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    // Ciphertext should differ due to random IV
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('X25519 key wrapping', () => {
  it('generateEncryptionKeyPair produces valid keys', () => {
    const kp = generateEncryptionKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it('wrapKey then unwrapKey round-trips', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const contentKey = generateContentKey();

    const envelope = wrapKey(contentKey, recipient.publicKey, sender.secretKey);
    const unwrapped = unwrapKey(envelope, recipient.secretKey);

    expect(Buffer.from(unwrapped).equals(Buffer.from(contentKey))).toBe(true);
  });

  it('wrong recipient key fails unwrap', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const wrong = generateEncryptionKeyPair();
    const contentKey = generateContentKey();

    const envelope = wrapKey(contentKey, recipient.publicKey, sender.secretKey);
    expect(() => unwrapKey(envelope, wrong.secretKey)).toThrow();
  });

  it('envelope contains sender public key', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const contentKey = generateContentKey();

    const envelope = wrapKey(contentKey, recipient.publicKey, sender.secretKey);
    expect(Buffer.from(envelope.senderPublicKey).equals(Buffer.from(sender.publicKey))).toBe(true);
  });
});
