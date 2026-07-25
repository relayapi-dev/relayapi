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
