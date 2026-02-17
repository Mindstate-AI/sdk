// ============================================================================
// @mindstate/sdk — Explorer (Timeline Discovery)
// ============================================================================

import { ethers } from 'ethers';
import type {
  CheckpointRecord,
  CheckpointDescription,
  EnrichedCheckpoint,
  StorageProvider,
} from './types.js';
import { MINDSTATE_ABI, ZERO_BYTES32 } from './abi.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

function parseCheckpointFromEvent(log: ethers.LogDescription): CheckpointRecord {
  return {
    checkpointId: log.args.checkpointId as string,
    predecessorId: log.args.predecessorId as string,
    stateCommitment: log.args.stateCommitment as string,
    ciphertextHash: log.args.ciphertextHash as string,
    ciphertextUri: log.args.ciphertextUri as string,
    manifestHash: log.args.manifestHash as string,
    publishedAt: Number(log.args.timestamp),
    blockNumber: Number(log.args.blockNumber),
  };
}

function parseCheckpointFromContract(
  checkpointId: string,
  cp: { predecessorId: string; stateCommitment: string; ciphertextHash: string; ciphertextUri: string; manifestHash: string; publishedAt: bigint; blockNumber: bigint },
): CheckpointRecord {
  return {
    checkpointId,
    predecessorId: cp.predecessorId,
    stateCommitment: cp.stateCommitment,
    ciphertextHash: cp.ciphertextHash,
    ciphertextUri: cp.ciphertextUri,
    manifestHash: cp.manifestHash,
    publishedAt: Number(cp.publishedAt),
    blockNumber: Number(cp.blockNumber),
  };
}

// ---------------------------------------------------------------------------
// MindstateExplorer
// ---------------------------------------------------------------------------

/**
 * Read-only utility for browsing a Mindstate token's checkpoint history.
 *
 * No signer required — the explorer only reads on-chain data and optionally
 * merges it with off-chain descriptions from the publisher's index.
 *
 * @example
 * ```ts
 * const explorer = new MindstateExplorer(provider);
 *
 * // Get the full timeline
 * const timeline = await explorer.getTimeline(tokenAddress);
 *
 * // Resolve a tag
 * const stable = await explorer.resolveTag(tokenAddress, 'stable');
 *
 * // Get enriched timeline with off-chain descriptions
 * const enriched = await explorer.getEnrichedTimeline(tokenAddress, { indexUri });
 * ```
 */
export class MindstateExplorer {
  private readonly provider: ethers.Provider;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
  }

  /** Get a read-only contract instance. */
  private contract(tokenAddress: string): ethers.Contract {
    return new ethers.Contract(tokenAddress, MINDSTATE_ABI, this.provider);
  }

  // -----------------------------------------------------------------------
  // Timeline
  // -----------------------------------------------------------------------

  /**
   * Build the full checkpoint timeline for a token by reading
   * `CheckpointPublished` events. Returns checkpoints in chronological
   * order (oldest first).
   *
   * @param tokenAddress - Address of the MindstateToken contract.
   * @param fromBlock - Block to start scanning from (default: 0).
   * @returns Array of {@link CheckpointRecord} in chronological order.
   */
  async getTimeline(
    tokenAddress: string,
    fromBlock: number = 0,
  ): Promise<CheckpointRecord[]> {
    const ct = this.contract(tokenAddress);
    const filter = ct.filters.CheckpointPublished();
    const logs = await ct.queryFilter(filter, fromBlock);

    const iface = new ethers.Interface(MINDSTATE_ABI);
    const checkpoints: CheckpointRecord[] = [];

    for (const log of logs) {
      try {
        const parsed = iface.parseLog({
          topics: (log as ethers.EventLog).topics as string[],
          data: (log as ethers.EventLog).data,
        });
        if (parsed) {
          checkpoints.push(parseCheckpointFromEvent(parsed));
        }
      } catch {
        // Not our event — skip
      }
    }

    return checkpoints;
  }

  /**
   * Get the N most recent checkpoints, in reverse chronological order
   * (newest first).
   *
   * @param tokenAddress - Address of the MindstateToken contract.
   * @param count - Number of checkpoints to return.
   * @returns Array of {@link CheckpointRecord}, newest first.
   */
  async getRecent(
    tokenAddress: string,
    count: number,
  ): Promise<CheckpointRecord[]> {
    const ct = this.contract(tokenAddress);
    const total = Number(await ct.checkpointCount());

    if (total === 0) return [];

    const start = Math.max(0, total - count);
    const indices = Array.from({ length: total - start }, (_, k) => total - 1 - k);

    // Fetch in parallel for performance
    const results = await Promise.all(
      indices.map(async (i) => {
        const id: string = await ct.getCheckpointIdAtIndex(i);
        const cp = await ct.getCheckpoint(id);
        return parseCheckpointFromContract(id, cp);
      }),
    );

    return results;
  }

  // -----------------------------------------------------------------------
  // Lineage
  // -----------------------------------------------------------------------

  /**
   * Walk the predecessor chain from a checkpoint back to genesis.
   * Returns the full lineage in reverse chronological order (the given
   * checkpoint first, genesis last).
   *
   * @param tokenAddress - Address of the MindstateToken contract.
   * @param checkpointId - bytes32 hex starting checkpoint.
   * @returns Array of {@link CheckpointRecord}, starting checkpoint first.
   */
  async getLineage(
    tokenAddress: string,
    checkpointId: string,
    maxDepth: number = 10000,
  ): Promise<CheckpointRecord[]> {
    const ct = this.contract(tokenAddress);
    const lineage: CheckpointRecord[] = [];
    const visited = new Set<string>();

    let currentId = checkpointId;
    while (currentId !== ZERO_BYTES32 && lineage.length < maxDepth) {
      const normalizedId = currentId.toLowerCase();
      if (visited.has(normalizedId)) {
        throw new Error(`Mindstate: cycle detected at checkpoint ${currentId} during lineage walk`);
      }
      visited.add(normalizedId);

      const cp = await ct.getCheckpoint(currentId);
      if (Number(cp.publishedAt) === 0) {
        throw new Error(`Mindstate: checkpoint ${currentId} not found during lineage walk`);
      }
      lineage.push(parseCheckpointFromContract(currentId, cp));
      currentId = cp.predecessorId;
    }

    return lineage;
  }

  // -----------------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------------

  /**
   * Resolve a tag to its full checkpoint record.
   *
   * @param tokenAddress - Address of the MindstateToken contract.
   * @param tag - The tag to resolve (e.g. "stable", "v2.0").
   * @returns The {@link CheckpointRecord} the tag points to.
   * @throws If the tag is not assigned to any checkpoint.
   */
  async resolveTag(
    tokenAddress: string,
    tag: string,
  ): Promise<CheckpointRecord> {
    const ct = this.contract(tokenAddress);
    const checkpointId: string = await ct.resolveTag(tag);

    if (checkpointId === ZERO_BYTES32) {
      throw new Error(`Mindstate: tag "${tag}" is not assigned to any checkpoint`);
    }

    const cp = await ct.getCheckpoint(checkpointId);
    return parseCheckpointFromContract(checkpointId, cp);
  }

  /**
   * Get all tags by scanning `CheckpointTagged` events.
   *
   * @param tokenAddress - Address of the MindstateToken contract.
   * @param fromBlock - Block to start scanning from (default: 0).
   * @returns Map of tag name to checkpoint ID (latest assignment wins).
   */
  async getAllTags(
    tokenAddress: string,
    fromBlock: number = 0,
  ): Promise<Map<string, string>> {
    const ct = this.contract(tokenAddress);
    const filter = ct.filters.CheckpointTagged();
    const logs = await ct.queryFilter(filter, fromBlock);

    const iface = new ethers.Interface(MINDSTATE_ABI);
    const tags = new Map<string, string>();

    for (const log of logs) {
      try {
        const parsed = iface.parseLog({
          topics: (log as ethers.EventLog).topics as string[],
          data: (log as ethers.EventLog).data,
        });
        if (parsed) {
          tags.set(parsed.args.tag as string, parsed.args.checkpointId as string);
        }
      } catch {
        // skip
      }
    }

    return tags;
  }

  // -----------------------------------------------------------------------
  // Enriched Timeline (on-chain + off-chain)
  // -----------------------------------------------------------------------

  /**
   * Build a timeline enriched with on-chain tags and off-chain descriptions.
   *
   * @param tokenAddress - Address of the MindstateToken contract.
   * @param options - Optional: storage provider and index URI for loading
   *                  off-chain descriptions, and fromBlock for event scanning.
   * @returns Array of {@link EnrichedCheckpoint} in chronological order.
   */
  async getEnrichedTimeline(
    tokenAddress: string,
    options?: {
      storage?: StorageProvider;
      indexUri?: string;
      fromBlock?: number;
    },
  ): Promise<EnrichedCheckpoint[]> {
    const fromBlock = options?.fromBlock ?? 0;

    // Get base timeline and tags in parallel
    const [timeline, tagsMap] = await Promise.all([
      this.getTimeline(tokenAddress, fromBlock),
      this.getAllTags(tokenAddress, fromBlock),
    ]);

    // Build reverse tag map: checkpointId → tag
    const checkpointToTag = new Map<string, string>();
    for (const [tag, cpId] of tagsMap) {
      checkpointToTag.set(cpId.toLowerCase(), tag);
    }

    // Load off-chain descriptions if available
    let descriptions = new Map<string, CheckpointDescription>();
    if (options?.storage && options?.indexUri) {
      try {
        const data = await options.storage.download(options.indexUri);
        const parsed = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;

        // Support combined format (envelopes + descriptions) or standalone
        const descObj = (parsed.descriptions ?? parsed) as Record<string, CheckpointDescription>;
        if (typeof descObj === 'object') {
          for (const [k, v] of Object.entries(descObj)) {
            if (v && typeof v === 'object' && 'checkpointId' in v) {
              descriptions.set(k.toLowerCase(), v as CheckpointDescription);
            }
          }
        }
      } catch {
        // Descriptions unavailable — continue without them
      }
    }

    // Merge
    return timeline.map((cp): EnrichedCheckpoint => {
      const tag = checkpointToTag.get(cp.checkpointId.toLowerCase());
      const desc = descriptions.get(cp.checkpointId.toLowerCase());

      return {
        ...cp,
        tag,
        title: desc?.title,
        description: desc?.description,
        descriptionMetadata: desc?.metadata,
      };
    });
  }
}
