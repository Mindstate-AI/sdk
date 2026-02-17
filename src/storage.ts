// ============================================================================
// @mindstate/sdk — IPFS Storage Provider
// ============================================================================

import type { StorageProvider } from './types.js';

// ---------------------------------------------------------------------------
// IpfsStorage
// ---------------------------------------------------------------------------

/**
 * IPFS-backed implementation of {@link StorageProvider}.
 *
 * Uses an IPFS HTTP API for uploads and an IPFS gateway for downloads.
 *
 * @example
 * ```ts
 * const storage = new IpfsStorage({
 *   gateway: 'https://ipfs.io',
 *   apiUrl: 'http://localhost:5001',
 * });
 * const cid = await storage.upload(data);
 * const bytes = await storage.download(cid);
 * ```
 */
export class IpfsStorage implements StorageProvider {
  private readonly gateway: string;
  private readonly apiUrl: string;

  /**
   * @param options - IPFS connection options.
   * @param options.gateway - Base URL of the IPFS gateway (used for reads).
   * @param options.apiUrl - Base URL of the IPFS HTTP API (used for writes).
   *                         Defaults to `http://localhost:5001`.
   */
  constructor(options: { gateway: string; apiUrl?: string }) {
    if (!options.gateway) {
      throw new Error('Mindstate: IPFS gateway URL is required');
    }
    this.gateway = options.gateway.replace(/\/+$/, '');
    this.apiUrl = (options.apiUrl ?? 'http://localhost:5001').replace(/\/+$/, '');
  }

  /**
   * Upload raw bytes to IPFS via the HTTP API.
   *
   * @param data - The bytes to upload.
   * @returns The IPFS CID of the uploaded content.
   * @throws If the upload fails.
   */
  async upload(data: Uint8Array): Promise<string> {
    // Build multipart/form-data body
    const boundary = `----MindstateBoundary${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="capsule"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, Buffer.from(data), footer]);

    const url = `${this.apiUrl}/api/v0/add`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Mindstate: IPFS upload failed (${response.status}): ${text}`,
      );
    }

    const result = await response.json() as { Hash?: string; Name?: string };

    if (!result.Hash) {
      throw new Error('Mindstate: IPFS upload response missing Hash field');
    }

    return result.Hash;
  }

  /**
   * Download raw bytes from IPFS via the gateway.
   *
   * @param uri - The IPFS CID (with or without `ipfs://` prefix).
   * @returns The raw bytes of the content.
   * @throws If the download fails.
   */
  async download(uri: string): Promise<Uint8Array> {
    // Strip common prefixes
    const cid = uri
      .replace(/^ipfs:\/\//, '')
      .replace(/^\/ipfs\//, '')
      .trim();

    if (!cid) {
      throw new Error('Mindstate: cannot download — empty CID');
    }

    const url = `${this.gateway}/ipfs/${cid}`;

    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Mindstate: IPFS download failed (${response.status}): ${text}`,
      );
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
