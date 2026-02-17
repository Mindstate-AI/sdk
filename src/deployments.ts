// ============================================================================
// @mindstate/sdk — Deployed Contract Addresses
// ============================================================================

/**
 * Deployed contract addresses per chain.
 *
 * Usage:
 * ```ts
 * import { DEPLOYMENTS } from '@mindstate/sdk';
 *
 * const { factory, vault, feeCollector, implementation } = DEPLOYMENTS[8453]; // Base
 * ```
 */
export interface ChainDeployment {
  /** Chain ID */
  chainId: number;
  /** Chain name (human-readable) */
  chainName: string;
  /** MindstateLaunchFactory — deploys token + V3 pool in one tx */
  factory: string;
  /** MindstateVault — holds V3 LP NFTs, distributes trading fees */
  vault: string;
  /** FeeCollector — platform fee treasury */
  feeCollector: string;
  /** MindstateToken implementation — ERC-20 clone template */
  implementation: string;
  /** MindstateFactory — lightweight clone factory for direct deployments */
  cloneFactory: string;
  /** WETH address on this chain */
  weth: string;
  /** Uniswap V3 Factory */
  v3Factory: string;
  /** Uniswap V3 NonfungiblePositionManager */
  positionManager: string;
  /** Owner / admin address */
  owner: string;
}

/** Base Mainnet (chain ID 8453) deployment. */
export const BASE_DEPLOYMENT: ChainDeployment = {
  chainId: 8453,
  chainName: 'Base',
  factory: '0x866B4b99be3847a9ed6Db6ce0a02946B839b735A',
  vault: '0xC5B2Dc478e75188a454e33E89bc4F768c7079068',
  feeCollector: '0x19175b230dfFAb8da216Ae29f9596Ac349755D16',
  implementation: '0x69511A29958867A96D28a15b3Ac614D1e8A4c47B',
  cloneFactory: '0x8c67b8ff38f4F497c8796AC28547FE93D1Ce1C97',
  weth: '0x4200000000000000000000000000000000000006',
  v3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
  owner: '0xCd901D8E51B263Da64E4926b1473Ecb96ccbde6d',
};

/**
 * All deployments indexed by chain ID.
 *
 * ```ts
 * import { DEPLOYMENTS } from '@mindstate/sdk';
 * const base = DEPLOYMENTS[8453];
 * ```
 */
export const DEPLOYMENTS: Record<number, ChainDeployment> = {
  [8453]: BASE_DEPLOYMENT,
};
