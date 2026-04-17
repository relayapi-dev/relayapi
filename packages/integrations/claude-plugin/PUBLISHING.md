# Publishing the RelayAPI Claude Code Plugin

## Prerequisites

- Claude Code v1.0.33+ installed: `npm install -g @anthropic-ai/claude-code`
- A public GitHub repository for the plugin

> **Note:** Only publish the `packages/integrations/claude-plugin/` subdirectory — not the full monorepo. Use `git-subdir` source in marketplace config or copy the plugin to a separate, dedicated public repository.

## Option A: Official Anthropic Marketplace (Recommended)

### 1. Validate the plugin

```bash
claude plugin validate ./packages/integrations/claude-plugin
```

### 2. Push to a public GitHub repository

The plugin directory must be publicly accessible. You can either:
- Host it in a dedicated repo (e.g., `github.com/majestico/relayapi-claude-plugin`)
- Or keep it in the monorepo and use `git-subdir` source in the marketplace

### 3. Submit for review

Submit at one of:
- **Claude.ai**: https://claude.ai/settings/plugins/submit
- **Console**: https://platform.claude.com/plugins/submit

Provide the repository link and plugin path.

### 4. Wait for review

Anthropic reviews submissions for quality and security before listing.

## Option B: Self-hosted Git Marketplace

### 1. Create a marketplace repository

Create a new repo (e.g., `github.com/majestico/relayapi-plugins`) with this structure:

```
relayapi-plugins/
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    └── relayapi/
        ├── .claude-plugin/
        │   └── plugin.json
        ├── skills/
        ├── commands/
        └── agents/
```

### 2. Create marketplace.json

```json
{
  "name": "relayapi-plugins",
  "owner": {
    "name": "RelayAPI"
  },
  "plugins": [
    {
      "name": "relayapi",
      "source": "./plugins/relayapi",
      "description": "Post to 21 platforms via a single unified API"
    }
  ]
}
```

### 3. Users install via

```
/plugin marketplace add majestico/relayapi-plugins
/plugin install relayapi@relayapi-plugins
```

### 4. Updates

Push changes to the repo and bump the `version` in `plugin.json`. Users get updates via `/plugin marketplace update` or automatic background updates.

## Option C: Team/Project distribution

Add to your project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "relayapi-plugins": {
      "source": {
        "source": "github",
        "repo": "majestico/relayapi-plugins"
      }
    }
  },
  "enabledPlugins": {
    "relayapi@relayapi-plugins": true
  }
}
```

Team members are automatically prompted to install when they trust the project folder.

## Local Testing

```bash
claude --plugin-dir ./packages/integrations/claude-plugin
```

Then test skills and commands:
- `/relayapi:post Hello world!`
- `/relayapi:accounts`
- `/relayapi:posts`

## Important Notes

- Bump `version` in `plugin.json` on every change — Claude Code uses version to detect updates
- The `userConfig.RELAYAPI_API_KEY` field prompts users for their API key on plugin enable
- Sensitive values are stored in the system keychain, never in plaintext
- Plugin names must be kebab-case
