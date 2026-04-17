# Capabilities

## Supported Platforms

### Social And Publishing

- `twitter`
- `instagram`
- `facebook`
- `linkedin`
- `tiktok`
- `youtube`
- `pinterest`
- `reddit`
- `bluesky`
- `threads`
- `mastodon`
- `snapchat`
- `googlebusiness`

### Messaging And Community

- `telegram`
- `whatsapp`
- `discord`
- `sms`

### Newsletter

- `beehiiv`
- `convertkit`
- `mailchimp`
- `listmonk`

## Connection Model

- OAuth platforms: `twitter`, `instagram`, `facebook`, `linkedin`, `tiktok`, `youtube`, `pinterest`, `reddit`, `threads`, `snapchat`, `googlebusiness`, `mastodon`
- Credential or token based connections:
  - `bluesky` via app password
  - `telegram` via bot flow or direct chat connection
  - `whatsapp` via embedded signup or direct credentials
  - `beehiiv`, `convertkit`, `mailchimp`, `listmonk` via API credentials
- Post-OAuth secondary selection flows exist where the platform requires a second step, including Facebook Pages, LinkedIn organizations, Pinterest boards, Google Business locations, and Snapchat public profiles.

## Major API Domains

- Core publishing: `/v1/posts`, `/v1/media`, `/v1/accounts`, `/v1/connect`, `/v1/connections`
- Org and access control: `/v1/workspaces`, `/v1/api-keys`, `/v1/usage`, `/v1/org-settings`, `/v1/invite/tokens`
- Inbox and automation: `/v1/inbox`, `/v1/contacts`, `/v1/custom-fields`, `/v1/broadcasts`, `/v1/automations`, `/v1/automations/templates`, `/v1/segments`, `/v1/ai-knowledge`, `/v1/ref-urls`, `/v1/auto-post-rules`, `/v1/signatures`, `/v1/streak`
- Analytics and platform utilities: `/v1/analytics`, `/v1/tools`, `/v1/queue`, `/v1/threads`, `/v1/twitter`, `/v1/reddit`, `/v1/short-links`
- Ads and growth: `/v1/ads`
- WhatsApp-specific flows: `/v1/whatsapp`, `/v1/whatsapp/phone-numbers`

## Public And Non-API Endpoints

- `/health` — health check
- `/r/:code` — short-link redirect
- `/connect/oauth` — OAuth callback entry
- `/webhooks/stripe` — Stripe webhooks
- `/webhooks/platform` — inbound platform webhooks

## Tools Surface

The tools area currently covers validation and helper flows rather than becoming a generic utility bucket. The implemented surface includes:

- post validation
- media validation
- post-length checks
- subreddit validation
- Instagram hashtag checks
- LinkedIn mention resolution
- YouTube transcript jobs
- async tool job status polling

## Documentation Boundary

This file is intentionally high level. Exact request and response shapes belong in the OpenAPI spec, route files, schemas, and SDK.
