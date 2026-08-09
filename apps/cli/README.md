# @relayapi/cli

The official RelayAPI command-line client.

Requires Node.js 22.12 or newer.

## Install

```sh
npm install --global @relayapi/cli
relay --help
```

Configure an API key with `relay auth set-key`, or set
`RELAYAPI_API_KEY=rlay_live_...` in the environment. Saved credentials live in
`~/.relayapi/config.json`; the CLI enforces `0700` on the directory and `0600`
on the file.

## Webhooks

Manage customer webhook endpoints using the operations supported by the API:

```sh
# The signing secret is returned only once. Store it securely.
relay webhooks create \
  --url https://example.com/relay-events \
  --events post.published,post.failed

relay webhooks list
relay webhooks get wh_example
relay webhooks update wh_example --events post.published --enabled
relay webhooks test wh_example
relay webhooks logs
relay webhooks rotate-secret wh_example
relay webhooks delete wh_example
```

Use `--workspace ws_example` with `create`, `list`, or `get` when you need an
explicit workspace scope. Because the API has no single-endpoint read route,
`get` safely pages the authorized endpoint list until it finds the requested
ID. `relay webhooks logs` (alias: `deliveries`) returns the delivery and test
attempt records retained by the API for the last seven days. The API does not
currently expose manual redelivery or a local webhook listener, so the CLI does
not claim or emulate those operations.
