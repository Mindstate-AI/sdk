// ============================================================================
// @mindstate/sdk — Capsule Serialization & Construction
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import _canonicalize from 'canonicalize';
const canonicalize: (value: unknown) => string | undefined =
  typeof _canonicalize === 'function'
    ? _canonicalize
    : (_canonicalize as unknown as { default: (value: unknown) => string | undefined }).default;
import type {
  AgentPayload,
  Capsule,
  ExecutionManifest,
  IdentityKernel,
  MemoryIndex,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Produce the RFC 8785 canonical JSON byte representation of a value.
 * @internal
 */
function canonicalBytes(value: unknown): Uint8Array {
  const json = canonicalize(value);
  if (json === undefined) {
    throw new Error('Mindstate: canonicalize returned undefined — input may contain unsupported types');
  }
  return encoder.encode(json);
}

/**
 * Validate that a capsule has the minimum required protocol structure.
 * Only checks protocol-level fields (version, payload). Does NOT validate
 * the payload contents — schemas are not enforced at the protocol level.
 * @internal
 */
function assertValidCapsule(capsule: unknown): asserts capsule is Capsule {
  if (capsule === null || typeof capsule !== 'object') {
    throw new Error('Mindstate: capsule must be a non-null object');
  }

  const c = capsule as Record<string, unknown>;

  if (typeof c.version !== 'string' || c.version.length === 0) {
    throw new Error('Mindstate: capsule.version must be a non-empty string');
  }

  if (c.payload === null || c.payload === undefined || typeof c.payload !== 'object' || Array.isArray(c.payload)) {
    throw new Error('Mindstate: capsule.payload must be a non-null object');
  }
}

// ---------------------------------------------------------------------------
// Public API — Generic (schema-agnostic)
// ---------------------------------------------------------------------------

/**
 * Serialize a {@link Capsule} to its deterministic RFC 8785 canonical JSON
 * byte representation.
 *
 * Works with any capsule payload — the protocol does not inspect or validate
 * the payload contents during serialization.
 *
 * @param capsule - The capsule to serialize.
 * @returns UTF-8 encoded canonical JSON bytes.
 * @throws If the capsule is missing a `version` or `payload` field.
 */
export function serializeCapsule(capsule: Capsule): Uint8Array {
  assertValidCapsule(capsule);
  return canonicalBytes(capsule);
}

/**
 * Deserialize raw bytes into a validated {@link Capsule}.
 *
 * Validates only protocol-level structure (version + payload). Does not
 * validate the payload against any schema.
 *
 * @param bytes - UTF-8 encoded JSON bytes.
 * @returns The parsed and validated capsule.
 * @throws If the bytes do not represent a valid capsule.
 */
export function deserializeCapsule(bytes: Uint8Array): Capsule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (err) {
    throw new Error(
      `Mindstate: failed to parse capsule bytes as JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  assertValidCapsule(parsed);
  return parsed;
}

/**
 * Serialize any object to its deterministic RFC 8785 canonical JSON byte
 * representation. Useful for computing secondary commitments (metadata hashes)
 * over arbitrary payload fields.
 *
 * @param value - Any JSON-serializable value.
 * @returns UTF-8 encoded canonical JSON bytes.
 */
export function serializeCanonical(value: unknown): Uint8Array {
  return canonicalBytes(value);
}

/**
 * Create a capsule with an arbitrary payload.
 *
 * @param payload - Any JSON-serializable object.
 * @param options - Optional schema identifier and version override.
 * @returns A complete {@link Capsule} object.
 *
 * @example
 * ```ts
 * // Any data you want
 * const capsule = createCapsule({ weights: '...', architecture: 'transformer' });
 *
 * // With a schema hint
 * const capsule = createCapsule(
 *   { conversations: [...], preferences: {...} },
 *   { schema: 'chat-history/v1' },
 * );
 * ```
 */
export function createCapsule(
  payload: Record<string, unknown>,
  options?: { schema?: string; version?: string },
): Capsule {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Mindstate: payload must be a non-null object');
  }

  const capsule: Capsule = {
    version: options?.version ?? '1.0.0',
    payload,
  };

  if (options?.schema) {
    capsule.schema = options.schema;
  }

  return capsule;
}

// ---------------------------------------------------------------------------
// Public API — Agent Schema (agent/v1)
// ---------------------------------------------------------------------------

/**
 * Create a capsule using the agent/v1 schema convention.
 *
 * This is a convenience helper for AI agent state. The protocol does not
 * require this schema — it's an optional convention.
 *
 * @param params - Agent-specific capsule components.
 * @returns A {@link Capsule} with `schema: "agent/v1"`.
 *
 * @example
 * ```ts
 * const capsule = createAgentCapsule({
 *   identityKernel: { id: '0x...', constraints: { purpose: 'assistant' } },
 *   executionManifest: { modelId: 'gpt-4', modelVersion: '...', ... },
 * });
 * ```
 */
export function createAgentCapsule(params: {
  identityKernel: IdentityKernel;
  executionManifest: ExecutionManifest;
  memoryIndex?: MemoryIndex;
}): Capsule {
  const { identityKernel, executionManifest, memoryIndex } = params;

  if (!identityKernel || !identityKernel.id) {
    throw new Error('Mindstate: identityKernel with a valid id is required');
  }
  if (!executionManifest || !executionManifest.modelId) {
    throw new Error('Mindstate: executionManifest with a valid modelId is required');
  }

  const payload: AgentPayload = {
    identityKernel,
    executionManifest,
    memoryIndex: memoryIndex ?? { version: '1.0.0', segments: [] },
  };

  return {
    version: '1.0.0',
    schema: 'agent/v1',
    payload: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Serialize an {@link ExecutionManifest} to its deterministic canonical JSON
 * byte representation. Useful for computing a secondary commitment over the
 * manifest when using the agent/v1 schema.
 *
 * @param manifest - The execution manifest.
 * @returns UTF-8 encoded canonical JSON bytes.
 */
export function serializeManifest(manifest: ExecutionManifest): Uint8Array {
  if (!manifest.modelId || typeof manifest.modelId !== 'string') {
    throw new Error('Mindstate: manifest.modelId is required');
  }
  return canonicalBytes(manifest);
}
