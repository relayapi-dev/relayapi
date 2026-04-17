# @relayapi/mcp-server

Model Context Protocol server exposing the RelayAPI automations API to AI agents (Claude Code, Claude Desktop, any MCP-compatible client).

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
| `relayapi_get_automation_schema` | `sdk.automations.schema()` |
| `relayapi_list_automations` | `sdk.automations.list(query)` |
| `relayapi_get_automation` | `sdk.automations.retrieve(id)` |
| `relayapi_create_automation` | `sdk.automations.create(body)` |
| `relayapi_update_automation` | `sdk.automations.update(id, body)` |
| `relayapi_delete_automation` | `sdk.automations.delete(id)` |
| `relayapi_publish_automation` | `sdk.automations.publish(id)` |
| `relayapi_pause_automation` | `sdk.automations.pause(id)` |
| `relayapi_resume_automation` | `sdk.automations.resume(id)` |
| `relayapi_archive_automation` | `sdk.automations.archive(id)` |
| `relayapi_list_automation_enrollments` | `sdk.automations.listEnrollments(id, query)` |
| `relayapi_list_automation_runs` | `sdk.automations.listRuns(id, enrollmentId)` |
| `relayapi_simulate_automation` | `sdk.automations.simulate(id, body)` |
| `relayapi_create_automation_from_template` | `sdk.automations.templates.<id>(input)` |

Agents should call `relayapi_get_automation_schema` first so enum values (trigger types, node types, template IDs) are never guessed.

## Transports

- **stdio** — default and currently only supported transport.
- **http (Streamable-HTTP)** — planned. Intended for Claude API Managed Agents. Open an issue if you need it.

## Errors

Tool failures return `{ isError: true, content: [{ type: "text", text: "Error: ..." }] }`. The RelayAPI server returns structured `{ error: { code, message, suggestion? } }` bodies for validation errors — unknown trigger types and node types include Levenshtein-based suggestions.
