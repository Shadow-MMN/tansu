# IPFS Delegation Worker

Cloudflare Worker that verifies a signed upload authorization and then uploads
the CAR file to Filebase and Pinata in parallel.

## API

```json
POST /
{
  "cid": "<expected-root-cid>",
  "message": "Tansu IPFS upload authorization\nCID: <expected-root-cid>",
  "signature": "<base64-signature>",
  "signerAddress": "G...",
  "car": "<base64-car-bytes>"
}
```

The worker verifies that the message signature matches `signerAddress` and that
the signed message contains the CID being uploaded.

## Returns JSON

```json
{
  "success": true,
  "filebase": true,
  "pinata": true,
  "cid": "<cid>",
  "providers": {
    "filebase": { "ok": true, "name": "filebase" },
    "pinata": { "ok": true, "name": "pinata" }
  }
}
```

- If both providers fail, `success` is `false` and the HTTP status is `502`.
- If one provider fails, the request still succeeds as long as the content is
  pinned by the other provider.

## Development

Add your provider tokens to `.dev.vars`:

```bash
FILEBASE_TOKEN=<filebase_api_token>
PINATA_JWT=<pinata_jwt>
```

### Start the Worker

```bash
cd dapp/workers/ipfs-delegation
bun install
bun run dev
```

### Test the Worker

In another terminal:

```bash
cd dapp/workers/ipfs-delegation
bun run test
```

Or against deployed environments (see next section):

```bash
ENV=DEV bun run test  # Use testnet environment
ENV=PROD bun run test # Use production environment
```

## Deployment

### Prerequisites

```bash
bunx wrangler login
```

### Security

All secrets are stored in Cloudflare Secrets. Set them with wrangler:

```bash
# Development
bunx wrangler secret put FILEBASE_TOKEN --env testnet
bunx wrangler secret put PINATA_JWT --env testnet

# Production
bunx wrangler secret put FILEBASE_TOKEN --env production
bunx wrangler secret put PINATA_JWT --env production
```

### Development (Testnet)

```bash
bunx wrangler deploy --env testnet
```

Deploys to `https://ipfs-testnet.tansu.dev`

### Production (Mainnet)

```bash
bunx wrangler deploy --env production
```

Deploys to `https://ipfs.tansu.dev`
