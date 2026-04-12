---
name: relayapi
description: Use RelayAPI to post to 17 social media platforms, manage accounts, groups, media, scheduling, analytics, inbox, and webhooks via a single unified API. Activate when the user mentions social media posting, cross-posting, scheduling posts, managing social accounts, analytics, inbox, comments, or webhooks.
---

# RelayAPI – Unified Social Media API

You have access to RelayAPI through the `@relayapi/sdk` TypeScript package or direct HTTP calls.

## Authentication

The API key must be set as the `RELAYAPI_API_KEY` environment variable.

**IMPORTANT — Before making any API call, check that the API key is available.** If the key is missing or empty:

1. Tell the user: "You need a RelayAPI API key to use this skill."
2. Guide them to create one:
   - **Option A (Dashboard):** Go to https://relayapi.dev/app, sign up or log in, navigate to API Keys, and create a new key.
   - **Option B (CLI):** If they already have an account: `curl -X POST https://api.relayapi.dev/v1/api-keys -H "Authorization: Bearer <existing_key>"`
3. Once they have the key (starts with `rlay_live_` or `rlay_test_`), tell them to set it:
   ```bash
   export RELAYAPI_API_KEY="rlay_live_your_key_here"
   ```
4. **Do NOT proceed with any API calls until the key is configured.** Do NOT ask the user to paste the key directly in chat.

```typescript
import Relay from '@relayapi/sdk';
const client = new Relay({ apiKey: process.env['RELAYAPI_API_KEY'] });
```

Base URL: `https://api.relayapi.dev`

## Supported Platforms (17)

`twitter`, `instagram`, `facebook`, `linkedin`, `tiktok`, `youtube`, `pinterest`, `reddit`, `bluesky`, `threads`, `telegram`, `snapchat`, `googlebusiness`, `whatsapp`, `mastodon`, `discord`, `sms`

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
- `WORKSPACE_NOT_FOUND` — `grp_*` ID doesn't exist
- `EMPTY_WORKSPACE` — group has no accounts assigned
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

Deletes from platforms, marks as cancelled:

```typescript
await client.posts.unpublish("post_abc123", {
  platforms: ["twitter"], // omit to unpublish from all
});
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
const logs = await client.posts.listLogs({ limit: 50 });
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
const health = await client.accounts.health();
// Per account: { id, platform, username, healthy, token_expires_at, error? }

const single = await client.accounts.healthCheck("acc_abc123");
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
const pages = await client.accounts.facebookPages("acc_abc123");
await client.accounts.setFacebookPage("acc_abc123", { page_id: "123" });

// LinkedIn Organizations
const orgs = await client.accounts.linkedinOrganizations("acc_abc123");
await client.accounts.setLinkedinOrganization("acc_abc123", { organization_id: "456" });

// Pinterest Boards
const boards = await client.accounts.pinterestBoards("acc_abc123");

// Reddit Subreddits & Flairs
const subs = await client.accounts.redditSubreddits("acc_abc123");
const flairs = await client.accounts.redditFlairs("acc_abc123");

// Google Business Locations
const locations = await client.accounts.gmbLocations("acc_abc123");
```

---

## Connecting Accounts

### OAuth Flow (most platforms)

Two-step process:

```typescript
// Step 1: Get authorization URL
const { auth_url } = await client.connect.start("twitter");
// Redirect user to auth_url

// Step 2: After user authorizes, exchange the code
const { account } = await client.connect.complete("twitter", {
  code: "auth_code_from_callback",
});
```

Supported: twitter, instagram, facebook, linkedin, tiktok, youtube, pinterest, reddit, threads, snapchat, googlebusiness, mastodon.

**For platforms with sub-resources** (Facebook, LinkedIn, Pinterest, Google Business, Snapchat), a selection step follows:
```typescript
const pages = await client.connect.facebookPages();
await client.connect.selectFacebookPage({ page_id: "123" });
```

**Headless OAuth** (server-side):
```typescript
const { auth_url } = await client.connect.start("twitter", { headless: true });
// After callback:
const data = await client.connect.pendingData();
```

### Bluesky (app password)

```typescript
const { account } = await client.connect.bluesky({
  handle: "user.bsky.social",
  app_password: "xxxx-xxxx-xxxx-xxxx",
});
```

### Telegram (bot code)

```typescript
// Initiate
const { code, bot_username, expires_in } = await client.connect.telegram();
// Tell user to message @relayapi_bot with: /start <code>

// Poll status
const status = await client.connect.telegramStatus(code);
// status: "pending" | "connected" | "expired"

// Or connect directly with chat ID
const { account } = await client.connect.telegramDirect({ chat_id: "-100123456789" });
```

### Connection Logs

```typescript
const logs = await client.connections.logs();
// Events: connected, disconnected, token_refreshed, error
```

---

## Analytics

### Post Analytics

```typescript
const analytics = await client.analytics.get({
  account_id: "acc_abc123",
  from_date: "2026-01-01",
  to_date: "2026-03-31",
});
// Per post: impressions, reach, likes, comments, shares, saves, clicks, views
```

### Daily Metrics

```typescript
const daily = await client.analytics.dailyMetrics({
  platform: "twitter",
  from_date: "2026-03-01",
});
// Per day: post_count, impressions, likes, comments, shares, clicks, views
```

### Best Posting Time

```typescript
const bestTimes = await client.analytics.bestTime({ platform: "twitter" });
// Array of: { day_of_week (0=Sun), hour_utc (0-23), avg_engagement, post_count }
```

### Content Decay

```typescript
const decay = await client.analytics.contentDecay({
  post_id: "post_abc123",
  days: 30,
});
// decay.data: daily engagement curve, decay.half_life_days
```

### Post Timeline

```typescript
const timeline = await client.analytics.postTimeline({ post_id: "post_abc123" });
// Daily: impressions, likes, comments, shares, clicks, views
```

### Posting Frequency

```typescript
const freq = await client.analytics.postingFrequency({ platform: "twitter" });
// freq.optimal_frequency, freq.data: posts_per_week vs avg_engagement
```

### YouTube Daily Views

```typescript
const yt = await client.analytics.youtubeDailyViews({ account_id: "acc_abc123" });
// Daily: views, watch_time_minutes, subscribers_gained
```

### Platform-Native Live Analytics

Real-time data fetched directly from each platform's API:

```typescript
// All channels overview (followers, impressions, engagement rate)
const channels = await client.analytics.channels();

// Single account overview
const overview = await client.analytics.platformOverview({ account_id: "acc_abc123" });

// Post-level metrics from the platform itself
const posts = await client.analytics.platformPosts({ account_id: "acc_abc123" });

// Audience demographics
const audience = await client.analytics.platformAudience({ account_id: "acc_abc123" });

// Daily time series from platform
const daily = await client.analytics.platformDaily({ account_id: "acc_abc123" });
```

Supported for: Twitter, Instagram, Facebook, LinkedIn, TikTok, YouTube, Pinterest, Threads, Google Business.

---

## Inbox

### Comments

```typescript
// List comments across platforms
const comments = await client.inbox.comments();

// Posts with comment counts
const posts = await client.inbox.commentsByPost();

// Comments for a specific post
const postComments = await client.inbox.commentsForPost("post_abc123");

// Reply
await client.inbox.replyToComment("post_abc123", {
  comment_id: "comment_123",
  text: "Thanks for your feedback!",
});

// Delete, hide/unhide, like/unlike
await client.inbox.deleteComment("comment_123");
await client.inbox.hideComment("comment_123");
await client.inbox.unhideComment("comment_123");
await client.inbox.likeComment("comment_123");
await client.inbox.unlikeComment("comment_123");

// Private reply (DM to commenter)
await client.inbox.privateReply("comment_123", { text: "Let's discuss privately" });
```

Supported for: Facebook, Instagram, YouTube.

### Messages

```typescript
// List conversations (workspace_id optional — scope to a workspace)
const convos = await client.inbox.messages({ workspace_id: "ws_abc" });

// Messages in a conversation
const msgs = await client.inbox.conversation("convo_123");

// Send message
await client.inbox.sendMessage("convo_123", { text: "Hello!" });

// Edit message
await client.inbox.editMessage("convo_123", "msg_456", { text: "Updated" });

// Archive conversation
await client.inbox.archiveConversation("convo_123");
```

### Reviews

```typescript
// List reviews (Google Business, etc.)
const reviews = await client.inbox.reviews();

// Reply to a review
await client.inbox.replyToReview("review_123", { text: "Thank you!" });

// Delete reply
await client.inbox.deleteReviewReply("review_123");
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
await client.webhooks.test({ webhook_id: "wh_abc" });
const logs = await client.webhooks.listLogs({ webhook_id: "wh_abc" });
```

Payloads signed with HMAC-SHA256 via `X-Relay-Signature` header.

---

## Queue & Scheduling

Recurring publishing slots:

```typescript
// Create a queue schedule
await client.queue.createSlots({
  name: "Weekday Mornings",
  slots: [
    { day_of_week: 1, time: "09:00" }, // Monday
    { day_of_week: 3, time: "14:00" }, // Wednesday
    { day_of_week: 5, time: "09:00" }, // Friday
  ],
  timezone: "America/New_York",
});

// day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday

const schedules = await client.queue.listSlots();
await client.queue.updateSlots({ name: "Updated", slots: [...] });
await client.queue.deleteSlots();

// Next available slot
const next = await client.queue.nextSlot();
// next.next_slot_at: ISO datetime

// Preview upcoming slots
const preview = await client.queue.preview({ count: 10 });
// preview.slots: array of ISO datetimes
```

---

## Twitter Engagement

```typescript
// Retweet / undo
await client.twitter.retweet({ tweet_id: "123", account_id: "acc_abc" });
await client.twitter.undoRetweet({ tweet_id: "123", account_id: "acc_abc" });

// Bookmark / remove
await client.twitter.bookmark({ tweet_id: "123", account_id: "acc_abc" });
await client.twitter.removeBookmark({ tweet_id: "123", account_id: "acc_abc" });

// Follow / unfollow
await client.twitter.follow({ target_user_id: "789", account_id: "acc_abc" });
await client.twitter.unfollow({ target_user_id: "789", account_id: "acc_abc" });
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
const feed = await client.reddit.feed({
  subreddit: "programming",
  sort: "hot", // hot, new, top, rising
});
```

---

## Validation Tools

```typescript
// Dry-run post validation
const result = await client.tools.validatePost({
  content: "My post",
  targets: ["twitter", "instagram"],
  scheduled_at: "now",
});
// { valid, errors: [{ target, code, message }], warnings: [...] }

// Character count per platform
const lengths = await client.tools.validateLength({ content: "My post text" });
// { platforms: { twitter: { count, limit, within_limit }, ... } }

// Media validation
const media = await client.tools.validateMedia({ url: "https://example.com/video.mp4" });
// { accessible, content_type, size, platform_limits: { twitter: { within_limit, max_size } } }

// Subreddit check
const sub = await client.tools.validateSubreddit({ name: "gaming" });
// { exists, name, title, subscribers, nsfw, post_types }

// Instagram hashtag safety
const tags = await client.tools.checkHashtags({ hashtags: ["photography", "instagood"] });
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
const usage = await client.usage.get();
// { plan, calls_used, calls_included, current_period_start, current_period_end }

const logs = await client.usage.logs();
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
| Mastodon | 500 |
| Google Business | 1,500 |
| Snapchat | 250 |

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
- Use workspace IDs (`grp_*`) when the user refers to a collection of accounts by name.
- Use validation tools before publishing to catch issues early.
- Upload media via presigned URLs for reliability.
- Set up webhooks for real-time notifications instead of polling.
- When the user says "post to X", first check `accounts.list()` or `workspaces.list()` to resolve "X".
- For stats, use `analytics.platformOverview()` for live data, `analytics.get()` for historical.

## References

- API Docs: https://api.relayapi.dev/docs
- OpenAPI Spec: https://api.relayapi.dev/openapi.json
- SDK: `npm install @relayapi/sdk`
