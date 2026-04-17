# Publishing the RelayAPI Cursor Plugin

## Prerequisites

- Cursor 2.5+ installed
- A public GitHub repository for the plugin

> **Note:** Only publish the `packages/integrations/cursor-plugin/` subdirectory — not the full monorepo. Copy the plugin to a separate, dedicated public repository.

## Option A: Cursor Marketplace (Recommended)

### 1. Validate plugin structure

Ensure the plugin follows the required structure:
- `.cursor-plugin/plugin.json` exists with valid `name` (kebab-case)
- All skills have `SKILL.md` with `name` and `description` frontmatter
- All rules have `.mdc` files with `description` and `alwaysApply` frontmatter
- All agents and commands have proper frontmatter
- All manifest paths are relative (start with `./`)
- No `..` or absolute paths

### 2. Push to a public GitHub repository

The plugin must be in a public Git repository. You can either:
- Host in a dedicated repo (e.g., `github.com/majestico/relayapi-cursor-plugin`)
- Or use a multi-plugin marketplace repo

### 3. Submit to the Cursor Marketplace

Go to: https://cursor.com/marketplace/publish

Provide your repository link. The submission requires:
- Valid `.cursor-plugin/plugin.json` manifest
- Unique, lowercase, kebab-case plugin name
- Clear description explaining plugin purpose
- All rules/skills/agents/commands with proper YAML frontmatter
- Logo committed to repo with relative path (optional but recommended)
- `README.md` documenting usage and configuration

### 4. Wait for review

Cursor reviews submissions before listing in the marketplace.

## Option B: Self-hosted Marketplace

### 1. Create a marketplace repository

```
relayapi-cursor-plugins/
├── .cursor-plugin/
│   └── marketplace.json
└── relayapi/
    ├── .cursor-plugin/
    │   └── plugin.json
    ├── skills/
    ├── rules/
    ├── agents/
    └── commands/
```

### 2. Create marketplace.json

Create `.cursor-plugin/marketplace.json` at the repo root:

```json
{
  "name": "relayapi-plugins",
  "owner": {
    "name": "RelayAPI",
    "email": "support@relayapi.com"
  },
  "metadata": {
    "description": "RelayAPI plugins for Cursor"
  },
  "plugins": [
    {
      "name": "relayapi",
      "source": "relayapi",
      "description": "Post to 21 platforms via a single unified API"
    }
  ]
}
```

### 3. Users install via Cursor

Users add the marketplace and install the plugin through Cursor's plugin UI.

## Option C: Team Distribution (Admin Marketplace)

On Cursor Teams and Enterprise plans, admins can create team marketplaces for controlled distribution of private plugins.

## Local Testing

### Test plugin directly

Copy the plugin to your project:

```bash
cp -R ./packages/integrations/cursor-plugin ./.cursor-plugin-test
```

Or add skills directly to your project:

```bash
mkdir -p .cursor/skills
cp -R ./packages/integrations/cursor-plugin/skills/* .cursor/skills/

mkdir -p .cursor/rules
cp ./packages/integrations/cursor-plugin/rules/*.mdc .cursor/rules/
```

### Test components

After installation, verify:
- Skills appear when typing `/` in the command palette
- Rules are applied when editing matching files (`.ts`, `.tsx`, `.js`, `.jsx`)
- Agent is available for delegation

## Updating

1. Update content in `skills/`, `rules/`, `agents/`, `commands/`
2. Bump `version` in `.cursor-plugin/plugin.json`
3. Push to the repository
4. Users receive updates through the marketplace

## Important Notes

- The `.mdc` rules format is unique to Cursor — these files provide persistent AI guidance
- Rules with `alwaysApply: true` are loaded for every file; `false` requires explicit request
- The `globs` field restricts rules to matching file patterns
- Skills use `RELAYAPI_API_KEY` env var — users must set it before use
- Plugin names must be kebab-case, starting and ending with alphanumeric characters
- Max 500 plugins per marketplace
