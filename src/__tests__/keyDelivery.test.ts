import { describe, it, expect } from 'vitest';
import {
  computeEnvelopeId,
  serializeEnvelope,
  deserializeEnvelope,
  StorageKeyDelivery,
  PublisherKeyManager,
} from '../keyDelivery.js';
import { generateContentKey, generateEncryptionKeyPair, unwrapKey } from '../encryption.js';
import type { KeyEnvelope, StorageProvider } from '../types.js';

// In-memory mock storage
function createMockStorage(): StorageProvider {
  const store = new Map<string, Uint8Array>();
  let counter = 0;

  return {
    async upload(data: Uint8Array): Promise<string> {
      const uri = `mock://${counter++}`;
      store.set(uri, new Uint8Array(data));
      return uri;
    },
    async download(uri: string): Promise<Uint8Array> {
      const data = store.get(uri);
      if (!data) throw new Error(`Not found: ${uri}`);
      return data;
    },
  };
}

describe('computeEnvelopeId', () => {
  it('is deterministic', () => {
    const a = computeEnvelopeId('0xToken', '0xCheckpoint', '0xConsumer');
    const b = computeEnvelopeId('0xToken', '0xCheckpoint', '0xConsumer');
    expect(a).toBe(b);
  });

  it('is case-insensitive', () => {
    const a = computeEnvelopeId('0xABC', '0xDEF', '0x123');
    const b = computeEnvelopeId('0xabc', '0xdef', '0x123');
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    const a = computeEnvelopeId('0xA', '0xB', '0xC');
    const b = computeEnvelopeId('0xA', '0xB', '0xD');
    expect(a).not.toBe(b);
  });
});

describe('serializeEnvelope / deserializeEnvelope', () => {
  it('round-trips', () => {
    const envelope: KeyEnvelope = {
      checkpointId: '0xabc123',
      wrappedKey: new Uint8Array([1, 2, 3, 4]),
      nonce: new Uint8Array([5, 6, 7, 8]),
      senderPublicKey: new Uint8Array([9, 10, 11, 12]),
    };

    const bytes = serializeEnvelope(envelope);
    const result = deserializeEnvelope(bytes);

    expect(result.checkpointId).toBe('0xabc123');
    expect(Buffer.from(result.wrappedKey).equals(Buffer.from(envelope.wrappedKey))).toBe(true);
    expect(Buffer.from(result.nonce).equals(Buffer.from(envelope.nonce))).toBe(true);
    expect(Buffer.from(result.senderPublicKey).equals(Buffer.from(envelope.senderPublicKey))).toBe(true);
  });

  it('throws on invalid data', () => {
    expect(() => deserializeEnvelope(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('StorageKeyDelivery', () => {
  it('stores and fetches envelopes', async () => {
    const storage = createMockStorage();
    const delivery = new StorageKeyDelivery(storage);

    const envelope: KeyEnvelope = {
      checkpointId: '0xcp1',
      wrappedKey: new Uint8Array(32),
      nonce: new Uint8Array(24),
      senderPublicKey: new Uint8Array(32),
    };

    await delivery.storeEnvelope({
      tokenAddress: '0xToken',
      checkpointId: '0xcp1',
      consumerAddress: '0xConsumer',
      envelope,
    });

    const fetched = await delivery.fetchEnvelope({
      tokenAddress: '0xToken',
      checkpointId: '0xcp1',
      consumerAddress: '0xConsumer',
    });

    expect(fetched.checkpointId).toBe('0xcp1');
  });

  it('throws on missing envelope', async () => {
    const storage = createMockStorage();
    const delivery = new StorageKeyDelivery(storage);

    await expect(
      delivery.fetchEnvelope({
        tokenAddress: '0xA',
        checkpointId: '0xB',
        consumerAddress: '0xC',
      }),
    ).rejects.toThrow('not found');
  });

  it('publishIndex and loadIndex round-trip', async () => {
    const storage = createMockStorage();
    const pub = new StorageKeyDelivery(storage);

    const envelope: KeyEnvelope = {
      checkpointId: '0xcp1',
      wrappedKey: new Uint8Array(32),
      nonce: new Uint8Array(24),
      senderPublicKey: new Uint8Array(32),
    };

    await pub.storeEnvelope({
      tokenAddress: '0xT',
      checkpointId: '0xcp1',
      consumerAddress: '0xC',
      envelope,
    });

    const indexUri = await pub.publishIndex();

    // Consumer loads from the index
    const con = new StorageKeyDelivery(storage);
    await con.loadIndex(indexUri);
    const fetched = await con.fetchEnvelope({
      tokenAddress: '0xT',
      checkpointId: '0xcp1',
      consumerAddress: '0xC',
    });

    expect(fetched.checkpointId).toBe('0xcp1');
  });
});

describe('StorageKeyDelivery descriptions', () => {
  it('stores and retrieves descriptions', () => {
    const storage = createMockStorage();
    const delivery = new StorageKeyDelivery(storage);

    delivery.setDescription({
      checkpointId: '0xcp1',
      title: 'First release',
      description: 'Initial agent state',
    });

    const desc = delivery.getDescription('0xcp1');
    expect(desc?.title).toBe('First release');
    expect(desc?.description).toBe('Initial agent state');
  });

  it('publishFullIndex and loadFullIndex round-trip with descriptions', async () => {
    const storage = createMockStorage();
    const pub = new StorageKeyDelivery(storage);

    pub.setDescription({
      checkpointId: '0xcp1',
      title: 'Test',
      description: 'A test checkpoint',
    });

    const envelope: KeyEnvelope = {
      checkpointId: '0xcp1',
      wrappedKey: new Uint8Array(32),
      nonce: new Uint8Array(24),
      senderPublicKey: new Uint8Array(32),
    };
    await pub.storeEnvelope({
      tokenAddress: '0xT',
      checkpointId: '0xcp1',
      consumerAddress: '0xC',
      envelope,
    });

    const indexUri = await pub.publishFullIndex();

    const con = new StorageKeyDelivery(storage);
    await con.loadFullIndex(indexUri);

    // Envelope accessible
    const fetched = await con.fetchEnvelope({
      tokenAddress: '0xT',
      checkpointId: '0xcp1',
      consumerAddress: '0xC',
    });
    expect(fetched.checkpointId).toBe('0xcp1');

    // Description accessible
    const desc = con.getDescription('0xcp1');
    expect(desc?.title).toBe('Test');
  });
});

describe('PublisherKeyManager', () => {
  it('stores keys and fulfills redemptions', async () => {
    const storage = createMockStorage();
    const delivery = new StorageKeyDelivery(storage);

    const publisherKeys = generateEncryptionKeyPair();
    const consumerKeys = generateEncryptionKeyPair();
    const manager = new PublisherKeyManager(publisherKeys, delivery);

    const contentKey = generateContentKey();
    const checkpointId = '0xcp1';

    manager.storeKey(checkpointId, contentKey);
    expect(manager.hasKey(checkpointId)).toBe(true);

    await manager.fulfillRedemption(
      '0xToken',
      checkpointId,
      '0xConsumer',
      consumerKeys.publicKey,
    );

    // Consumer can fetch and unwrap
    const envelope = await delivery.fetchEnvelope({
      tokenAddress: '0xToken',
      checkpointId,
      consumerAddress: '0xConsumer',
    });

    const unwrapped = unwrapKey(envelope, consumerKeys.secretKey);
    expect(Buffer.from(unwrapped).equals(Buffer.from(contentKey))).toBe(true);
  });

  it('exportKeys and importKeys round-trip', () => {
    const storage = createMockStorage();
    const delivery = new StorageKeyDelivery(storage);
    const keys = generateEncryptionKeyPair();

    const manager1 = new PublisherKeyManager(keys, delivery);
    const contentKey = generateContentKey();
    manager1.storeKey('0xcp1', contentKey);

    const exported = manager1.exportKeys();

    const manager2 = new PublisherKeyManager(keys, delivery);
    manager2.importKeys(exported);
    expect(manager2.hasKey('0xcp1')).toBe(true);
  });

  it('throws on missing key during fulfillment', async () => {
    const storage = createMockStorage();
    const delivery = new StorageKeyDelivery(storage);
    const keys = generateEncryptionKeyPair();
    const manager = new PublisherKeyManager(keys, delivery);

    await expect(
      manager.fulfillRedemption('0xT', '0xmissing', '0xC', new Uint8Array(32)),
    ).rejects.toThrow('no key stored');
  });
});
