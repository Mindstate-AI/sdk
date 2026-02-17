// ============================================================================
// @mindstate/sdk — Storage Router (Multi-Backend Dispatch)
// ============================================================================

import type { StorageProvider } from './types.js';

// ---------------------------------------------------------------------------
// Storage Backend Detection
// ---------------------------------------------------------------------------

/** Recognized storage backend identifiers. */
export type StorageBackend = 'ipfs' | 'arweave' | 'filecoin' | 'http' | 'unknown';

/**
 * Parse a storage URI to determine which backend it belongs to.
 *
 * Detection rules (in priority order):
 * 1. `ar://`   → arweave
 * 2. `ipfs://` → ipfs
 * 3. `fil://`  → filecoin
 * 4. `http://` or `https://` → http
 * 5. Bare IPFS CIDv0 (`Qm...`) or CIDv1 (`bafy...`) → ipfs
 * 6. Otherwise → unknown
 *
 * @param uri - The storage URI to classify.
 * @returns The detected {@link StorageBackend}.
 */
export function parseStorageBackend(uri: string): StorageBackend {
  if (!uri) return 'unknown';

  const trimmed = uri.trim();

  if (trimmed.startsWith('ar://')) return 'arweave';
  if (trimmed.startsWith('ipfs://')) return 'ipfs';
  if (trimmed.startsWith('fil://')) return 'filecoin';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'http';

  // Bare IPFS CID heuristics
  // CIDv0: starts with "Qm" followed by 44 base58 chars
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}/.test(trimmed)) return 'ipfs';
  // CIDv1 (base32): starts with "bafy" (dag-pb) or "bafk" (raw)
  if (/^baf[yk][a-z2-7]+/.test(trimmed)) return 'ipfs';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Storage Router
// ---------------------------------------------------------------------------

/**
 * Multi-backend storage router implementing {@link StorageProvider}.
 *
 * Routes `download()` calls to the correct backend based on URI scheme,
 * and delegates `upload()` to a configurable default provider.
 *
 * This enables transparent multi-tier storage: a consumer can download
 * from any backend (IPFS, Arweave, Filecoin) regardless of where the
 * publisher originally uploaded the data.
 *
 * @example
 * ```ts
 * const router = new StorageRouter({
 *   default: ipfsStorage,
 *   providers: {
 *     ipfs: ipfsStorage,
 *     arweave: arweaveStorage,
 *     filecoin: filecoinStorage,
 *   },
 * });
 *
 * // Upload goes to default provider (IPFS)
 * const uri = await router.upload(data);
 *
 * // Download auto-routes by URI scheme
 * const bytes1 = await router.download('Qm...');          // → IPFS
 * const bytes2 = await router.download('ar://aBcD...');    // → Arweave
 * const bytes3 = await router.download('fil://bafy...');   // → Filecoin
 * ```
 */
export class StorageRouter implements StorageProvider {
  private readonly providers: Map<StorageBackend, StorageProvider>;
  private defaultProvider: StorageProvider;

  /**
   * @param options - Router configuration.
   * @param options.default   - The default provider used for `upload()` calls.
   * @param options.providers - Map of backend name to provider instance.
   *                            At minimum, the default provider's backend should be included.
   */
  constructor(options: {
    default: StorageProvider;
    providers?: Partial<Record<StorageBackend, StorageProvider>>;
  }) {
    this.defaultProvider = options.default;
    this.providers = new Map();

    if (options.providers) {
      for (const [backend, provider] of Object.entries(options.providers)) {
        if (provider) {
          this.providers.set(backend as StorageBackend, provider);
        }
      }
    }
  }

  /**
   * Register a storage provider for a specific backend.
   *
   * @param backend  - The backend identifier (e.g. 'ipfs', 'arweave', 'filecoin').
   * @param provider - The provider instance.
   */
  register(backend: StorageBackend, provider: StorageProvider): void {
    this.providers.set(backend, provider);
  }

  /**
   * Change the default upload provider.
   *
   * @param provider - The new default provider for uploads.
   */
  setDefaultProvider(provider: StorageProvider): void {
    this.defaultProvider = provider;
  }

  /**
   * Upload data using the default provider.
   *
   * @param data - The bytes to upload.
   * @returns The storage URI from the default provider.
   */
  async upload(data: Uint8Array): Promise<string> {
    return this.defaultProvider.upload(data);
  }

  /**
   * Download data by routing to the correct backend based on URI scheme.
   *
   * If no provider is registered for the detected backend, falls back
   * to the default provider.
   *
   * @param uri - The storage URI (auto-detected backend from scheme).
   * @returns The raw bytes of the content.
   * @throws If the download fails.
   */
  async download(uri: string): Promise<Uint8Array> {
    const backend = parseStorageBackend(uri);
    const provider = this.providers.get(backend) ?? this.defaultProvider;
    return provider.download(uri);
  }

  /**
   * Get the provider registered for a specific backend.
   *
   * @param backend - The backend identifier.
   * @returns The provider, or undefined if not registered.
   */
  getProvider(backend: StorageBackend): StorageProvider | undefined {
    return this.providers.get(backend);
  }

  /**
   * Check whether a provider is registered for a given backend.
   *
   * @param backend - The backend identifier.
   */
  hasProvider(backend: StorageBackend): boolean {
    return this.providers.has(backend);
  }
}
