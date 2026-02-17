import { describe, it, expect } from 'vitest';
import {
  hashBytes,
  computeStateCommitment,
  computeMetadataHash,
  computeCiphertextHash,
} from '../commitment.js';
import { createCapsule } from '../capsule.js';

describe('hashBytes', () => {
  it('returns a 0x-prefixed 66-char hex string', () => {
    const result = hashBytes(new Uint8Array([1, 2, 3]));
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const data = new Uint8Array([42, 43, 44]);
    expect(hashBytes(data)).toBe(hashBytes(data));
  });

  it('differs for different input', () => {
    const a = hashBytes(new Uint8Array([1]));
    const b = hashBytes(new Uint8Array([2]));
    expect(a).not.toBe(b);
  });
});

describe('computeStateCommitment', () => {
  it('returns a valid commitment', () => {
    const capsule = createCapsule({ data: 'hello' });
    const commitment = computeStateCommitment(capsule);
    expect(commitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('same capsule = same commitment', () => {
    const capsule = createCapsule({ data: 'hello' });
    expect(computeStateCommitment(capsule)).toBe(computeStateCommitment(capsule));
  });

  it('different capsule = different commitment', () => {
    const a = createCapsule({ data: 'hello' });
    const b = createCapsule({ data: 'world' });
    expect(computeStateCommitment(a)).not.toBe(computeStateCommitment(b));
  });
});

describe('computeMetadataHash', () => {
  it('hashes arbitrary objects', () => {
    const hash = computeMetadataHash({ model: 'gpt-4', version: '1.0' });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of key order', () => {
    const a = computeMetadataHash({ b: 2, a: 1 });
    const b = computeMetadataHash({ a: 1, b: 2 });
    expect(a).toBe(b);
  });
});

describe('computeCiphertextHash', () => {
  it('hashes raw bytes', () => {
    const hash = computeCiphertextHash(new Uint8Array([10, 20, 30]));
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
