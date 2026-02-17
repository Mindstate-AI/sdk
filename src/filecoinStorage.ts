// ============================================================================
// @mindstate/sdk — Filecoin Storage Provider (Warm Tier)
// ============================================================================

import type { StorageProvider } from './types.js';

// ---------------------------------------------------------------------------
// FilecoinStorage
// ---------------------------------------------------------------------------

/**
 * Filecoin-backed implementation of {@link StorageProvider}.
 *
 * Designed for the **warm tier** — production snapshots, compliance archives,
 * and data with defined retention periods (6–24 months, renewable).
 *
 * Uploads go to a Filecoin deal service (e.g. Lighthouse, web3.storage) that
 * pins content and creates Filecoin storage deals. Downloads go through a
 * gateway (typically IPFS-compatible, since Filecoin stores IPFS CIDs).
 *
 * Returned URIs use the `fil://` scheme prefix to distinguish Filecoin-backed
 * storage from unpinned IPFS, even though the underlying CID format is shared.
 *
 * @example
 * ```ts
 * const storage = new FilecoinStorage({
 *   gateway: 'https://gateway.lighthouse.storage',
 *   apiUrl: 'https://node.lighthouse.storage',
 *   apiToken: 'your-api-key',
 * });
 * const uri = await storage.upload(data);   // => "fil://bafy..."
 * const bytes = await storage.download(uri);
 * ```
 */
export class FilecoinStorage implements StorageProvider {
  private readonly gateway: string;
  private readonly apiUrl: string;
  private readonly apiToken?: string;

  /**
   * @param options - Filecoin service connection options.
   * @param options.gateway  - Base URL of the download gateway. Many Filecoin
   *                           services expose an IPFS-compatible gateway.
   * @param options.apiUrl   - Base URL of the Filecoin deal/upload API.
   * @param options.apiToken - API token for authenticated uploads.
   */
  constructor(options: { gateway: string; apiUrl: string; apiToken?: string }) {
    if (!options.gateway) {
      throw new Error('Mindstate: Filecoin gateway URL is required');
    }
    if (!options.apiUrl) {
      throw new Error('Mindstate: Filecoin API URL is required');
    }
    this.gateway = options.gateway.replace(/\/+$/, '');
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.apiToken = options.apiToken;
  }

  /**
   * Upload raw bytes to Filecoin via the deal/upload service API.
   *
   * The service is expected to accept multipart form-data uploads and return
   * a CID in the response (compatible with Lighthouse, web3.storage, etc.).
   *
   * @param data - The bytes to upload.
   * @returns A `fil://`-prefixed CID.
   * @throws If the upload fails.
   */
  async upload(data: Uint8Array): Promise<string> {
    const boundary = `----MindstateBoundary${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="capsule"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, Buffer.from(data), footer]);

    const url = `${this.apiUrl}/api/v0/add`;

    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Mindstate: Filecoin upload failed (${response.status}): ${text}`,
      );
    }

    const result = await response.json() as { Hash?: string; cid?: string };
    const cid = result.Hash ?? result.cid;

    if (!cid) {
      throw new Error('Mindstate: Filecoin upload response missing CID');
    }

    return `fil://${cid}`;
  }

  /**
   * Download raw bytes from the Filecoin gateway.
   *
   * Accepts URIs with `fil://` prefix, bare CIDs, or IPFS-style paths.
   * Most Filecoin gateways serve content via IPFS-compatible endpoints.
   *
   * @param uri - The CID (with or without `fil://` prefix).
   * @returns The raw bytes of the content.
   * @throws If the download fails.
   */
  async download(uri: string): Promise<Uint8Array> {
    const cid = uri
      .replace(/^fil:\/\//, '')
      .replace(/^ipfs:\/\//, '')
      .replace(/^\/ipfs\//, '')
      .trim();

    if (!cid) {
      throw new Error('Mindstate: cannot download — empty Filecoin CID');
    }

    const url = `${this.gateway}/ipfs/${cid}`;

    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Mindstate: Filecoin download failed (${response.status}): ${text}`,
      );
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
