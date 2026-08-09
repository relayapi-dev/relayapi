# @relayapi/mcp-server

Model Context Protocol server exposing the RelayAPI automations API to AI agents (Claude Code, Claude Desktop, any MCP-compatible client).

Requires Node.js 18 or newer. This package is an executable MCP server, not an
importable library entrypoint.

## Install

```bash
npm install -g @relayapi/mcp-server
```

Or run directly via npx:

```bash
npx @relayapi/mcp-server stdio
```

## Configure

```bash
export RELAYAPI_KEY=rlay_live_...                    # required
export RELAYAPI_BASE_URL=https://api.relayapi.dev    # optional override
```

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "relayapi": {
      "command": "npx",
      "args": ["-y", "@relayapi/mcp-server", "stdio"],
      "env": {
        "RELAYAPI_KEY": "rlay_live_..."
      }
    }
  }
}
```

## Tools

Each tool is a thin wrapper over the TypeScript SDK. The tool description tells the model which SDK method it maps to.

| Tool | SDK method |
| --- | --- |
| `relayapi_get_automation_schema` | `sdk.automations.catalog()` |
| `relayapi_list_automations` | `sdk.automations.list(query)` |
| `relayapi_get_automation` | `sdk.automations.retrieve(id)` |
| `relayapi_create_automation` | `sdk.automations.create(body)` |
| `relayapi_update_automation` | `sdk.automations.update(id, body)` |
| `relayapi_delete_automation` | `sdk.automations.delete(id)` |
| `relayapi_activate_automation` | `sdk.automations.activate(id)` |
| `relayapi_pause_automation` | `sdk.automations.pause(id)` |
| `relayapi_resume_automation` | `sdk.automations.resume(id)` |
| `relayapi_archive_automation` | `sdk.automations.archive(id)` |
| `relayapi_list_automation_runs` | `sdk.automationRuns.list(id, query)` |
| `relayapi_list_automation_run_steps` | `sdk.automationRuns.listSteps(runId, query)` |
| `relayapi_simulate_automation` | `sdk.automations.simulate(id, body)` |
| `relayapi_create_automation_from_template` | `sdk.automations.create({ template })` |

Agents should call `relayapi_get_automation_schema` first so enum values (trigger types, node types, template IDs) are never guessed.

## Transports

- **stdio** — default, for local MCP clients.
- **http** — stateless Streamable HTTP, for remote MCP clients.

Start the HTTP server on its secure loopback default:

```bash
npx @relayapi/mcp-server http
# http://127.0.0.1:3000/mcp
```

HTTP configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAYAPI_MCP_HOST` | `127.0.0.1` | Bind address |
| `RELAYAPI_MCP_PORT` | `3000` | Listen port |
| `RELAYAPI_MCP_PATH` | `/mcp` | MCP endpoint path |
| `RELAYAPI_MCP_ALLOWED_HOSTS` | loopback hostnames | Comma-separated Host-header allowlist, without ports |
| `RELAYAPI_MCP_AUTH_TOKEN` | none on loopback | Bearer token used to authenticate MCP clients |

MCP POST requests must use `Content-Type: application/json`. Native clients may
omit `Origin`; browser requests are accepted only when the Origin hostname is
also in the Host allowlist. This prevents an unrelated website from driving an
unauthenticated loopback server.

Non-loopback binding fails closed unless both an explicit Host-header allowlist
and a separate bearer token of at least 32 characters are configured:

```bash
export RELAYAPI_MCP_HOST=0.0.0.0
export RELAYAPI_MCP_ALLOWED_HOSTS=mcp.example.com
export RELAYAPI_MCP_AUTH_TOKEN='replace-with-a-random-32-character-or-longer-secret'
npx @relayapi/mcp-server http
```

Send the token as `Authorization: Bearer <token>`. Terminate TLS at a trusted
reverse proxy when exposing the endpoint outside the host. `GET /healthz` is an
unauthenticated liveness check, still protected by the Host allowlist.

## Errors

Tool failures return `{ isError: true, content: [{ type: "text", text: "Error: ..." }] }`. The RelayAPI server returns structured `{ error: { code, message, suggestion? } }` bodies for validation errors — unknown trigger types and node types include Levenshtein-based suggestions.
