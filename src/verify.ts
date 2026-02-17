// ============================================================================
// @mindstate/sdk — Verification Module
// ============================================================================

import { deserializeCapsule } from './capsule.js';
import {
  computeCiphertextHash,
  computeStateCommitment,
} from './commitment.js';
import { decrypt } from './encryption.js';
import type { Capsule, CheckpointRecord } from './types.js';
import { ZERO_BYTES32 } from './abi.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify that a capsule's computed state commitment matches an expected value.
 *
 * @param capsule - The deserialized capsule.
 * @param expectedCommitment - The expected 0x-prefixed bytes32 hex commitment.
 * @returns `true` if the commitment matches.
 * @throws If the computed commitment does not match the expected value.
 */
export function verifyStateCommitment(
  capsule: Capsule,
  expectedCommitment: string,
): boolean {
  const computed = computeStateCommitment(capsule);
  const normComputed = computed.toLowerCase();
  const normExpected = expectedCommitment.toLowerCase();

  if (normComputed !== normExpected) {
    throw new Error(
      `Mindstate: state commitment mismatch — computed ${computed}, expected ${expectedCommitment}`,
    );
  }
  return true;
}

/**
 * Verify that a ciphertext's keccak256 hash matches an expected value.
 *
 * @param ciphertext - The raw ciphertext bytes.
 * @param expectedHash - The expected 0x-prefixed bytes32 hex hash.
 * @returns `true` if the hash matches.
 * @throws If the computed hash does not match the expected value.
 */
export function verifyCiphertextHash(
  ciphertext: Uint8Array,
  expectedHash: string,
): boolean {
  const computed = computeCiphertextHash(ciphertext);
  const normComputed = computed.toLowerCase();
  const normExpected = expectedHash.toLowerCase();

  if (normComputed !== normExpected) {
    throw new Error(
      `Mindstate: ciphertext hash mismatch — computed ${computed}, expected ${expectedHash}`,
    );
  }
  return true;
}

/**
 * Verify the lineage (linked-list integrity) of an ordered sequence of
 * checkpoint records.
 *
 * - The first checkpoint's `predecessorId` must be `0x000…000`.
 * - Each subsequent checkpoint's `predecessorId` must equal the previous
 *   checkpoint's `checkpointId`.
 *
 * @param checkpoints - Ordered array of {@link CheckpointRecord} objects
 *                      (oldest first).
 * @returns `true` if the lineage is valid.
 * @throws If any lineage link is broken.
 */
export function verifyCheckpointLineage(
  checkpoints: CheckpointRecord[],
): boolean {
  if (checkpoints.length === 0) {
    return true;
  }

  // First checkpoint must have zero predecessor
  const first = checkpoints[0];
  if (first.predecessorId.toLowerCase() !== ZERO_BYTES32) {
    throw new Error(
      `Mindstate: first checkpoint predecessor must be zero — got ${first.predecessorId}`,
    );
  }

  // Each subsequent checkpoint must chain from the previous
  for (let i = 1; i < checkpoints.length; i++) {
    const prev = checkpoints[i - 1];
    const curr = checkpoints[i];

    if (curr.predecessorId.toLowerCase() !== prev.checkpointId.toLowerCase()) {
      throw new Error(
        `Mindstate: checkpoint lineage broken at index ${i} — ` +
          `expected predecessorId ${prev.checkpointId}, got ${curr.predecessorId}`,
      );
    }
  }

  return true;
}

/**
 * Complete verification and decryption flow.
 *
 * 1. Verify the ciphertext hash.
 * 2. Decrypt with the provided key.
 * 3. Deserialize the plaintext into a capsule.
 * 4. Verify the state commitment.
 *
 * @param ciphertext - The encrypted capsule bytes.
 * @param key - 32-byte AES-256-GCM content key.
 * @param expectedStateCommitment - Expected 0x-prefixed bytes32 state commitment.
 * @param expectedCiphertextHash - Expected 0x-prefixed bytes32 ciphertext hash.
 * @returns The verified and deserialized {@link Capsule}.
 * @throws On any verification or decryption failure.
 */
export function verifyAndDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  expectedStateCommitment: string,
  expectedCiphertextHash: string,
): Capsule {
  // Step 1: Verify ciphertext integrity
  verifyCiphertextHash(ciphertext, expectedCiphertextHash);

  // Step 2: Decrypt
  const plaintext = decrypt(ciphertext, key);

  // Step 3: Deserialize
  const capsule = deserializeCapsule(plaintext);

  // Step 4: Verify state commitment
  verifyStateCommitment(capsule, expectedStateCommitment);

  return capsule;
}
