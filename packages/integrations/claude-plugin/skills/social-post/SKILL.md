---
name: social-post
description: Quickly compose and publish a social media post to one or more platforms using RelayAPI. Use when the user wants to draft, schedule, or publish a social media post.
---

# Social Post Composer

Help the user compose and publish a social media post using RelayAPI.

## Workflow

0. **Check authentication** — Verify the RelayAPI API key is configured (available as `CLAUDE_PLUGIN_OPTION_RELAYAPI_API_KEY` env var). If missing, guide the user to set it up:
   - Sign up or log in at https://relayapi.dev/app
   - Navigate to API Keys and create a new key (starts with `rlay_live_` or `rlay_test_`)
   - Run `/plugin` in Claude Code, find `relayapi`, and enter the key
   - Do NOT proceed until the key is configured. Do NOT ask the user to paste the key in chat.
1. **Ask the user** what they want to post and to which platforms/groups if not already specified
2. **Check connected accounts** by calling `GET /v1/accounts` to confirm they have accounts connected for the requested platforms
3. **Resolve targets** — the user may refer to platforms by name ("Twitter"), workspaces ("Marketing"), or specific accounts. Use:
   - Platform name (e.g. `"twitter"`) → all accounts on that platform
   - Workspace ID (e.g. `"ws_abc123"`) → all accounts in the group. Use `GET /v1/workspaces` to find the workspace ID by name.
   - Account ID (e.g. `"acc_abc123"`) → one specific account
4. **Validate the content** using `POST /v1/tools/validate/post` to check character limits and platform compatibility
5. **Customize per platform** if the content needs adjustment — use `target_options` for per-target content:
   - Shorter text for Twitter (280 chars), Bluesky (300), Threads/Mastodon/Pinterest (500)
   - Platform-specific hashtags, mentions, formatting
   - Instagram `first_comment` for hashtags
6. **Confirm with the user** before publishing — show them the final content and all targets
7. **Publish** using `POST /v1/posts`:
   - `scheduled_at: "now"` to publish immediately
   - `scheduled_at: "draft"` to save as draft
   - `scheduled_at: "<ISO 8601>"` to schedule (e.g. `"2026-06-01T12:00:00Z"`)
   - `workspace_id` (optional) — scope the post to a specific workspace. If omitted, operates across all workspaces.
8. **Report results** — show the post status and any per-target errors. A post can be `partial` (some targets succeeded, others failed).

## Example

```typescript
import Relay from '@relayapi/sdk';
const client = new Relay({ apiKey: process.env['CLAUDE_PLUGIN_OPTION_RELAYAPI_API_KEY'] });

// Find the user's group
const groups = await client.workspaces.list();
const marketing = groups.data.find(g => g.name === "Marketing");

const post = await client.posts.create({
  content: "Exciting news! We just launched our new feature.",
  targets: [marketing?.id ?? "twitter", "linkedin"],
  scheduled_at: "now",
  target_options: {
    twitter: { content: "We just launched our new feature! 🚀 #launch #product" },
    instagram: { content: "We just launched our new feature! ✨", first_comment: "#launch #product #tech" },
  },
  media: [{ url: "https://example.com/launch-banner.jpg", type: "image" }],
});
```

## Platform Character Limits

| Platform | Limit |
|----------|-------|
| Twitter | 280 |
| LinkedIn | 3,000 |
| Instagram | 2,200 |
| Facebook | 63,206 |
| TikTok | 2,200 |
| YouTube | 5,000 |
| Pinterest | 500 |
| Reddit | 40,000 |
| Bluesky | 300 |
| Threads | 500 |
| Mastodon | 500 |
| Google Business | 1,500 |
| Snapchat | 250 |

## Important Rules

- ALWAYS validate content before posting
- ALWAYS confirm with the user before publishing
- NEVER publish without explicit user approval
- Show per-target results after publishing (some may succeed while others fail)
- Use `target_options` for platform-specific content — don't send Twitter-length text to LinkedIn or vice versa
- When the user mentions a group name, look it up via `GET /v1/workspaces` and use the `grp_*` ID as a target
