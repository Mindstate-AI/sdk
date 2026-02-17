// ============================================================================
// @mindstate/sdk — Type Definitions
// ============================================================================

// ---- Capsule (Schema-Agnostic) ---------------------------------------------

/**
 * A Mindstate capsule — the unit of state publication.
 *
 * The capsule is a generic, versioned container. The protocol defines the
 * envelope (version, schema, payload) but does NOT prescribe what goes inside.
 * Publishers can put anything in the payload: agent identity, model weights,
 * conversation logs, memory, or anything else.
 *
 * The `schema` field is an optional convention hint (e.g. "agent/v1",
 * "model-weights/v1") that tells consumers how to interpret the payload.
 * The protocol does not enforce or validate schemas — it just moves bytes.
 */
export interface Capsule {
  /** Protocol version (currently "1.0.0"). */
  version: string;
  /** Optional schema identifier. Convention, not enforced by the protocol. */
  schema?: string;
  /** Arbitrary payload. The protocol serializes and encrypts this without interpretation. */
  payload: Record<string, unknown>;
}

// ---- Agent Schema (Optional Extension) -------------------------------------
//
// The "agent/v1" schema is a suggested convention for AI agent state.
// Publishers are free to use it, modify it, or ignore it entirely.
//

/** Persistent identity core of an AI agent. (agent/v1 schema) */
export interface IdentityKernel {
  /** Persistent identifier — bytes32 hex string. */
  id: string;
  /** Agent's stable identity rules. */
  constraints: Record<string, unknown>;
  /** Rules governing how the kernel may self-modify (optional). */
  selfAmendmentRules?: Record<string, unknown>;
  /** Publisher signature over the kernel (optional). */
  signature?: string;
}

/** Runtime environment snapshot for reproducibility. (agent/v1 schema) */
export interface ExecutionManifest {
  /** Model identifier (e.g. "gpt-4o"). */
  modelId: string;
  /** Exact model version / checkpoint. */
  modelVersion: string;
  /** Tool-name → semver mapping. */
  toolVersions: Record<string, string>;
  /** Parameters affecting determinism (temperature, seed, etc.). */
  determinismParams: Record<string, unknown>;
  /** Runtime environment metadata. */
  environment: Record<string, unknown>;
  /** ISO 8601 timestamp of manifest creation. */
  timestamp: string;
}

/** A single addressable segment of agent memory. (agent/v1 schema) */
export interface MemorySegment {
  /** Unique segment identifier. */
  id: string;
  /** bytes32 hex — keccak256 of the segment plaintext. */
  contentHash: string;
  /** bytes32 hex — keccak256 of the encrypted segment. */
  encryptedHash: string;
  /** Storage URI of the encrypted segment (e.g. IPFS CID, ar:// txId, fil:// CID). */
  contentUri: string;
  /** Arbitrary segment metadata. */
  metadata: Record<string, unknown>;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/** Ordered collection of memory segments. (agent/v1 schema) */
export interface MemoryIndex {
  /** Memory index format version. */
  version: string;
  /** Ordered list of memory segments. */
  segments: MemorySegment[];
}

/** The payload shape for the agent/v1 schema. */
export interface AgentPayload {
  identityKernel: IdentityKernel;
  executionManifest: ExecutionManifest;
  memoryIndex: MemoryIndex;
}

// ---- Redemption ------------------------------------------------------------

/** Determines how redemption grants access to checkpoints. */
export enum RedeemMode {
  /** Each redeem() call burns tokens for ONE specific checkpoint. */
  PerCheckpoint = 0,
  /** One redeem() call burns tokens for access to ALL checkpoints. */
  Universal = 1,
}

// ---- On-Chain Types --------------------------------------------------------

/** Record of a published checkpoint as stored on-chain. */
export interface CheckpointRecord {
  /** bytes32 hex — unique checkpoint identifier. */
  checkpointId: string;
  /** bytes32 hex — predecessor checkpoint identifier. */
  predecessorId: string;
  /** bytes32 hex — keccak256 of canonical capsule plaintext. */
  stateCommitment: string;
  /** bytes32 hex — keccak256 of the uploaded ciphertext. */
  ciphertextHash: string;
  /** Storage URI of the uploaded ciphertext (e.g. IPFS CID, ar:// txId, fil:// CID). */
  ciphertextUri: string;
  /** bytes32 hex — optional secondary commitment (e.g. manifest hash in agent/v1). */
  manifestHash: string;
  /** Unix timestamp of publication. */
  publishedAt: number;
  /** Block number at publication. */
  blockNumber: number;
}

// ---- Sealed Capsule --------------------------------------------------------

/** Result of encrypting a capsule — ready for upload and on-chain publication. */
export interface SealedCapsule {
  /** IV ‖ ciphertext ‖ auth tag (AES-256-GCM output). */
  ciphertext: Uint8Array;
  /** bytes32 hex — keccak256 of ciphertext. */
  contentHash: string;
  /** bytes32 hex — keccak256 of canonical plaintext. */
  stateCommitment: string;
  /** bytes32 hex — optional secondary commitment. */
  metadataHash: string;
  /** The 32-byte symmetric content-encryption key K. */
  encryptionKey: Uint8Array;
}

// ---- Key Envelope ----------------------------------------------------------

/** Envelope containing a content key K wrapped for a specific consumer. */
export interface KeyEnvelope {
  /** bytes32 hex — checkpoint the key belongs to. */
  checkpointId: string;
  /** K encrypted via NaCl box. */
  wrappedKey: Uint8Array;
  /** NaCl box nonce (24 bytes). */
  nonce: Uint8Array;
  /** Sender's X25519 public key (32 bytes). */
  senderPublicKey: Uint8Array;
}

// ---- Key Delivery Provider -------------------------------------------------

/**
 * Abstract interface for key delivery. Decouples key distribution from
 * any specific infrastructure — can be backed by IPFS, S3, HTTP, or
 * any storage that supports upload/download.
 *
 * The publisher calls `storeEnvelope()` after wrapping K for a consumer.
 * The consumer calls `fetchEnvelope()` after redeeming on-chain.
 *
 * No centralized service required. The publisher and consumer interact
 * only through storage and the blockchain.
 */
export interface KeyDeliveryProvider {
  /** Store a wrapped key envelope for a consumer to retrieve later. */
  storeEnvelope(params: {
    tokenAddress: string;
    checkpointId: string;
    consumerAddress: string;
    envelope: KeyEnvelope;
  }): Promise<void>;

  /** Retrieve a wrapped key envelope delivered to a consumer. */
  fetchEnvelope(params: {
    tokenAddress: string;
    checkpointId: string;
    consumerAddress: string;
  }): Promise<KeyEnvelope>;
}

// ---- Storage Interface -----------------------------------------------------

/** Abstract storage backend (e.g. IPFS, Arweave, S3). */
export interface StorageProvider {
  /** Upload data and return a content-addressable URI. */
  upload(data: Uint8Array): Promise<string>;
  /** Download data by its content-addressable URI. */
  download(uri: string): Promise<Uint8Array>;
}

// ---- Discovery Types -------------------------------------------------------

/** Off-chain description attached to a checkpoint by the publisher. */
export interface CheckpointDescription {
  /** bytes32 hex — the checkpoint this describes. */
  checkpointId: string;
  /** Short headline (e.g. "Stable release", "Memory consolidation"). */
  title?: string;
  /** Longer body — markdown, changelog, migration notes, etc. */
  description?: string;
  /** Tags (mirrors on-chain tags for off-chain convenience). */
  tags?: string[];
  /** Arbitrary additional metadata. */
  metadata?: Record<string, unknown>;
}

/** A checkpoint record enriched with off-chain descriptions and on-chain tags. */
export interface EnrichedCheckpoint extends CheckpointRecord {
  /** On-chain tag, if any. */
  tag?: string;
  /** Off-chain title, if any. */
  title?: string;
  /** Off-chain description, if any. */
  description?: string;
  /** Off-chain metadata, if any. */
  descriptionMetadata?: Record<string, unknown>;
}

// ---- Storage Policy (Off-Chain Metadata) ------------------------------------

/**
 * Off-chain storage policy metadata for a checkpoint.
 *
 * Stored in {@link CheckpointDescription.metadata} under the `storage` key.
 * Provides transparency about which backend holds the data, retention intent,
 * and migration history — without incurring on-chain gas costs.
 */
export interface StoragePolicyMetadata {
  /** Storage tier classification: 'hot' (IPFS), 'warm' (Filecoin), 'cold' (Arweave). */
  tier: 'hot' | 'warm' | 'cold';
  /** Storage backend identifier. */
  backend: 'ipfs' | 'arweave' | 'filecoin';
  /** Backend-specific location reference (CID, txId, deal ID). */
  locationRef?: string;
  /** Intended retention policy (e.g. "90d", "1y", "permanent"). */
  retentionPolicy?: string;
  /** ISO 8601 timestamp of the expected expiry, if applicable. */
  expiresAt?: string;
  /** Migration history — previous storage locations, oldest first. */
  migratedFrom?: Array<{
    backend: string;
    locationRef: string;
    migratedAt: string;
  }>;
}

// ---- Config ----------------------------------------------------------------

/** Top-level configuration for the Mindstate SDK. */
export interface MindstateConfig {
  /** An ethers v6 Provider instance (ethers.Provider or compatible). */
  provider: import('ethers').Provider;
  /** An ethers v6 Signer instance (required for write operations). */
  signer?: import('ethers').Signer;
  /** Default storage provider. */
  storage?: StorageProvider;
  /** Default key delivery provider. */
  keyDelivery?: KeyDeliveryProvider;
}
