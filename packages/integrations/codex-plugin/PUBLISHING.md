# Publishing the RelayAPI OpenAI Codex Plugin

## Prerequisites

- OpenAI Codex CLI installed
- A public GitHub repository for the plugin

> **Note:** Only publish the `packages/integrations/codex-plugin/` subdirectory — not the full monorepo. Copy the plugin to a separate, dedicated public repository.

## Current Status

Self-serve plugin publishing to the official Codex Plugin Directory is **coming soon** (as of March 2026). For now, plugins are distributed via local or repo-scoped marketplaces.

## Option A: Repository Marketplace (Team distribution)

### 1. Copy the plugin to your project

```bash
mkdir -p ./plugins
cp -R ./packages/integrations/codex-plugin ./plugins/relayapi
```

### 2. Create a marketplace manifest

Create `$REPO_ROOT/.agents/plugins/marketplace.json`:

```json
{
  "name": "relayapi-plugins",
  "interface": {
    "displayName": "RelayAPI Plugins"
  },
  "plugins": [
    {
      "name": "relayapi",
      "source": {
        "source": "local",
        "path": "./plugins/relayapi"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

### 3. Restart Codex

Codex discovers the marketplace on restart. Team members cloning the repo get access automatically.

## Option B: Personal Installation

### 1. Copy to your Codex plugins directory

```bash
mkdir -p ~/.codex/plugins
cp -R ./packages/integrations/codex-plugin ~/.codex/plugins/relayapi
```

### 2. Add to personal marketplace

Create or update `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "personal-plugins",
  "interface": {
    "displayName": "My Plugins"
  },
  "plugins": [
    {
      "name": "relayapi",
      "source": {
        "source": "local",
        "path": "~/.codex/plugins/relayapi"
      },
      "policy": {
        "installation": "INSTALLED_BY_DEFAULT"
      },
      "category": "Productivity"
    }
  ]
}
```

### 3. Restart Codex

The plugin and its skills become available immediately.

## Option C: Official Plugin Directory (Coming Soon)

When self-serve publishing launches:

1. Ensure plugin passes validation
2. Push to a public GitHub repository
3. Submit through the Codex Plugin Directory

## Local Testing

### Test skills directly

Place the skills in your project's `.agents/skills/` directory:

```bash
cp -R ./packages/integrations/codex-plugin/skills/* ./.agents/skills/
```

Then use in Codex:
- `$relayapi` — invoke the full RelayAPI skill
- `$social-post` — invoke the post composer

### Test as a plugin

Use the `$plugin-creator` built-in skill for guided setup, or manually install per Option B above.

## Updating

1. Update skill content in `skills/*/SKILL.md`
2. Bump `version` in `.codex-plugin/plugin.json`
3. Re-copy to the target location (repo or personal)
4. Restart Codex

## Important Notes

- The `interface` object in `plugin.json` controls marketplace display (displayName, brandColor, etc.)
- The `agents/openai.yaml` file per skill controls UI presentation and implicit invocation policy
- Skills use `RELAYAPI_API_KEY` env var — users must set it before use
- Plugin names must be kebab-case
- Codex follows symlinked skill folders
