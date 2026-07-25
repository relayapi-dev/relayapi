# `@relayapi/self-host`

Provision and update a private RelayAPI installation in your own Cloudflare
account. The CLI keeps RelayAPI's Workers-native architecture; it does not try
to emulate Cloudflare bindings in Docker.

```bash
mkdir my-relayapi && cd my-relayapi
bunx @relayapi/self-host init
```

`init` asks for the initial administrator email, generates strong local auth
secrets with mode 0600, and writes a small operator repository containing:

- `relayapi.selfhost.json` — non-secret Cloudflare IDs, domains, and feature flags
- `relayapi.lock.json` — the exact stable RelayAPI version to deploy
- a guarded deploy workflow that migrates before deploying
- a daily update workflow that proposes new stable versions as pull requests

Set the values shown in `.env.example`, then run:

```bash
bunx @relayapi/self-host doctor
bunx @relayapi/self-host deploy
```

For a fully automated private GitHub repository, pass `--github owner/repo` to
`init` while authenticated with `gh`. Values already present in the environment
are uploaded with `gh secret set`; their values are never placed on command
lines or in the operator config.

The deployment is intentionally forward-only. There is no `destroy` command,
and database migrations are applied under RelayAPI's migration lock before the
Workers are updated.
