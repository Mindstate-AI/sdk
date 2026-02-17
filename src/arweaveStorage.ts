// ============================================================================
// @mindstate/sdk — Arweave Storage Provider (Cold Tier)
// ============================================================================

import type { StorageProvider } from './types.js';

// ---------------------------------------------------------------------------
// ArweaveStorage
// ---------------------------------------------------------------------------

/**
 * Arweave-backed implementation of {@link StorageProvider}.
 *
 * Designed for the **cold tier** — canonical releases, genesis states, and
 * data that should persist indefinitely via Arweave's endowment model.
 *
 * Uploads go to a bundler/upload service HTTP API (e.g. Irys, ArDrive Turbo).
 * Downloads go through an Arweave gateway.
 *
 * Returned URIs use the `ar://` scheme prefix.
 *
 * @example
 * ```ts
 * const storage = new ArweaveStorage({
 *   gateway: 'https://arweave.net',
 *   apiUrl: 'https://node1.irys.xyz',
 *   apiToken: 'your-auth-token',
 * });
 * const uri = await storage.upload(data);   // => "ar://aBcD1234..."
 * const bytes = await storage.download(uri);
 * ```
 */
export class ArweaveStorage implements StorageProvider {
  private readonly gateway: string;
  private readonly apiUrl: string;
  private readonly apiToken?: string;

  /**
   * @param options - Arweave connection options.
   * @param options.gateway  - Base URL of the Arweave gateway (used for reads).
   *                           Defaults to `https://arweave.net`.
   * @param options.apiUrl   - Base URL of the upload/bundler service (used for writes).
   *                           e.g. Irys (`https://node1.irys.xyz`), ArDrive Turbo, etc.
   * @param options.apiToken - Optional auth token for the upload API.
   */
  constructor(options: { gateway?: string; apiUrl: string; apiToken?: string }) {
    if (!options.apiUrl) {
      throw new Error('Mindstate: Arweave upload API URL is required');
    }
    this.gateway = (options.gateway ?? 'https://arweave.net').replace(/\/+$/, '');
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.apiToken = options.apiToken;
  }

  /**
   * Upload raw bytes to Arweave via the configured bundler/upload API.
   *
   * @param data - The bytes to upload.
   * @returns An `ar://`-prefixed transaction ID.
   * @throws If the upload fails.
   */
  async upload(data: Uint8Array): Promise<string> {
    const url = `${this.apiUrl}/upload`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: data,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Mindstate: Arweave upload failed (${response.status}): ${text}`,
      );
    }

    const result = await response.json() as { id?: string; txId?: string };
    const txId = result.id ?? result.txId;

    if (!txId) {
      throw new Error('Mindstate: Arweave upload response missing transaction ID');
    }

    return `ar://${txId}`;
  }

  /**
   * Download raw bytes from Arweave via the gateway.
   *
   * @param uri - The Arweave transaction ID (with or without `ar://` prefix).
   * @returns The raw bytes of the content.
   * @throws If the download fails.
   */
  async download(uri: string): Promise<Uint8Array> {
    const txId = uri
      .replace(/^ar:\/\//, '')
      .trim();

    if (!txId) {
      throw new Error('Mindstate: cannot download — empty Arweave transaction ID');
    }

    const url = `${this.gateway}/${txId}`;

    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Mindstate: Arweave download failed (${response.status}): ${text}`,
      );
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
