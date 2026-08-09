export interface ApiData {
	slug: string;
	name: string;
	heroTitle: string;
	heroDescription: string;
	features: { title: string; description: string }[];
	benefits: { title: string; description: string }[];
	codeExamples: { language: string; label: string; code: string }[];
	faq: { question: string; answer: string }[];
}

export const apis: ApiData[] = [
	// ─── Posting API ────────────────────────────────────────────────────
	{
		slug: "posting-api",
		name: "Posting API",
		heroTitle: "Posting API for Developers",
		heroDescription:
			"One REST API to publish content across 21 social, messaging, SMS, and newsletter channels. Post text, images, videos, and more with a single endpoint.",
		features: [
			{
				title: "Multi-Platform Posting",
				description:
					"Publish to Twitter/X, Instagram, LinkedIn, TikTok, Bluesky, Mastodon, and 11 more platforms from a single API call. No need to learn each platform's quirks.",
			},
			{
				title: "Content Scheduling",
				description:
					"Schedule posts for any future date and time. RelayAPI handles timezone conversion, queue management, and guaranteed delivery at the exact moment you specify.",
			},
			{
				title: "Thread & Carousel Support",
				description:
					"Create multi-part threads on Twitter/X and Bluesky, or carousel posts on Instagram and LinkedIn. Pass an array of content blocks and we handle the rest.",
			},
			{
				title: "Platform-Specific Formatting",
				description:
					"Automatically adapt content for each platform's constraints — character limits, hashtag placement, mention formatting, and link card generation.",
			},
			{
				title: "Draft Management",
				description:
					"Save posts as drafts, preview how they'll appear on each platform, and publish when ready. Collaborate with your team before anything goes live.",
			},
			{
				title: "Post Status Tracking",
				description:
					"Track every post through its lifecycle — queued, publishing, published, or failed — with detailed per-platform status and direct links to live posts.",
			},
			{
				title: "Webhook Delivery Notifications",
				description:
					"Receive real-time webhooks when posts are successfully delivered or fail on any platform. Build reactive workflows without polling for status.",
			},
			{
				title: "Automatic Retry Logic",
				description:
					"Transient platform failures are automatically retried with exponential backoff. Configure retry policies per post or rely on sensible defaults.",
			},
		],
		benefits: [
			{
				title: "One Integration, 21 Channels",
				description:
					"Each social, messaging, and newsletter channel has its own auth flow, rate limits, and content rules. RelayAPI exposes all 21 through one publishing contract.",
			},
			{
				title: "Enterprise-Grade Reliability",
				description:
					"Built on Cloudflare's global edge network with 99.9% uptime. Automatic retries, dead-letter queues, and detailed delivery reports mean your content reaches every platform — every time.",
			},
			{
				title: "Developer-First Experience",
				description:
					"Interactive API docs, TypeScript and Python SDKs, copy-paste code examples, and a responsive support team. Everything you need to integrate quickly and maintain confidently.",
			},
		],
		codeExamples: [
			{
				language: "bash",
				label: "cURL",
				code: `curl -X POST https://api.relayapi.dev/v1/posts \\
  -H "Authorization: Bearer rlay_live_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "content": "Excited to announce our new product launch! Check it out at https://example.com",
    "platforms": ["twitter", "linkedin", "bluesky"],
    "media": [
      { "url": "https://cdn.example.com/launch-banner.png", "alt_text": "Product launch banner" }
    ],
    "scheduled_for": "2026-04-01T14:00:00Z"
  }'`,
			},
			{
				language: "typescript",
				label: "TypeScript",
				code: `const response = await fetch("https://api.relayapi.dev/v1/posts", {
  method: "POST",
  headers: {
    Authorization: "Bearer rlay_live_xxxxxxxx",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content:
      "Excited to announce our new product launch! Check it out at https://example.com",
    platforms: ["twitter", "linkedin", "bluesky"],
    media: [
      {
        url: "https://cdn.example.com/launch-banner.png",
        alt_text: "Product launch banner",
      },
    ],
    scheduled_for: "2026-04-01T14:00:00Z",
  }),
});

const post = await response.json();
console.log(post.id, post.status);`,
			},
			{
				language: "python",
				label: "Python",
				code: `import requests

response = requests.post(
    "https://api.relayapi.dev/v1/posts",
    headers={"Authorization": "Bearer rlay_live_xxxxxxxx"},
    json={
        "content": "Excited to announce our new product launch! Check it out at https://example.com",
        "platforms": ["twitter", "linkedin", "bluesky"],
        "media": [
            {"url": "https://cdn.example.com/launch-banner.png", "alt_text": "Product launch banner"}
        ],
        "scheduled_for": "2026-04-01T14:00:00Z",
    },
)

post = response.json()
print(post["id"], post["status"])`,
			},
		],
		faq: [
			{
				question: "What are the rate limits for the Posting API?",
				answer:
					"Free plans allow 100 posts per day across all platforms. Pro plans support up to 5,000 posts per day, and Enterprise plans offer custom limits. Per-platform rate limits are handled automatically — if a platform throttles a request, RelayAPI queues it and retries within the platform's allowed window.",
			},
			{
				question: "Which social platforms are supported?",
				answer:
					"RelayAPI currently supports 21 publishing channels across social, messaging, SMS, and newsletter categories: Instagram, Facebook, LinkedIn, TikTok, YouTube, Bluesky, Mastodon, Threads, Pinterest, Reddit, Discord, Telegram, WhatsApp Business, Google Business Profile, Snapchat, X/Twitter, SMS, Beehiiv, ConvertKit, Mailchimp, and Listmonk.",
			},
			{
				question: "How far in advance can I schedule posts?",
				answer:
					"Posts can be scheduled up to 90 days in advance. Scheduled posts are stored durably and processed by a dedicated scheduler that guarantees delivery within 30 seconds of the target time. You can update or cancel a scheduled post at any time before it publishes.",
			},
			{
				question: "What media formats are supported for posts?",
				answer:
					"RelayAPI's media upload API accepts the documented image, video, audio, and PDF MIME types up to 50 MiB. Posts attach media objects with an HTTP(S) URL and optional image, video, GIF, or document type. Platforms can impose stricter limits, and RelayAPI does not promise automatic conversion or resizing.",
			},
			{
				question:
					"How does error handling work when a post fails on one platform?",
				answer:
					"Each platform in a multi-platform post is treated independently. If a post fails on Twitter but succeeds on LinkedIn, you'll see per-platform status in the response. Failed deliveries are retried up to 3 times with exponential backoff. Permanent failures (e.g., invalid content) return detailed error codes and messages you can surface to your users.",
			},
			{
				question:
					"Can I post different content to different platforms in one request?",
				answer:
					"Yes. Use the platform_overrides field to customize content per platform — for example, a longer caption on LinkedIn, different hashtags on Instagram, or a shorter version for Twitter's character limit. The base content field serves as the default for any platform without an override.",
			},
		],
	},

	// ─── Media API ──────────────────────────────────────────────────────
	{
		slug: "media-api",
		name: "Media API",
		heroTitle: "Media API for Developers",
		heroDescription:
			"Upload and manage media for social publishing through durable direct or pre-signed upload flows.",
		features: [
			{
				title: "Pre-Signed Direct Uploads",
				description:
					"Create a pending upload intent, PUT bytes directly to R2, then confirm the object. The API returns an intent ID and a canonical URL for post media objects.",
			},
			{
				title: "Raw-Body Uploads",
				description:
					"Send raw file bytes to the authenticated upload endpoint with a filename query parameter and the file's actual Content-Type.",
			},
			{
				title: "Strict Upload Validation",
				description:
					"Reject unsupported MIME types, empty bodies, and files over 50 MiB. Confirmation checks the stored object's actual size and Content-Type.",
			},
			{
				title: "Durable Upload Intents",
				description:
					"The database intent is written before object storage. Background reconciliation can finish accepted uploads after an interrupted request or event delivery.",
			},
			{
				title: "Durable Preview Thumbnails",
				description:
					"Off-request processing creates compact AVIF previews for images and video poster frames. Preview URLs remain available after original-file lifecycle deletion.",
			},
			{
				title: "Media Library Management",
				description:
					"List ready media with cursor pagination, retrieve details by ID, and delete items not referenced by a draft, scheduled, or publishing post.",
			},
			{
				title: "Workspace-Aware Access",
				description:
					"Associate uploads with an optional workspace. Organization, workspace-grant, and active-post checks protect reads and deletion.",
			},
			{
				title: "Private Original Delivery",
				description:
					"Canonical Relay media URLs are resolved to short-lived signed reads when the API or publisher needs the private original.",
			},
		],
		benefits: [
			{
				title: "Bytes Bypass the API Worker",
				description:
					"The pre-signed path sends file bytes directly to R2 while RelayAPI retains an auditable pending-to-ready media record.",
			},
			{
				title: "Recoverable State Transitions",
				description:
					"Durable intents, object events, and scheduled reconciliation make upload completion and cleanup retryable instead of relying on one request finishing perfectly.",
			},
			{
				title: "Developer-First Experience",
				description:
					"Typed presign and confirmation methods, a raw-body fallback, explicit MIME rules, and OpenAPI documentation make the lifecycle unambiguous.",
			},
		],
		codeExamples: [
			{
				language: "bash",
				label: "cURL",
				code: `presign="$(curl --fail-with-body -sS -X POST https://api.relayapi.dev/v1/media/presign \\
  -H "Authorization: Bearer $RELAYAPI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"filename":"product-hero.png","content_type":"image/png"}')"

upload_url="$(printf '%s' "$presign" | jq -r '.upload_url')"
upload_content_type="$(printf '%s' "$presign" | jq -r '.upload_headers["Content-Type"]')"
upload_precondition="$(printf '%s' "$presign" | jq -r '.upload_headers["If-None-Match"]')"
media_url="$(printf '%s' "$presign" | jq -r '.url')"
storage_key="$(printf '%s' "$media_url" | sed 's#^https://media.relayapi.dev/##')"

curl --fail-with-body -X PUT "$upload_url" \\
  -H "Content-Type: $upload_content_type" \\
  -H "If-None-Match: $upload_precondition" \\
  --data-binary @product-hero.png

jq -n --arg storage_key "$storage_key" '{storage_key: $storage_key}' | \\
  curl --fail-with-body -X POST https://api.relayapi.dev/v1/media/confirm \\
    -H "Authorization: Bearer $RELAYAPI_API_KEY" \\
    -H "Content-Type: application/json" \\
    --data-binary @-`,
			},
			{
				language: "typescript",
				label: "TypeScript",
				code: `const presign = await client.media.getPresignURL({
  filename: file.name,
  content_type: file.type,
});

const upload = await fetch(presign.upload_url, {
  method: "PUT",
  headers: presign.upload_headers,
  body: file,
});
if (!upload.ok) throw new Error("Upload failed");

const storageKey = decodeURIComponent(new URL(presign.url).pathname.slice(1));
const media = await client.media.confirm({ storage_key: storageKey });

await client.posts.create({
  content: "Product launch",
  targets: ["instagram"],
  scheduled_at: "now",
  media: [{ url: presign.url, type: "image" }],
});`,
			},
			{
				language: "python",
				label: "Python",
				code: `import requests
from urllib.parse import unquote, urlsplit

presign = client.media.presign(
    filename="product-hero.png",
    content_type="image/png",
)

with open("product-hero.png", "rb") as file:
    upload = requests.put(
        presign.upload_url,
        data=file,
        headers={"Content-Type": "image/png", "If-None-Match": "*"},
    )
upload.raise_for_status()

storage_key = unquote(urlsplit(presign.url).path.lstrip("/"))
media = client.media.confirm(storage_key=storage_key)`,
			},
		],
		faq: [
			{
				question: "What media formats are supported?",
				answer:
					"Allowed MIME types are image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif, image/avif, video/mp4, video/webm, video/quicktime, video/mpeg, audio/mpeg, audio/mp4, audio/webm, audio/wav, audio/ogg, and application/pdf. Other types, including SVG and application/octet-stream, are rejected.",
			},
			{
				question: "What are the file size limits?",
				answer:
					"All media uploads are limited to 50 MiB (52,428,800 bytes). RelayAPI does not currently expose a resumable or chunked media-upload endpoint.",
			},
			{
				question:
					"Does RelayAPI automatically convert media for each platform?",
				answer:
					"No. RelayAPI preserves the full-resolution original and generates a compact preview thumbnail, but it does not promise platform-specific transcoding or resizing. Prepare files for each target platform's limits before publishing.",
			},
			{
				question: "Why must a pre-signed upload be confirmed?",
				answer:
					"Confirmation verifies the object in R2, enforces the 50 MiB and MIME rules, records its actual size, and changes the pending media intent to ready. A PUT without POST /v1/media/confirm is not a completed upload.",
			},
			{
				question: "How long are uploaded files retained?",
				answer:
					"Full-resolution originals are subject to the media bucket's approximately 30-day lifecycle policy. Durable preview thumbnails do not expire, and API responses fall back to a thumbnail after the original is removed.",
			},
		],
	},

	// ─── Analytics API ──────────────────────────────────────────────────
	{
		slug: "analytics-api",
		name: "Analytics API",
		heroTitle: "Analytics API for Developers",
		heroDescription:
			"Query normalized post metrics, daily rollups, best-time analysis, and supported native account insights through documented endpoints.",
		features: [
			{
				title: "Normalized Post Metrics",
				description:
					"GET /v1/analytics returns post-level likes, comments, shares, clicks, impressions, reach, saves, and views when the connected provider supplies them.",
			},
			{
				title: "Daily Aggregates",
				description:
					"Use /v1/analytics/daily-metrics for daily totals filtered by account, platform, and ISO-8601 date range.",
			},
			{
				title: "Post Timelines & Decay",
				description:
					"Inspect a post's metric timeline or calculate its engagement decay curve and estimated half-life with dedicated endpoints.",
			},
			{
				title: "Timing Analysis",
				description:
					"Best-time and posting-frequency endpoints summarize historical engagement by UTC day/hour and publishing cadence.",
			},
			{
				title: "Connected Channel Summaries",
				description:
					"List connected accounts with summary metrics and an explicit has_analytics capability signal through /v1/analytics/channels.",
			},
			{
				title: "Native Platform Overview",
				description:
					"Fetch live overview and top-post data for one supported connected account through the platform analytics endpoints.",
			},
			{
				title: "Audience & Daily Provider Data",
				description:
					"Audience breakdowns and native daily series are available when the provider and granted account scopes expose those metrics.",
			},
			{
				title: "Explicit Query Filters",
				description:
					"Documented account_id, post_id, platform, from_date, and to_date filters keep requests reproducible without undocumented export or refresh jobs.",
			},
		],
		benefits: [
			{
				title: "One Normalized Read Model",
				description:
					"Read common post metrics through one response shape while retaining the platform field needed to interpret provider-specific availability.",
			},
			{
				title: "Account-Aware Insights",
				description:
					"Filter stored analytics by connected account, then use native endpoints for supported account-level overview, posts, audience, and daily data.",
			},
			{
				title: "Contract-First Integration",
				description:
					"The OpenAPI reference and generated SDK expose every analytics route and its supported filters without relying on marketing-only endpoints.",
			},
		],
		codeExamples: [
			{
				language: "bash",
				label: "cURL — Post Analytics",
				code: `curl --get https://api.relayapi.dev/v1/analytics \\
  -H "Authorization: Bearer rlay_live_xxxxxxxx" \\
  --data-urlencode "post_id=post_a1b2c3d4e5" \\
  --data-urlencode "from_date=2026-03-01" \\
  --data-urlencode "to_date=2026-03-20"`,
			},
			{
				language: "typescript",
				label: "TypeScript — Channel Summaries",
				code: `const channels = await client.analytics.listChannels({
  from_date: "2026-03-01",
  to_date: "2026-03-20",
});

for (const channel of channels.data) {
  console.log(channel.account_id, channel.has_analytics);
}`,
			},
			{
				language: "python",
				label: "Python — Daily Metrics",
				code: `import requests

response = requests.get(
    "https://api.relayapi.dev/v1/analytics/daily-metrics",
    headers={"Authorization": "Bearer rlay_live_xxxxxxxx"},
    params={
		"account_id": "acc_x9y8z7w6",
		"from_date": "2026-03-01",
		"to_date": "2026-03-20",
    },
)
response.raise_for_status()

for day in response.json()["data"]:
	print(day["date"], day["impressions"], day["likes"])`,
			},
		],
		faq: [
			{
				question: "What metrics are available?",
				answer:
					"The normalized post response can include impressions, reach, likes, comments, shares, saves, clicks, and views. Native platform endpoints expose only the overview, post, audience, and daily fields documented for the connected provider.",
			},
			{
				question: "How often are metrics updated?",
				answer:
					"Update timing depends on the provider and RelayAPI's background collection. The public analytics API does not expose an on-demand refresh endpoint, so clients should treat returned timestamps and provider availability as authoritative.",
			},
			{
				question: "How far back does historical data go?",
				answer:
					"The API accepts documented date-range filters, but it does not promise a universal retention or backfill window. Available history depends on collected records and the native provider's access rules.",
			},
			{
				question: "Are metrics available for all supported platforms?",
				answer:
					"No. Metric depth varies by provider, account type, and granted scopes. Use /v1/analytics/channels and its has_analytics field before presenting analytics for a connected account.",
			},
			{
				question: "Can I export analytics data?",
				answer:
					"RelayAPI returns JSON from the documented analytics endpoints. There is no analytics export or scheduled-report endpoint in the current public API; transform the JSON in your application when you need CSV or BI ingestion.",
			},
		],
	},

	// ─── Webhooks API ───────────────────────────────────────────────────
	{
		slug: "webhooks-api",
		name: "Webhooks API",
		heroTitle: "Webhooks API for Developers",
		heroDescription:
			"Subscribe to the documented publishing, account, inbox, automation, streak, and cross-post events with signed delivery attempts.",
		features: [
			{
				title: "Documented Event Catalog",
				description:
					"Subscribe to exact event names such as post.published, post.partial, post.failed, thread.published, and account.disconnected.",
			},
			{
				title: "Server-Generated Secrets",
				description:
					"RelayAPI creates the endpoint signing secret and returns it once. Rotate it later with the dedicated secret-rotation endpoint.",
			},
			{
				title: "HMAC-SHA256 Signing",
				description:
					"Every delivery signs the exact JSON request body in X-RelayAPI-Signature and identifies the event and delivery in separate headers.",
			},
			{
				title: "Durable Attempt History",
				description:
					"Inspect the last seven days of delivery and test attempts, including ordinal, status code, response time, outcome, and error.",
			},
			{
				title: "Bounded Automatic Retries",
				description:
					"Retryable HTTP and network failures are persisted and retried with backoff; each attempt is exposed in the webhook log.",
			},
			{
				title: "Exact Event Filtering",
				description:
					"Choose one or more supported event names when creating or updating an endpoint. Wildcard and tag-based filters are not part of the current contract.",
			},
			{
				title: "Workspace Scoping",
				description:
					"Optionally associate an endpoint with an authorized workspace while retaining organization ownership and access checks.",
			},
			{
				title: "Reachability Tests",
				description:
					"POST /v1/webhooks/test sends a test request to a registered endpoint and reports success, HTTP status, and response time.",
			},
		],
		benefits: [
			{
				title: "One Subscription Surface",
				description:
					"A single endpoint can subscribe to multiple supported RelayAPI events without implementing provider-specific callback contracts.",
			},
			{
				title: "Auditable Delivery",
				description:
					"Durable delivery IDs and persisted per-attempt outcomes let consumers deduplicate and operators inspect what happened without a promised replay API.",
			},
			{
				title: "Contract-First Management",
				description:
					"OpenAPI and the generated SDK cover endpoint CRUD, secret rotation, test delivery, and seven-day attempt logs. Signature verification uses standard HMAC primitives.",
			},
		],
		codeExamples: [
			{
				language: "bash",
				label: "cURL — Register Webhook",
				code: `curl -X POST https://api.relayapi.dev/v1/webhooks \\
  -H "Authorization: Bearer rlay_live_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://yourapp.com/webhooks/relayapi",
    "events": [
      "post.published",
      "post.failed",
      "account.disconnected"
    ]
  }'

# Response:
# {
#   "id": "wh_m3n4o5p6q7",
#   "url": "https://yourapp.com/webhooks/relayapi",
#   "events": ["post.published", "post.failed", "account.disconnected"],
#   "secret": "whsec_...",
#   "enabled": true,
#   "created_at": "2026-03-20T10:30:00Z"
# }`,
			},
			{
				language: "json",
				label: "Webhook Payload",
				code: `{
  "id": "whd_r8s9t0u1v2",
  "event": "post.published",
  "data": {
    "post_id": "post_a1b2c3d4e5",
    "platform": "twitter",
    "url": "https://twitter.com/yourhandle/status/1902345678901234567"
  },
  "timestamp": "2026-03-20T14:00:05.000Z"
}`,
			},
			{
				language: "typescript",
				label: "TypeScript — Verify Signature",
				code: `import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const app = express();

function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string
): boolean {
  const expected = Buffer.from(createHmac("sha256", secret)
    .update(payload)
    .digest("hex"), "hex");
  const supplied = Buffer.from(
    signatureHeader.replace(/^sha256=/, ""),
    "hex"
  );

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Verify the raw request body before parsing JSON.
app.post("/webhooks/relayapi", express.raw({ type: "application/json" }), (req, res) => {
  const payload = req.body.toString("utf8");
  const signatureHeader = req.get("x-relayapi-signature") ?? "";
  const isValid = verifyWebhookSignature(
    payload,
    signatureHeader,
    process.env.RELAYAPI_WEBHOOK_SECRET!
  );

  if (!isValid) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(payload);
  console.log(event.id, event.event);
  res.status(200).json({ received: true });
});`,
			},
		],
		faq: [
			{
				question: "What event types are available?",
				answer:
					"The current catalog is: post.published, post.partial, post.failed, post.scheduled, post.recycled, thread.published, account.connected, account.disconnected, comment.received, message.received, message.sent, auto_post.created, auto_post.error, four streak events, and cross_post_action.executed/failed. Subscriptions require exact names; wildcards are not accepted.",
			},
			{
				question: "What happens if my endpoint is down when a webhook is sent?",
				answer:
					"Retryable HTTP responses and network failures are persisted and retried with bounded backoff. GET /v1/webhooks/logs exposes the last seven days of exact attempts and outcomes. The public API does not currently expose historical-event replay.",
			},
			{
				question: "How do I verify that a webhook is really from RelayAPI?",
				answer:
					"Compute HMAC-SHA256 over the unmodified request body with the secret returned when the endpoint was created or rotated. Compare it in constant time with the sha256= value in X-RelayAPI-Signature before parsing or processing the event.",
			},
			{
				question: "Are webhook deliveries guaranteed?",
				answer:
					"Consumers should implement at-least-once semantics: acknowledge only after durable processing and deduplicate with the delivery id in the payload or X-RelayAPI-Delivery-Id header. Do not depend on global ordering.",
			},
			{
				question: "Can I test webhooks during development?",
				answer:
					"Yes. Register a reachable HTTPS endpoint, then call POST /v1/webhooks/test with its webhook_id or use the dashboard's test action. The RelayAPI CLI does not currently provide a webhook tunnel command.",
			},
			{
				question: "Is there a way to receive multiple events in one request?",
				answer:
					"No. The current contract sends one event envelope per delivery. Batch configuration is not exposed by the webhook create or update schemas.",
			},
		],
	},
];

export function getApiBySlug(slug: string): ApiData | undefined {
	return apis.find((a) => a.slug === slug);
}
