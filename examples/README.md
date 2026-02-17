# Mindstate Examples

## On-Chain Auto-Fulfillment Watcher

A local script that watches for `Redeemed` events and automatically delivers decryption keys via the contract’s `deliverKeyEnvelope()`. Consumers use the **Fetch & Decrypt** flow on the redeem page to retrieve keys from the contract.

**File:** `auto-fulfiller-onchain.ts`

---

### What You Need

1. **Environment variables** — token address, RPC URL, and your keys
2. **Key store file** — checkpoint IDs mapped to content keys (from when you published)
3. **Optional:** `CREATED_AT_BLOCK` — for catch-up on startup

---

### 1. Environment Variables

Create a `.env` file in the `sdk` directory (or export them in your shell):

| Variable | Required | Description |
|----------|----------|-------------|
| `MINDSTATE_TOKEN` | Yes | Your token contract address (e.g. `0xC21...`) |
| `RPC_URL` | Yes | JSON-RPC endpoint (e.g. `https://mainnet.base.org`) |
| `PUBLISHER_KEY` | Yes | Your Ethereum wallet **private key** (0x + 64 hex chars) |
| `PUBLISHER_X25519` | Yes | Your publisher X25519 **secret key** (64 hex chars). Same key used when publishing checkpoints. |
| `CREATED_AT_BLOCK` | No | Block at which the token was deployed. Enables catch-up on boot. Get from Basescan "Contract Creation". |
| `KEY_STORE_PATH` | No | Path to key store JSON (default: `.mindstate-keys.json`) |

**Example `.env`:**

```env
MINDSTATE_TOKEN=0xC21CD7974207fD5B2d3099c1C48c4706746bB96B
RPC_URL=https://mainnet.base.org
PUBLISHER_KEY=0x...
PUBLISHER_X25519=0x...
CREATED_AT_BLOCK=12345678
```

---

### 2. Key Store File (`.mindstate-keys.json`)

Create this file in the `sdk` directory (or wherever you run the script). It maps each checkpoint ID to its content encryption key.

```json
{
  "0xf8255c83c02446a7afad97bec23eee70e45eff7327b6b8d157ad2baaf7d2a417": "0x<content-key-hex>",
  "0x93373fcd81e17a42818f658d34d2994fa12e147e023c03e14807ed24cee93473": "0x<content-key-hex>"
}
```

**Where to get these values:**

- **Checkpoint ID** — From the redeem page (Select Checkpoint list) or the publish transaction / contract
- **Content key** — Shown after publishing a checkpoint on the Manage dashboard. Copy it when you publish and add it here.

Every time you publish a new checkpoint, add a new entry to this file.

---

### 3. Run the Watcher

From the repo root:

```bash
cd sdk
npx tsx examples/auto-fulfiller-onchain.ts
```

**With `.env` loaded (PowerShell):**

```powershell
cd sdk
Get-Content .env | ForEach-Object {
  if ($_ -match '^([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
  }
}
npx tsx examples/auto-fulfiller-onchain.ts
```

**Or with dotenv-cli:**

```bash
cd sdk
npx dotenv -e .env -- npx tsx examples/auto-fulfiller-onchain.ts
```

---

### What It Does

1. **On startup** — If `CREATED_AT_BLOCK` is set, fetches all `Redeemed` events from that block to now, checks which are already delivered, and fulfills any that aren’t.
2. **While running** — Listens for new `Redeemed` events and delivers keys immediately.
3. **On Ctrl+C** — Exits cleanly.

Keys stay local. The script only sends signed `deliverKeyEnvelope()` transactions to the chain.

---

### Troubleshooting

| Problem | Likely cause |
|---------|--------------|
| "No key for checkpoint" | Missing or incorrect entry in `.mindstate-keys.json` for that checkpoint. Publish the key you saved when publishing. |
| "Consumer has no encryption key" | Consumer hasn’t registered an X25519 public key on-chain yet. They need to use "Register Key" on the redeem page first. |
| "Wallet is not the publisher" | The private key you used isn’t the token’s publisher address. |
| Catch-up is slow | Large block range. Set `CREATED_AT_BLOCK` closer to your first checkpoint publish to reduce the range. |
