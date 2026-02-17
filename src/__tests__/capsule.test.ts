import { describe, it, expect } from 'vitest';
import {
  serializeCapsule,
  deserializeCapsule,
  createCapsule,
  createAgentCapsule,
  serializeCanonical,
} from '../capsule.js';
import type { Capsule } from '../types.js';

const sampleCapsule: Capsule = {
  version: '1.0.0',
  schema: 'test/v1',
  payload: { foo: 'bar', num: 42, nested: { a: 1 } },
};

describe('serializeCapsule', () => {
  it('produces deterministic bytes', () => {
    const bytes1 = serializeCapsule(sampleCapsule);
    const bytes2 = serializeCapsule(sampleCapsule);
    expect(bytes1).toEqual(bytes2);
  });

  it('produces different bytes for different input', () => {
    const other: Capsule = { version: '1.0.0', payload: { foo: 'baz' } };
    const bytes1 = serializeCapsule(sampleCapsule);
    const bytes2 = serializeCapsule(other);
    expect(bytes1).not.toEqual(bytes2);
  });

  it('throws on missing version', () => {
    expect(() => serializeCapsule({ version: '', payload: {} } as Capsule)).toThrow();
  });

  it('throws on missing payload', () => {
    expect(() => serializeCapsule({ version: '1.0.0' } as unknown as Capsule)).toThrow();
  });
});

describe('deserializeCapsule', () => {
  it('round-trips correctly', () => {
    const bytes = serializeCapsule(sampleCapsule);
    const result = deserializeCapsule(bytes);
    expect(result.version).toBe('1.0.0');
    expect(result.schema).toBe('test/v1');
    expect(result.payload).toEqual({ foo: 'bar', num: 42, nested: { a: 1 } });
  });

  it('throws on invalid JSON', () => {
    const garbage = new TextEncoder().encode('not json');
    expect(() => deserializeCapsule(garbage)).toThrow();
  });

  it('throws on missing version', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ payload: {} }));
    expect(() => deserializeCapsule(bad)).toThrow();
  });
});

describe('createCapsule', () => {
  it('creates a capsule with defaults', () => {
    const capsule = createCapsule({ key: 'value' });
    expect(capsule.version).toBe('1.0.0');
    expect(capsule.schema).toBeUndefined();
    expect(capsule.payload).toEqual({ key: 'value' });
  });

  it('accepts a schema hint', () => {
    const capsule = createCapsule({ data: 123 }, { schema: 'model/v1' });
    expect(capsule.schema).toBe('model/v1');
  });

  it('throws on null payload', () => {
    expect(() => createCapsule(null as unknown as Record<string, unknown>)).toThrow();
  });
});

describe('createAgentCapsule', () => {
  it('creates an agent/v1 capsule', () => {
    const capsule = createAgentCapsule({
      identityKernel: { id: '0xabc', constraints: { role: 'test' } },
      executionManifest: {
        modelId: 'gpt-4',
        modelVersion: '2025-01',
        toolVersions: {},
        determinismParams: {},
        environment: {},
        timestamp: '2025-01-01T00:00:00Z',
      },
    });

    expect(capsule.version).toBe('1.0.0');
    expect(capsule.schema).toBe('agent/v1');
    expect(capsule.payload).toHaveProperty('identityKernel');
    expect(capsule.payload).toHaveProperty('executionManifest');
    expect(capsule.payload).toHaveProperty('memoryIndex');
  });

  it('throws without identityKernel id', () => {
    expect(() =>
      createAgentCapsule({
        identityKernel: { id: '', constraints: {} },
        executionManifest: {
          modelId: 'gpt-4', modelVersion: '1', toolVersions: {},
          determinismParams: {}, environment: {}, timestamp: '',
        },
      }),
    ).toThrow();
  });
});

describe('serializeCanonical', () => {
  it('serializes arbitrary objects deterministically', () => {
    const bytes1 = serializeCanonical({ b: 2, a: 1 });
    const bytes2 = serializeCanonical({ a: 1, b: 2 });
    expect(bytes1).toEqual(bytes2); // RFC 8785 sorts keys
  });
});
