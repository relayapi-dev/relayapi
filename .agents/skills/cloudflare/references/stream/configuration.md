# Stream Configuration

Setup, environment variables, and wrangler configuration.

## Installation

```bash
# Official Cloudflare SDK (Node.js, Workers, Pages)
npm install cloudflare

# React component library
npm install @cloudflare/stream-react

# TUS resumable uploads (large files)
npm install tus-js-client
```

## Environment Variables

Keep `CF_ACCOUNT_ID` and `STREAM_CUSTOMER_CODE` in ordinary configuration.
Inject `CF_API_TOKEN`, `STREAM_KEY_ID`, `STREAM_JWK`, and `WEBHOOK_SECRET`
directly from a secret manager or enter them through Wrangler's masked
interactive `secret put` prompt. Never print or commit those values.

## Wrangler Configuration

```jsonc
{
  "name": "stream-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01", // Use current date for new projects
  "vars": {
    "CF_ACCOUNT_ID": "your-account-id"
  }
  // Store secrets: wrangler secret put CF_API_TOKEN
  // wrangler secret put STREAM_KEY_ID
  // wrangler secret put STREAM_JWK
  // wrangler secret put WEBHOOK_SECRET
}
```

## Signing Keys (High Volume)

Create once for self-signing tokens (thousands of daily users).

**Create key:** Use the Stream dashboard and import the returned ID and private
JWK directly into the secret manager. For automated creation, use a trusted
secret-broker job with response logging disabled; do not print the API response
to a terminal or CI log.

**Store in secrets**
```bash
wrangler secret put STREAM_KEY_ID
wrangler secret put STREAM_JWK
```

## Webhooks

**Setup webhook URL:** Use the Stream dashboard and import the returned signing
secret directly into the secret manager. Automated setup must use a trusted
secret-broker job with response logging disabled; the API response contains the
long-lived webhook secret and must not be printed.

**Store secret**
```bash
wrangler secret put WEBHOOK_SECRET
```

## Direct Upload / Live / Watermark Config

```typescript
// Direct upload
const uploadConfig = {
  maxDurationSeconds: 3600,
  expiry: new Date(Date.now() + 3600000).toISOString(),
  requireSignedURLs: true,
  allowedOrigins: ['https://yourdomain.com'],
  meta: { creator: 'user-123' }
};

// Live input
const liveConfig = {
  recording: { mode: 'automatic', timeoutSeconds: 30 },
  deleteRecordingAfterDays: 30
};

// Watermark
const watermark = {
  name: 'Logo', opacity: 0.7, padding: 20,
  position: 'lowerRight', scale: 0.15
};
```

## Access Rules & Player Config

```typescript
// Access rules: allow US/CA, block CN/RU, or IP allowlist
const geoRestrict = [
  { type: 'ip.geoip.country', action: 'allow', country: ['US', 'CA'] },
  { type: 'any', action: 'block' }
];

// Player params for iframe
const playerParams = new URLSearchParams({
  autoplay: 'true', muted: 'true', preload: 'auto', defaultTextTrack: 'en'
});
```

## In This Reference

- [README.md](./README.md) - Overview and quick start
- [api.md](./api.md) - On-demand video APIs
- [api-live.md](./api-live.md) - Live streaming APIs
- [patterns.md](./patterns.md) - Full-stack flows, best practices
- [gotchas.md](./gotchas.md) - Error codes, troubleshooting

## See Also

- [wrangler](../wrangler/) - Wrangler CLI and configuration
- [workers](../workers/) - Deploy Stream APIs in Workers
