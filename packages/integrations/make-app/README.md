# RelayAPI Make.com App

Official Make.com (formerly Integromat) app for RelayAPI — post to 17+ social media platforms.

## Modules

### Actions (9)
- **Create Post** — Publish or schedule to any platform
- **Get Post** — Retrieve by ID
- **List Posts** — Filter by status, paginated
- **Update Post** — Edit draft/scheduled posts
- **Delete Post** — Remove draft/scheduled/failed posts
- **List Accounts** — All connected social accounts
- **Get Account Health** — Token & permission status
- **Presign Media URL** — Upload media files
- **Get Usage** — Plan & usage stats

### Instant Triggers (4)
- **Post Published** — Webhook on `post.published`
- **Post Failed** — Webhook on `post.failed`
- **Comment Received** — Webhook on `comment.received`
- **Message Received** — Webhook on `message.received`

### RPCs (3)
- **List Accounts** — Dynamic dropdown for target selection
- **List Platforms** — Static platform list
- **List Workspaces** — Dynamic dropdown for groups

## Publishing

1. Go to [Make Developer Hub](https://www.make.com/en/developer)
2. Create a new app named "RelayAPI"
3. Upload `base.json` as the base configuration
4. Upload `connection/connection.json` as the connection
5. Upload each module JSON in `modules/actions/` and `modules/triggers/`
6. Upload each RPC JSON in `rpcs/`
7. Upload `webhooks/relay-webhook.json`
8. Submit for review

## Authentication

Uses API Key auth. The Bearer token is injected via `base.json` headers.
Test endpoint: `GET /v1/usage`
