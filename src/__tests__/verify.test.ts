import { describe, it, expect } from 'vitest';
import {
  verifyStateCommitment,
  verifyCiphertextHash,
  verifyCheckpointLineage,
  verifyAndDecrypt,
} from '../verify.js';
import { createCapsule, serializeCapsule } from '../capsule.js';
import { computeStateCommitment, computeCiphertextHash } from '../commitment.js';
import { encrypt, generateContentKey } from '../encryption.js';
import type { CheckpointRecord } from '../types.js';

const ZERO = '0x' + '0'.repeat(64);

describe('verifyStateCommitment', () => {
  it('passes on correct commitment', () => {
    const capsule = createCapsule({ data: 'test' });
    const commitment = computeStateCommitment(capsule);
    expect(verifyStateCommitment(capsule, commitment)).toBe(true);
  });

  it('throws on mismatch', () => {
    const capsule = createCapsule({ data: 'test' });
    expect(() => verifyStateCommitment(capsule, ZERO)).toThrow('mismatch');
  });

  it('is case insensitive', () => {
    const capsule = createCapsule({ data: 'test' });
    const commitment = computeStateCommitment(capsule);
    expect(verifyStateCommitment(capsule, commitment.toUpperCase())).toBe(true);
  });
});

describe('verifyCiphertextHash', () => {
  it('passes on correct hash', () => {
    const data = new Uint8Array([1, 2, 3]);
    const hash = computeCiphertextHash(data);
    expect(verifyCiphertextHash(data, hash)).toBe(true);
  });

  it('throws on mismatch', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(() => verifyCiphertextHash(data, ZERO)).toThrow('mismatch');
  });
});

describe('verifyCheckpointLineage', () => {
  it('passes on empty array', () => {
    expect(verifyCheckpointLineage([])).toBe(true);
  });

  it('passes on valid chain', () => {
    const chain: CheckpointRecord[] = [
      { checkpointId: '0xaaa', predecessorId: ZERO, stateCommitment: '', ciphertextHash: '', ciphertextUri: '', manifestHash: '', publishedAt: 0, blockNumber: 0 },
      { checkpointId: '0xbbb', predecessorId: '0xaaa', stateCommitment: '', ciphertextHash: '', ciphertextUri: '', manifestHash: '', publishedAt: 0, blockNumber: 0 },
      { checkpointId: '0xccc', predecessorId: '0xbbb', stateCommitment: '', ciphertextHash: '', ciphertextUri: '', manifestHash: '', publishedAt: 0, blockNumber: 0 },
    ];
    expect(verifyCheckpointLineage(chain)).toBe(true);
  });

  it('throws if first checkpoint has non-zero predecessor', () => {
    const chain: CheckpointRecord[] = [
      { checkpointId: '0xaaa', predecessorId: '0xfff', stateCommitment: '', ciphertextHash: '', ciphertextUri: '', manifestHash: '', publishedAt: 0, blockNumber: 0 },
    ];
    expect(() => verifyCheckpointLineage(chain)).toThrow('zero');
  });

  it('throws on broken link', () => {
    const chain: CheckpointRecord[] = [
      { checkpointId: '0xaaa', predecessorId: ZERO, stateCommitment: '', ciphertextHash: '', ciphertextUri: '', manifestHash: '', publishedAt: 0, blockNumber: 0 },
      { checkpointId: '0xccc', predecessorId: '0xwrong', stateCommitment: '', ciphertextHash: '', ciphertextUri: '', manifestHash: '', publishedAt: 0, blockNumber: 0 },
    ];
    expect(() => verifyCheckpointLineage(chain)).toThrow('broken');
  });
});

describe('verifyAndDecrypt', () => {
  it('full pipeline works end-to-end', () => {
    const capsule = createCapsule({ message: 'secret data' });
    const plaintext = serializeCapsule(capsule);
    const key = generateContentKey();
    const ciphertext = encrypt(plaintext, key);

    const stateCommitment = computeStateCommitment(capsule);
    const ciphertextHash = computeCiphertextHash(ciphertext);

    const result = verifyAndDecrypt(ciphertext, key, stateCommitment, ciphertextHash);
    expect(result.payload).toEqual({ message: 'secret data' });
  });

  it('throws on wrong ciphertext hash', () => {
    const capsule = createCapsule({ data: 'x' });
    const plaintext = serializeCapsule(capsule);
    const key = generateContentKey();
    const ciphertext = encrypt(plaintext, key);
    const stateCommitment = computeStateCommitment(capsule);

    expect(() => verifyAndDecrypt(ciphertext, key, stateCommitment, ZERO)).toThrow('mismatch');
  });

  it('throws on wrong state commitment', () => {
    const capsule = createCapsule({ data: 'x' });
    const plaintext = serializeCapsule(capsule);
    const key = generateContentKey();
    const ciphertext = encrypt(plaintext, key);
    const ciphertextHash = computeCiphertextHash(ciphertext);

    expect(() => verifyAndDecrypt(ciphertext, key, ZERO, ciphertextHash)).toThrow('mismatch');
  });
});
