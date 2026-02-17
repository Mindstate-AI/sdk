// ============================================================================
// @mindstate/sdk — Commitment Computation
// ============================================================================

import { keccak_256 } from '@noble/hashes/sha3';
import { serializeCapsule, serializeCanonical } from './capsule.js';
import type { Capsule } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the keccak256 hash of arbitrary bytes.
 *
 * @param data - Raw bytes to hash.
 * @returns 0x-prefixed hex string of the 32-byte hash.
 */
export function hashBytes(data: Uint8Array): string {
  return toHex(keccak_256(data));
}

/**
 * Compute the state commitment for a {@link Capsule}.
 *
 * The commitment is `keccak256(canonicalize(capsule))` — it binds the
 * entire capsule (version, schema, and payload) regardless of what the
 * payload contains.
 *
 * @param capsule - The capsule to commit to.
 * @returns 0x-prefixed bytes32 hex string.
 */
export function computeStateCommitment(capsule: Capsule): string {
  const bytes = serializeCapsule(capsule);
  return hashBytes(bytes);
}

/**
 * Compute a keccak256 commitment over any JSON-serializable value.
 *
 * Useful for computing the secondary commitment (the `manifestHash` field
 * in the on-chain checkpoint) over arbitrary metadata. For the agent/v1
 * schema, this would be the execution manifest. For other schemas, it can
 * be anything — or omitted entirely (pass nothing, use bytes32(0) on-chain).
 *
 * @param value - Any JSON-serializable value.
 * @returns 0x-prefixed bytes32 hex string.
 */
export function computeMetadataHash(value: unknown): string {
  const bytes = serializeCanonical(value);
  return hashBytes(bytes);
}

/**
 * Compute the keccak256 hash of raw ciphertext bytes.
 *
 * @param ciphertext - The encrypted payload.
 * @returns 0x-prefixed bytes32 hex string.
 */
export function computeCiphertextHash(ciphertext: Uint8Array): string {
  return hashBytes(ciphertext);
}
