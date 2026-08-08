# Configuration

See [README.md](./README.md) for overview.

## Create Config

Create PostgreSQL and MySQL configurations in **Workers & Pages → Hyperdrive**
in the Cloudflare dashboard. Its masked form accepts the database connection
details without placing passwords or credentialed URLs in shell history or
process argv. After creation, non-secret cache settings can be changed safely:

```bash
npx wrangler hyperdrive update <ID> --max-age=120 --swr=30
# Or disable caching:
npx wrangler hyperdrive update <ID> --caching-disabled=true
```

## wrangler.jsonc

```jsonc
{
  "compatibility_date": "2025-01-01", // Use latest for new projects
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<HYPERDRIVE_ID>"
    }
  ]
}
```

**Generate TypeScript types:** Run `npx wrangler types` to auto-generate `worker-configuration.d.ts` from your wrangler.jsonc.

**Multiple configs:**
```jsonc
{
  "hyperdrive": [
    {"binding": "HYPERDRIVE_CACHED", "id": "<ID1>"},
    {"binding": "HYPERDRIVE_NO_CACHE", "id": "<ID2>"}
  ]
}
```

## Management

```bash
npx wrangler hyperdrive list
npx wrangler hyperdrive get <ID>
npx wrangler hyperdrive update <ID> --max-age=180
npx wrangler hyperdrive delete <ID>
```

## Config Options

Hyperdrive create/update CLI flags:

| Option | Default | Notes |
|--------|---------|-------|
| `--caching-disabled` | `false` | Disable caching |
| `--max-age` | `60` | Cache TTL (max 3600s) |
| `--swr` | `15` | Stale-while-revalidate |
| `--origin-connection-limit` | 20/100 | Free/paid |
| `--access-client-id` | - | Tunnel auth |
| `--access-client-secret` | - | Tunnel auth |
| `--sslmode` | `require` | PostgreSQL only |

## Smart Placement Integration

For Workers making **multiple queries** per request, enable Smart Placement to execute near your database:

```jsonc
{
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "placement": {
    "mode": "smart"
  },
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<HYPERDRIVE_ID>"
    }
  ]
}
```

**Benefits:** Multi-query Workers run closer to DB, reducing round-trip latency. See [patterns.md](./patterns.md) for examples.

## Private DB via Tunnel

```
Worker → Hyperdrive → Access → Tunnel → Private Network → DB
```

**Setup:**
```bash
# 1. Create tunnel
cloudflared tunnel create my-db-tunnel

# 2. Configure hostname in Zero Trust dashboard
#    Domain: db-tunnel.example.com
#    Service: TCP -> localhost:5432

# 3. Create service token (Zero Trust > Service Auth)
#    Save Client ID/Secret

# 4. Create Access app (db-tunnel.example.com)
#    Policy: Service Auth token from step 3

# 5. Create Hyperdrive in the Cloudflare dashboard. Enter the database password
#    and Access service-token secret in the masked form fields; do not pass
#    either credential through shell argv or paste a credentialed URL into logs.
```

**⚠️ Don't specify `--port` with Tunnel** - port configured in tunnel service settings.

## Local Dev

**Option 1: Local (RECOMMENDED):**
```bash
# This ignored mode-0600 file is provisioned by your secret manager and exports
# CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE. Never print or
# commit it, and do not type a credentialed URL into a shell command.
. /secure/hyperdrive-local-env
npx wrangler dev
```

**Remote DB locally:**
Use the same secret-manager-provisioned environment file with the appropriate
TLS-enabled PostgreSQL or MySQL URL. Prefer a local tunnel and loopback URL over
opening a remote database directly.

**Option 2: Remote execution:**
```bash
npx wrangler dev --remote  # Uses deployed config, affects production
```

See [api.md](./api.md), [patterns.md](./patterns.md), [gotchas.md](./gotchas.md).
