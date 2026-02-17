// ============================================================================
// @mindstate/sdk — Storage Tier Policy
// ============================================================================

// ---------------------------------------------------------------------------
// Storage Tiers
// ---------------------------------------------------------------------------

/**
 * Storage tier classification.
 *
 * | Tier | Backend   | Use Case                                  | Cost Model            |
 * |------|-----------|-------------------------------------------|-----------------------|
 * | Hot  | IPFS      | Active development, recent checkpoints    | Infrastructure only   |
 * | Warm | Filecoin  | Production snapshots, compliance archives | ~$0.001/GB/mo renew.  |
 * | Cold | Arweave   | Canonical releases, genesis states        | ~$8/GB one-time       |
 */
export enum StorageTier {
  /** IPFS — active development, high retrieval frequency, 30–90 day retention. */
  Hot = 'hot',
  /** Filecoin — defined retention periods (6–24 months), renewable contracts. */
  Warm = 'warm',
  /** Arweave — permanent storage via economic endowment, canonical releases. */
  Cold = 'cold',
}

// ---------------------------------------------------------------------------
// Tier Context
// ---------------------------------------------------------------------------

/**
 * Contextual information used by a {@link TierPolicy} to determine
 * which storage tier a checkpoint should be assigned to.
 */
export interface TierContext {
  /** The checkpoint label (passed to `publish()`), if any. */
  label?: string;
  /** Any tags associated with the checkpoint. */
  tags?: string[];
  /** Sequential checkpoint index within the stream. */
  checkpointIndex?: number;
  /** Whether this is the first (genesis) checkpoint in the stream. */
  isGenesis?: boolean;
}

// ---------------------------------------------------------------------------
// Tier Policy Interface
// ---------------------------------------------------------------------------

/**
 * Determines which {@link StorageTier} a checkpoint should be stored in.
 *
 * Implementations can use the {@link TierContext} to make dynamic decisions
 * based on labels, tags, checkpoint position, etc.
 */
export interface TierPolicy {
  /** Resolve the appropriate storage tier for the given publication context. */
  resolveTier(context: TierContext): StorageTier;
}

// ---------------------------------------------------------------------------
// DefaultTierPolicy — everything goes to Hot (IPFS)
// ---------------------------------------------------------------------------

/**
 * Default tier policy: all checkpoints go to the **hot** tier (IPFS).
 *
 * This preserves the current behavior — simple, no configuration needed,
 * and compatible with any existing Mindstate deployment.
 *
 * @example
 * ```ts
 * const policy = new DefaultTierPolicy();
 * policy.resolveTier({ label: 'stable' }); // => StorageTier.Hot
 * ```
 */
export class DefaultTierPolicy implements TierPolicy {
  resolveTier(_context: TierContext): StorageTier {
    return StorageTier.Hot;
  }
}

// ---------------------------------------------------------------------------
// PromotionTierPolicy — automatic tier promotion by label/tag
// ---------------------------------------------------------------------------

/**
 * Tier policy with automatic promotion based on labels and tags.
 *
 * Promotes checkpoints to higher tiers based on configurable tag sets:
 * - **Cold tier** tags: `stable`, `release`, `canonical`, `genesis` — data
 *   that should persist permanently.
 * - **Warm tier** tags: `archive`, `compliance`, `audit` — data with
 *   defined retention requirements.
 * - Everything else defaults to **hot tier** (IPFS).
 *
 * Genesis checkpoints (first in a stream) are always promoted to cold.
 *
 * Tag sets are fully configurable via constructor options.
 *
 * @example
 * ```ts
 * const policy = new PromotionTierPolicy();
 * policy.resolveTier({ label: 'stable' });    // => StorageTier.Cold
 * policy.resolveTier({ label: 'archive' });   // => StorageTier.Warm
 * policy.resolveTier({ label: '' });           // => StorageTier.Hot
 * policy.resolveTier({ isGenesis: true });     // => StorageTier.Cold
 *
 * // Custom tag sets
 * const custom = new PromotionTierPolicy({
 *   coldTags: ['permanent', 'frozen'],
 *   warmTags: ['backup'],
 * });
 * ```
 */
export class PromotionTierPolicy implements TierPolicy {
  private readonly coldTags: Set<string>;
  private readonly warmTags: Set<string>;
  private readonly promoteGenesis: boolean;

  /**
   * @param options - Optional configuration for tag-based promotion.
   * @param options.coldTags       - Labels/tags that trigger cold tier promotion.
   * @param options.warmTags       - Labels/tags that trigger warm tier promotion.
   * @param options.promoteGenesis - Whether genesis checkpoints auto-promote to cold.
   *                                  Defaults to `true`.
   */
  constructor(options?: {
    coldTags?: string[];
    warmTags?: string[];
    promoteGenesis?: boolean;
  }) {
    this.coldTags = new Set(
      options?.coldTags ?? ['stable', 'release', 'canonical', 'genesis'],
    );
    this.warmTags = new Set(
      options?.warmTags ?? ['archive', 'compliance', 'audit'],
    );
    this.promoteGenesis = options?.promoteGenesis ?? true;
  }

  resolveTier(context: TierContext): StorageTier {
    // Genesis checkpoints always go to cold (permanent) tier
    if (this.promoteGenesis && context.isGenesis) {
      return StorageTier.Cold;
    }

    // Check label against cold tier tags
    if (context.label && this.coldTags.has(context.label.toLowerCase())) {
      return StorageTier.Cold;
    }

    // Check label against warm tier tags
    if (context.label && this.warmTags.has(context.label.toLowerCase())) {
      return StorageTier.Warm;
    }

    // Check all tags against cold tier
    if (context.tags) {
      for (const tag of context.tags) {
        if (this.coldTags.has(tag.toLowerCase())) return StorageTier.Cold;
      }
      for (const tag of context.tags) {
        if (this.warmTags.has(tag.toLowerCase())) return StorageTier.Warm;
      }
    }

    // Default to hot tier
    return StorageTier.Hot;
  }
}
