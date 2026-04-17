---
name: relayapi
description: Use RelayAPI to post to 21 platforms, manage accounts, groups, media, scheduling, analytics, inbox, and webhooks via a single unified API. Activate when the user mentions social media posting, cross-posting, scheduling posts, managing social accounts, analytics, inbox, comments, or webhooks.
---

# RelayAPI – Unified Social Media API

You have access to RelayAPI through the `@relayapi/sdk` TypeScript package or direct HTTP calls.

## Authentication

The API key is stored securely in the system keychain via the plugin and injected as the environment variable `CLAUDE_PLUGIN_OPTION_RELAYAPI_API_KEY`.

**IMPORTANT — Before making any API call, check that the API key is available.** If the key is missing or empty:

1. Tell the user: "You need a RelayAPI API key to use this plugin."
2. Guide them to create one:
   - **Option A (Dashboard):** Go to https://relayapi.dev/app, sign up or log in, navigate to API Keys, and create a new key.
   - **Option B (CLI):** If they already have an account: `curl -X POST https://api.relayapi.dev/v1/api-keys -H "Authorization: Bearer <existing_key>"`
3. Once they have the key (starts with `rlay_live_` or `rlay_test_`), tell them to run `/plugin` in Claude Code, find `relayapi`, and enter the key.
4. **Do NOT proceed with any API calls until the key is configured.** Do NOT ask the user to paste the key directly in chat.

```typescript
import Relay from '@relayapi/sdk';
const client = new Relay({ apiKey: process.env['CLAUDE_PLUGIN_OPTION_RELAYAPI_API_KEY'] });
```

Base URL: `https://api.relayapi.dev`

## Supported Platforms (21)

`twitter`, `instagram`, `facebook`, `linkedin`, `tiktok`, `youtube`, `pinterest`, `reddit`, `bluesky`, `threads`, `telegram`, `snapchat`, `googlebusiness`, `whatsapp`, `mastodon`, `discord`, `sms`, `beehiiv`, `convertkit`, `mailchimp`, `listmonk`

---

## Posting

### Create a Post

```typescript
const post = await client.posts.create({
  content: "Hello from RelayAPI!",
  targets: ["twitter", "linkedin"],
  scheduled_at: "now",
});
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | No* | Post text. Optional if every target has content in `target_options`. |
| `targets` | string[] | Yes (min 1) | Where to publish. See "Target Resolution" below. |
| `scheduled_at` | string | Yes | `"now"` = publish immediately, `"draft"` = save as draft, or ISO 8601 datetime to schedule. |
| `media` | array | No | `[{ url: "https://...", type: "image" }]`. Type: `"image"`, `"video"`, `"gif"`, `"document"`. Inferred from extension if omitted. |
| `target_options` | object | No | Per-target content overrides keyed by target value. |
| `timezone` | string | No | IANA timezone for scheduling (default: `"UTC"`). |
| `workspace_id` | string | No | Scope the post to a specific workspace. If omitted, operates across all workspaces. |

### Target Resolution (3 ways to specify targets)

Targets tell RelayAPI where to publish. You can mix all three in the same request:

**1. Platform name** — publishes to ALL connected accounts on that platform:
```typescript
{ targets: ["twitter"] }
// If user has 2 Twitter accounts, post goes to both
```

**2. Account ID** — publishes to one specific account:
```typescript
{ targets: ["acc_abc123"] }
// Use client.accounts.list() to find IDs
```

**3. Workspace ID** — publishes to ALL accounts in a group:
```typescript
{ targets: ["ws_xyz789"] }
// Use client.workspaces.list() to find IDs
// A group with Twitter + Instagram accounts publishes to both
```

**Mixed example:**
```typescript
{ targets: ["ws_marketing", "acc_ceo_linkedin", "youtube"] }
// All accounts in "Marketing" group + CEO's LinkedIn + all YouTube accounts
```

**Error codes for failed targets:**
- `NO_ACCOUNT` — no accounts for the platform
- `ACCOUNT_NOT_FOUND` — `acc_*` ID doesn't exist
- `WORKSPACE_NOT_FOUND` — `ws_*` ID doesn't exist
- `EMPTY_WORKSPACE` — workspace has no accounts assigned
- `INVALID_TARGET` — not a valid platform, account ID, or workspace ID

### Per-Platform Customization

```typescript
const post = await client.posts.create({
  content: "Default text for all platforms",
  targets: ["twitter", "linkedin", "instagram"],
  scheduled_at: "now",
  target_options: {
    twitter: { content: "Short tweet with #hashtags (280 char limit)" },
    instagram: { content: "Instagram caption ✨", first_comment: "#tags #here" },
    linkedin: { content: "Professional long-form version for LinkedIn..." },
  },
});
```

Keys can also be account IDs or workspace IDs:
```typescript
target_options: {
  "acc_abc123": { content: "Custom for this specific account" },
  "ws_xyz": { content: "Custom for all accounts in this group" },
}
```

### Media Attachments

**External URL (simplest):**
```typescript
const post = await client.posts.create({
  content: "Check this out!",
  targets: ["instagram", "twitter"],
  scheduled_at: "now",
  media: [{ url: "https://example.com/photo.jpg", type: "image" }],
});
```

**Upload first (more reliable):**
```typescript
const presign = await client.media.getPresignURL({
  filename: "photo.jpg",
  content_type: "image/jpeg",
});
// Upload to presign.url, then use the media URL in a post
```

### Post Statuses

| Status | Meaning |
|--------|---------|
| `draft` | Saved but not scheduled or published |
| `scheduled` | Queued for future publish |
| `publishing` | Currently being sent (async) |
| `published` | Succeeded on ALL targets |
| `partial` | Succeeded on SOME targets, failed others |
| `failed` | Failed on ALL targets |

**Important:** `scheduled_at: "now"` returns immediately with `"publishing"`. Check status later or use webhooks.

### List Posts

```typescript
const posts = await client.posts.list({
  limit: 20,       // 1-100, default 20
  cursor: "...",   // from previous response
  workspace_id: "ws_abc",
  account_id: "acc_xyz",
  status: "published",
});
// posts.data, posts.next_cursor, posts.has_more
```

### Get Post Details

```typescript
const post = await client.posts.retrieve("post_abc123");
// post.targets has per-target status with platform URLs
```

### Update a Post

Only `draft`, `scheduled`, or `failed` posts can be updated:

```typescript
await client.posts.update("post_abc123", {
  content: "Updated content",
  targets: ["twitter", "ws_marketing"],
});
```

### Delete a Post

```typescript
await client.posts.delete("post_abc123");
```

### Retry Failed Targets

```typescript
await client.posts.retry("post_abc123");
```

### Unpublish

Deletes the post from every platform it was sent to and marks it as cancelled:

```typescript
await client.posts.unpublish("post_abc123");
```

### Bulk Create

Up to 50 posts per request:

```typescript
const result = await client.posts.bulkCreate({
  posts: [
    { content: "Post 1", targets: ["twitter"], scheduled_at: "now" },
    { content: "Post 2", targets: ["ws_marketing"], scheduled_at: "2026-06-01T12:00:00Z" },
    { content: "Post 3", targets: ["linkedin"], scheduled_at: "draft" },
  ],
});
// result.summary: { total, succeeded, failed }
```

### Publishing Logs

```typescript
// Global logs across all posts
const logs = await client.posts.logs.list({ limit: 50 });

// Logs for a specific post
const postLogs = await client.posts.logs.retrieve("post_abc123");
```

---

## Account Management

### List Accounts

```typescript
const accounts = await client.accounts.list();
const filtered = await client.accounts.list({
  workspace_id: "ws_abc",    // accounts in a group
  ungrouped: true,         // accounts not in any group
  search: "johndoe",       // search by username
});
```

Response per account: `{ id, platform, platform_account_id, username, display_name, avatar_url, metadata, group: { id, name } | null, connected_at, updated_at }`

### Get / Update / Delete Account

```typescript
const account = await client.accounts.retrieve("acc_abc123");

await client.accounts.update("acc_abc123", {
  display_name: "New Name",
  workspace_id: "ws_xyz",   // assign to group (null to ungroup)
  metadata: { custom: "value" },
});

await client.accounts.delete("acc_abc123"); // disconnect
```

### Account Health

```typescript
// All accounts
const health = await client.accounts.health.list();
// Per account: { id, platform, username, healthy, token_expires_at, error? }

// Single account
const single = await client.accounts.health.retrieve("acc_abc123");
```

### Workspaces

Groups organize accounts and allow publishing to all of them with a single `grp_*` target:

```typescript
// List groups (includes account_count)
const groups = await client.workspaces.list({ search: "marketing" });

// Create
const group = await client.workspaces.create({
  name: "Marketing Team",
  description: "All brand accounts",
});

// Update
await client.workspaces.update("ws_abc123", { name: "Rebranded" });

// Delete (accounts are ungrouped, not deleted)
await client.workspaces.delete("ws_abc123");

// Assign an account to a group
await client.accounts.update("acc_xyz", { workspace_id: "ws_abc123" });
```

**Workflow — "publish to Marketing Team":**
1. `client.workspaces.list()` → find `ws_abc123` named "Marketing Team"
2. `client.posts.create({ targets: ["ws_abc123"], ... })` → publishes to all accounts in the group

### Platform Sub-Resources

Some platforms require selecting a specific page, org, board, or location:

```typescript
// Facebook Pages
const pages = await client.accounts.facebookPages.retrieve("acc_abc123");
await client.accounts.facebookPages.setDefault("acc_abc123", { page_id: "123" });

// LinkedIn Organizations
const orgs = await client.accounts.linkedinOrganizations.retrieve("acc_abc123");
await client.accounts.linkedinOrganizations.switchType("acc_abc123", { organization_id: "456" });

// Pinterest Boards
const boards = await client.accounts.pinterestBoards.retrieve("acc_abc123");
await client.accounts.pinterestBoards.setDefault("acc_abc123", { board_id: "456" });

// Reddit Subreddits & Flairs
const subs = await client.accounts.redditSubreddits.retrieve("acc_abc123");
await client.accounts.redditSubreddits.setDefault("acc_abc123", { subreddit: "programming" });
const flairs = await client.accounts.redditFlairs.retrieve("acc_abc123", { subreddit: "programming" });

// Google Business Locations
const locations = await client.accounts.gmbLocations.retrieve("acc_abc123");
await client.accounts.gmbLocations.setDefault("acc_abc123", { location_id: "456" });
```

---

## Connecting Accounts

### OAuth Flow (most platforms)

Two-step process:

```typescript
// Step 1: Get authorization URL
const { auth_url } = await client.connect.startOAuthFlow("twitter");
// Redirect user to auth_url

// Step 2: After user authorizes, exchange the code
const { account } = await client.connect.completeOAuthCallback("twitter", {
  code: "auth_code_from_callback",
});
```

Supported: twitter, instagram, facebook, linkedin, tiktok, youtube, pinterest, reddit, threads, snapchat, googlebusiness, mastodon.

**For platforms with sub-resources** (Facebook, LinkedIn, Pinterest, Google Business, Snapchat), a selection step follows:
```typescript
const pages = await client.connect.facebook.pages.list();
await client.connect.facebook.pages.select({ page_id: "123" });

// Same pattern exists for:
//   client.connect.linkedin.organizations.list / select
//   client.connect.pinterest.boards.list / select
//   client.connect.googlebusiness.locations.list / select
//   client.connect.snapchat.profiles.list / select
```

**Headless OAuth** (server-side):
```typescript
const { auth_url } = await client.connect.startOAuthFlow("twitter", { headless: true });
// After the callback fires, fetch the pending connection data with the temp token from the callback:
const data = await client.connect.fetchPendingData({ token: "temp_token_from_callback" });
```

### Bluesky (app password)

```typescript
const { account } = await client.connect.createBlueskyConnection({
  handle: "user.bsky.social",
  app_password: "xxxx-xxxx-xxxx-xxxx",
});
```

### Telegram (bot code)

```typescript
// Initiate
const { code, bot_username, expires_in } = await client.connect.telegram.initiateConnection();
// Tell user to message @relayapi_bot with: /start <code>

// Poll status
const status = await client.connect.telegram.pollConnectionStatus({ code });
// status: "pending" | "connected" | "expired"

// Or connect directly with chat ID
const { account } = await client.connect.telegram.connectDirectly({ chat_id: "-100123456789" });
```

### Connection Logs

```typescript
const logs = await client.connections.listLogs();
// Events: connected, disconnected, token_refreshed, error
```

---

## Analytics

### Post Analytics

```typescript
const analytics = await client.analytics.retrieve({
  account_id: "acc_abc123",
  from_date: "2026-01-01",
  to_date: "2026-03-31",
});
// Per post: impressions, reach, likes, comments, shares, saves, clicks, views
```

### Daily Metrics

```typescript
const daily = await client.analytics.listDailyMetrics({
  platform: "twitter",
  from_date: "2026-03-01",
});
// Per day: post_count, impressions, likes, comments, shares, clicks, views
```

### Best Posting Time

```typescript
const bestTimes = await client.analytics.getBestTime({ platform: "twitter" });
// Array of: { day_of_week (0=Sun), hour_utc (0-23), avg_engagement, post_count }
```

### Content Decay

```typescript
const decay = await client.analytics.getContentDecay({
  post_id: "post_abc123",
  days: 30,
});
// decay.data: daily engagement curve, decay.half_life_days
```

### Post Timeline

```typescript
const timeline = await client.analytics.getPostTimeline({ post_id: "post_abc123" });
// Daily: impressions, likes, comments, shares, clicks, views
```

### Posting Frequency

```typescript
const freq = await client.analytics.getPostingFrequency({ platform: "twitter" });
// freq.optimal_frequency, freq.data: posts_per_week vs avg_engagement
```

### YouTube Daily Views

```typescript
const yt = await client.analytics.youtube.getDailyViews({ account_id: "acc_abc123" });
// Daily: views, watch_time_minutes, subscribers_gained
```

### Platform-Native Live Analytics

Real-time data fetched directly from each platform's API:

```typescript
// All channels overview (followers, impressions, engagement rate)
const channels = await client.analytics.listChannels();

// Single account overview
const overview = await client.analytics.getPlatformOverview({ account_id: "acc_abc123" });

// Post-level metrics from the platform itself
const posts = await client.analytics.listPlatformPosts({ account_id: "acc_abc123" });

// Audience demographics
const audience = await client.analytics.getPlatformAudience({ account_id: "acc_abc123" });

// Daily time series from platform
const daily = await client.analytics.getPlatformDaily({ account_id: "acc_abc123" });
```

Supported for: Twitter, Instagram, Facebook, LinkedIn, TikTok, YouTube, Pinterest, Threads, Google Business.

---

## Inbox

### Comments

```typescript
// List comments across platforms
const comments = await client.inbox.comments.list();

// Posts with comment counts
const posts = await client.inbox.comments.listByPost();

// Comments for a specific post
const postComments = await client.inbox.comments.retrieve("post_abc123");

// Reply (account_id REQUIRED — the account to reply from)
await client.inbox.comments.reply("post_abc123", {
  account_id: "acc_abc",
  text: "Thanks for your feedback!",
  comment_id: "comment_123", // optional — parent comment for threaded replies
});

// Delete
await client.inbox.comments.delete("comment_123");

// Hide / unhide
await client.inbox.comments.hide.create("comment_123");
await client.inbox.comments.hide.delete("comment_123");

// Like / unlike
await client.inbox.comments.like.create("comment_123");
await client.inbox.comments.like.delete("comment_123");

// Private reply (DM to commenter) — account_id REQUIRED
await client.inbox.comments.privateReply("comment_123", {
  account_id: "acc_abc",
  text: "Let's discuss privately",
});
```

Supported for: Facebook, Instagram, YouTube.

### Conversations (DMs)

```typescript
// List conversations (filter by platform/account_id/status/labels/type)
const convos = await client.inbox.conversations.list({ platform: "instagram" });

// Get a conversation with its messages
const convo = await client.inbox.conversations.get("convo_123");

// Send a message (account_id REQUIRED — the account to send from)
await client.inbox.conversations.sendMessage("convo_123", {
  account_id: "acc_abc",
  text: "Hello!",
});

// Archive / change status / set labels / priority
await client.inbox.conversations.update("convo_123", { status: "archived" });

// Delete a message
await client.inbox.conversations.deleteMessage("msg_456", {
  conversation_id: "convo_123",
  account_id: "acc_abc",
});

// Reactions, typing indicators, mark read
await client.inbox.conversations.addReaction("msg_456", {
  conversation_id: "convo_123",
  account_id: "acc_abc",
  emoji: "👍",
});
await client.inbox.conversations.sendTyping("convo_123", { account_id: "acc_abc" });
await client.inbox.conversations.markRead({ targets: ["convo_123"] });
```

Note: editing a previously-sent message is not supported by the API.

### Reviews

```typescript
// List reviews (Google Business, etc.)
const reviews = await client.inbox.reviews.list();

// Reply to a review (account_id REQUIRED)
await client.inbox.reviews.reply.create("review_123", {
  account_id: "acc_abc",
  text: "Thank you!",
});

// Delete reply
await client.inbox.reviews.reply.delete("review_123");
```

---

## Webhooks

### Create

```typescript
const webhook = await client.webhooks.create({
  url: "https://example.com/webhook",
  events: ["post.published", "post.failed", "account.disconnected"],
  workspace_id: "ws_abc", // optional — scope to a specific workspace
});
// webhook.secret — shown only once, save it for signature verification
```

**Available events:**

| Event | Trigger |
|-------|---------|
| `post.published` | Post published to all targets |
| `post.partial` | Published to some, failed on others |
| `post.failed` | Failed on all targets |
| `post.scheduled` | Post scheduled for later |
| `account.connected` | Social account connected |
| `account.disconnected` | Social account disconnected |
| `comment.received` | New comment on a post |
| `message.received` | New direct message |

### Manage

```typescript
const webhooks = await client.webhooks.list({ workspace_id: "ws_abc" }); // workspace_id optional
await client.webhooks.update("wh_abc", { events: ["post.published"], enabled: false });
await client.webhooks.delete("wh_abc");
await client.webhooks.sendTest({ webhook_id: "wh_abc" });
const logs = await client.webhooks.listLogs({ limit: 50 });
```

Payloads signed with HMAC-SHA256 via `X-Relay-Signature` header.

---

## Queue & Scheduling

Recurring publishing slots live under `client.queue.slots.*`:

```typescript
// Create a queue schedule
await client.queue.slots.create({
  name: "Weekday Mornings",
  slots: [
    { day_of_week: 1, time: "09:00" }, // Monday
    { day_of_week: 3, time: "14:00" }, // Wednesday
    { day_of_week: 5, time: "09:00" }, // Friday
  ],
  timezone: "America/New_York",
});

// day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday

const schedules = await client.queue.slots.list();
await client.queue.slots.update({ name: "Updated", slots: [/* ... */] });
await client.queue.slots.delete();

// Next available slot
const next = await client.queue.getNextSlot();
// next.next_slot_at: ISO datetime

// Preview upcoming slots
const preview = await client.queue.preview({ count: 10 });
// preview.slots: array of ISO datetimes

// Smart slot finder (respects already-scheduled posts)
const slot = await client.queue.findSlot();
```

---

## Twitter Engagement

```typescript
// Retweet / undo
await client.twitter.retweet.create({ tweet_id: "123", account_id: "acc_abc" });
await client.twitter.retweet.undo({ tweet_id: "123", account_id: "acc_abc" });

// Bookmark / remove
await client.twitter.bookmark.create({ tweet_id: "123", account_id: "acc_abc" });
await client.twitter.bookmark.remove({ tweet_id: "123", account_id: "acc_abc" });

// Follow / unfollow
await client.twitter.follow.create({ target_user_id: "789", account_id: "acc_abc" });
await client.twitter.follow.unfollow({ target_user_id: "789", account_id: "acc_abc" });
```

---

## Reddit

```typescript
// Search
const results = await client.reddit.search({
  q: "relayapi",
  subreddit: "programming",
  sort: "relevance",
});

// Subreddit feed
const feed = await client.reddit.getFeed({
  subreddit: "programming",
  sort: "hot", // hot, new, top, rising
});
```

---

## Validation Tools

```typescript
// Dry-run post validation
const result = await client.tools.validate.validatePost({
  content: "My post",
  targets: ["twitter", "instagram"],
  scheduled_at: "now",
});
// { valid, errors: [{ target, code, message }], warnings: [...] }

// Character count per platform
const lengths = await client.tools.validate.checkPostLength({ content: "My post text" });
// { platforms: { twitter: { count, limit, within_limit }, ... } }

// Media validation
const media = await client.tools.validate.validateMedia({ url: "https://example.com/video.mp4" });
// { accessible, content_type, size, platform_limits: { twitter: { within_limit, max_size } } }

// Subreddit check
const sub = await client.tools.validate.retrieveSubreddit({ name: "gaming" });
// { exists, name, title, subscribers, nsfw, post_types }

// Instagram hashtag safety
const tags = await client.tools.instagram.checkHashtagSafety({ hashtags: ["photography", "instagood"] });
// Per hashtag: "safe", "restricted", or "banned"
```

---

## Media Management

```typescript
const media = await client.media.list();
const file = await client.media.retrieve("med_abc123");
await client.media.delete("med_abc123");
```

---

## Usage & Billing

```typescript
const usage = await client.usage.retrieve();
// { plan, calls_used, calls_included, current_period_start, current_period_end }

const logs = await client.usage.listLogs();
// Per-request API call history
```

---

## Platform Character Limits

| Platform | Limit |
|----------|-------|
| Twitter | 280 |
| LinkedIn | 3,000 |
| Instagram | 2,200 |
| Facebook | 63,206 |
| TikTok | 2,200 |
| YouTube | 5,000 (description) |
| Pinterest | 500 |
| Reddit | 40,000 |
| Bluesky | 300 |
| Threads | 500 |
| Telegram | 4,096 |
| Snapchat | 250 |
| Google Business | 1,500 |
| WhatsApp | 4,096 |
| Mastodon | 500 |
| Discord | 2,000 |
| SMS | 1,600 (auto-segmented) |
| Beehiiv / ConvertKit / Mailchimp / Listmonk | 100,000 (email HTML) |

---

## Response Format

All list endpoints return `{ data: [...], next_cursor: string | null, has_more: boolean }`.
Paginate with `{ cursor: response.next_cursor }`. Default limit: 20, max: 100.

Errors: `{ error: { code, message, details? } }`.
Common codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `RATE_LIMITED`.

## Rate Limits

- **Free:** 100 req/min, 200 calls/month
- **Pro:** 1,000 req/min, 10,000 calls/month

## Tips for AI Agents

- Always check post status after creation — `"now"` publishes async, post can be `partial` or `failed`.
- Use `target_options` to customize content per platform — different limits and conventions.
- Use workspace IDs (`ws_*`) when the user refers to a collection of accounts by name.
- Use validation tools before publishing to catch issues early.
- Upload media via presigned URLs for reliability.
- Set up webhooks for real-time notifications instead of polling.
- When the user says "post to X", first check `accounts.list()` or `workspaces.list()` to resolve "X".
- For stats, use `analytics.getPlatformOverview()` for live data, `analytics.retrieve()` for historical.
- Inbox reply/send methods REQUIRE an `account_id` — look it up from `accounts.list()` first.

## References

- API Docs: https://api.relayapi.dev/docs
- OpenAPI Spec: https://api.relayapi.dev/openapi.json
- SDK: `npm install @relayapi/sdk`
