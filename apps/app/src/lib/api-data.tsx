import type { ReactNode } from "react";

export interface ApiData {
	slug: string;
	name: string;
	icon: ReactNode;
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
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="size-4"
			>
				<line x1="22" y1="2" x2="11" y2="13" />
				<polygon points="22 2 15 22 11 13 2 9 22 2" />
			</svg>
		),
		heroTitle: "Posting API for Developers",
		heroDescription:
			"One REST API to publish content across 21 platforms. Post text, images, videos, and more with a single endpoint.",
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
				title: "One Integration, 17 Platforms",
				description:
					"Each social platform has its own auth flow, rate limits, and content rules. RelayAPI abstracts all 17 behind a single REST endpoint so you can focus on your product, not platform quirks.",
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
					"RelayAPI currently supports 21 platforms across social, messaging, and newsletter categories: Instagram, Facebook, LinkedIn, TikTok, YouTube, Bluesky, Mastodon, Threads, Pinterest, Reddit, Discord, Telegram, WhatsApp Business, Google Business Profile, Snapchat, X/Twitter, SMS, Beehiiv, ConvertKit, Mailchimp, and Listmonk. New platforms are added regularly.",
			},
			{
				question: "How far in advance can I schedule posts?",
				answer:
					"Posts can be scheduled up to 90 days in advance. Scheduled posts are stored durably and processed by a dedicated scheduler that guarantees delivery within 30 seconds of the target time. You can update or cancel a scheduled post at any time before it publishes.",
			},
			{
				question: "What media formats are supported for posts?",
				answer:
					"Images: JPEG, PNG, WebP, GIF (up to 20 MB). Videos: MP4, MOV, WebM (up to 500 MB). RelayAPI automatically converts and resizes media to meet each platform's requirements, so you only need to upload once.",
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
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="size-4"
			>
				<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
				<circle cx="8.5" cy="8.5" r="1.5" />
				<polyline points="21 15 16 10 5 21" />
			</svg>
		),
		heroTitle: "Media API for Developers",
		heroDescription:
			"Upload, optimize, and manage media files for social publishing. Automatic format conversion and platform-specific optimization.",
		features: [
			{
				title: "Direct File Upload",
				description:
					"Upload images and videos directly via multipart form data. Receive a stable media ID you can reference in any number of future posts across all platforms.",
			},
			{
				title: "URL-Based Upload",
				description:
					"Pass a public URL and RelayAPI fetches, validates, and stores the file for you. Ideal for pulling assets from your CMS, DAM, or CDN without an extra download step.",
			},
			{
				title: "Automatic Resizing & Optimization",
				description:
					"Every upload is automatically resized and compressed to meet each target platform's requirements — Instagram's square crops, Twitter's aspect ratios, LinkedIn's resolution limits — all handled server-side.",
			},
			{
				title: "Format Conversion",
				description:
					"Upload in any common format and RelayAPI converts as needed. WebP to JPEG for platforms that don't support it, MOV to MP4 for broader compatibility, and animated GIF to video where required.",
			},
			{
				title: "Thumbnail Generation",
				description:
					"Video uploads automatically generate multiple thumbnail options at key frames. Select a thumbnail via the API or let the platform choose the best one.",
			},
			{
				title: "Media Library Management",
				description:
					"Browse, search, tag, and organize all uploaded media through the API. Filter by type, upload date, usage status, or custom tags to keep your asset library under control.",
			},
			{
				title: "Global CDN Delivery",
				description:
					"All media is served from Cloudflare's global CDN with edge caching across 300+ locations. Your assets load fast regardless of where your audience is.",
			},
			{
				title: "Metadata Extraction",
				description:
					"Automatically extract EXIF data, dimensions, duration, codec information, and color profiles. Use metadata to build smart media selectors or audit your library.",
			},
		],
		benefits: [
			{
				title: "One Upload Endpoint, Every Format",
				description:
					"Building a media pipeline that handles format conversion, resizing for 21 platforms, and CDN delivery is a massive undertaking. RelayAPI gives you all of it through a single upload endpoint.",
			},
			{
				title: "Enterprise-Grade Reliability",
				description:
					"Media is stored on Cloudflare R2 with 99.999999999% durability and served from a global CDN with 99.9% uptime. Your files are safe and always accessible.",
			},
			{
				title: "Developer-First Experience",
				description:
					"Simple multipart upload, presigned URL support, comprehensive SDKs, and detailed API docs. Handle media in your app the way it should work — without fighting platform quirks.",
			},
		],
		codeExamples: [
			{
				language: "bash",
				label: "cURL",
				code: `curl -X POST https://api.relayapi.dev/v1/media \\
  -H "Authorization: Bearer rlay_live_xxxxxxxx" \\
  -F "file=@./product-hero.png" \\
  -F "alt_text=Product hero image showing the new dashboard" \\
  -F "tags=product,launch,2026"`,
			},
			{
				language: "typescript",
				label: "TypeScript",
				code: `const formData = new FormData();
formData.append("file", fileInput.files[0]);
formData.append("alt_text", "Product hero image showing the new dashboard");
formData.append("tags", "product,launch,2026");

const response = await fetch("https://api.relayapi.dev/v1/media", {
  method: "POST",
  headers: {
    Authorization: "Bearer rlay_live_xxxxxxxx",
  },
  body: formData,
});

const media = await response.json();
console.log(media.id);        // "med_a1b2c3d4e5"
console.log(media.url);       // CDN URL for the optimized file
console.log(media.variants);  // platform-specific versions`,
			},
			{
				language: "python",
				label: "Python",
				code: `import requests

with open("product-hero.png", "rb") as f:
    response = requests.post(
        "https://api.relayapi.dev/v1/media",
        headers={"Authorization": "Bearer rlay_live_xxxxxxxx"},
        files={"file": ("product-hero.png", f, "image/png")},
        data={
            "alt_text": "Product hero image showing the new dashboard",
            "tags": "product,launch,2026",
        },
    )

media = response.json()
print(media["id"])        # "med_a1b2c3d4e5"
print(media["url"])       # CDN URL for the optimized file
print(media["variants"])  # platform-specific versions`,
			},
		],
		faq: [
			{
				question: "What media formats are supported?",
				answer:
					"Images: JPEG, PNG, WebP, GIF, BMP, TIFF, SVG, and HEIC. Videos: MP4, MOV, WebM, AVI, and MKV. Audio: MP3, AAC, WAV, and OGG. If you upload a format a specific platform doesn't support, RelayAPI automatically converts it to a compatible format.",
			},
			{
				question: "What are the file size limits?",
				answer:
					"Images up to 20 MB, videos up to 1 GB, and audio up to 50 MB per file. If your video exceeds 100 MB, use the resumable upload endpoint which supports chunked uploads with automatic retry on interrupted connections.",
			},
			{
				question: "How does automatic optimization work?",
				answer:
					"When you upload a file, RelayAPI generates platform-optimized variants in the background. For example, an uploaded 4K image might produce a 1080x1080 Instagram variant, a 1600x900 Twitter card variant, and a 1200x627 LinkedIn variant — each compressed to the ideal quality/size balance for that platform.",
			},
			{
				question: "How long are uploaded files stored?",
				answer:
					"Media files are stored indefinitely on active plans. Files are served from Cloudflare R2 with 11 nines of durability. If you delete a media item via the API, it is permanently removed within 24 hours including all generated variants.",
			},
			{
				question: "Is there a CDN for serving uploaded media?",
				answer:
					"Yes. Every uploaded file is automatically served through Cloudflare's global CDN with edge caching in 300+ cities. Media URLs support cache-control headers and you can purge the cache for any file instantly via the API.",
			},
		],
	},

	// ─── Analytics API ──────────────────────────────────────────────────
	{
		slug: "analytics-api",
		name: "Analytics API",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="size-4"
			>
				<line x1="12" y1="20" x2="12" y2="10" />
				<line x1="18" y1="20" x2="18" y2="4" />
				<line x1="6" y1="20" x2="6" y2="16" />
			</svg>
		),
		heroTitle: "Analytics API for Developers",
		heroDescription:
			"Track engagement, reach, and performance across all connected platforms. Unified metrics in one dashboard.",
		features: [
			{
				title: "Cross-Platform Metrics",
				description:
					"Aggregate likes, shares, comments, impressions, and reach across all 21 platforms into a single normalized data model. Compare apples to apples regardless of the source.",
			},
			{
				title: "Engagement Tracking",
				description:
					"Monitor engagement rate, click-through rate, and interaction breakdowns for every post. Identify your highest-performing content and understand what resonates with your audience.",
			},
			{
				title: "Audience Insights",
				description:
					"Access follower growth, demographics, active hours, and geographic distribution for each connected account. Use data-driven insights to optimize your posting schedule and content strategy.",
			},
			{
				title: "Performance Comparison",
				description:
					"Compare performance across platforms, time periods, content types, or campaigns. Spot trends and outliers with built-in statistical summaries and percentage change calculations.",
			},
			{
				title: "Historical Data Access",
				description:
					"Query up to 24 months of historical analytics data. RelayAPI backfills metrics from the moment you connect an account, so you start with a full picture — not a blank slate.",
			},
			{
				title: "Export & Reporting",
				description:
					"Export analytics data as CSV or JSON for use in your own dashboards, BI tools, or client reports. Schedule automated exports to S3, GCS, or webhook endpoints.",
			},
			{
				title: "Real-Time Updates",
				description:
					"Metrics are refreshed every 15 minutes for active posts and hourly for older content. Request an on-demand refresh for any post when you need the latest numbers immediately.",
			},
			{
				title: "Custom Date Ranges",
				description:
					"Query analytics for any date range — last 7 days, last quarter, or a custom window. All responses include granularity options: hourly, daily, weekly, or monthly roll-ups.",
			},
		],
		benefits: [
			{
				title: "One Dashboard, Every Metric",
				description:
					"Every platform exposes metrics differently — different names, different update frequencies, different auth scopes. RelayAPI normalizes it all into a single, consistent analytics interface.",
			},
			{
				title: "Enterprise-Grade Reliability",
				description:
					"Metrics are collected on a resilient pipeline with 99.9% uptime. Automatic retries on failed fetches, data deduplication, and anomaly detection ensure your analytics are always accurate and available.",
			},
			{
				title: "Developer-First Experience",
				description:
					"Clean JSON responses, cursor-based pagination for large datasets, TypeScript types for every metric, and interactive API explorer. Build beautiful dashboards without wrestling with raw platform data.",
			},
		],
		codeExamples: [
			{
				language: "bash",
				label: "cURL — Post Analytics",
				code: `curl https://api.relayapi.dev/v1/analytics/posts/post_a1b2c3d4e5 \\
  -H "Authorization: Bearer rlay_live_xxxxxxxx"

# Response:
# {
#   "post_id": "post_a1b2c3d4e5",
#   "platforms": {
#     "twitter": { "impressions": 12450, "likes": 342, "retweets": 87, "replies": 23 },
#     "linkedin": { "impressions": 8700, "likes": 156, "comments": 42, "shares": 31 },
#     "bluesky": { "impressions": 3200, "likes": 98, "reposts": 24, "replies": 11 }
#   },
#   "totals": { "impressions": 24350, "engagements": 804, "engagement_rate": 0.033 }
# }`,
			},
			{
				language: "typescript",
				label: "TypeScript — Account Analytics",
				code: `const response = await fetch(
  "https://api.relayapi.dev/v1/analytics/accounts?" +
    new URLSearchParams({
      account_id: "acc_x9y8z7w6",
      start_date: "2026-03-01",
      end_date: "2026-03-20",
      granularity: "daily",
    }),
  {
    headers: { Authorization: "Bearer rlay_live_xxxxxxxx" },
  }
);

const analytics = await response.json();

for (const day of analytics.data) {
  console.log(\`\${day.date}: \${day.impressions} impressions, \${day.engagements} engagements\`);
}`,
			},
			{
				language: "python",
				label: "Python — Overview",
				code: `import requests

response = requests.get(
    "https://api.relayapi.dev/v1/analytics/overview",
    headers={"Authorization": "Bearer rlay_live_xxxxxxxx"},
    params={
        "start_date": "2026-03-01",
        "end_date": "2026-03-20",
    },
)

overview = response.json()

print(f"Total impressions: {overview['totals']['impressions']:,}")
print(f"Total engagements: {overview['totals']['engagements']:,}")
print(f"Avg engagement rate: {overview['totals']['engagement_rate']:.1%}")
print(f"Top platform: {overview['top_platform']['name']}")`,
			},
		],
		faq: [
			{
				question: "What metrics are available?",
				answer:
					"Core metrics include impressions, reach, engagements (likes, comments, shares, saves, clicks), engagement rate, follower growth, and video-specific metrics (views, watch time, completion rate). Each metric is broken down by platform and available as raw counts or computed rates.",
			},
			{
				question: "How often are metrics updated?",
				answer:
					"Posts published within the last 48 hours are refreshed every 15 minutes. Older posts are refreshed hourly. You can trigger an on-demand refresh for any post via the API, which returns updated metrics within 60 seconds. Account-level metrics are updated every 6 hours.",
			},
			{
				question: "How far back does historical data go?",
				answer:
					"RelayAPI stores up to 24 months of analytics data. When you first connect a social account, we backfill available historical data from each platform — typically 90 days for most platforms, though some provide up to 12 months of history.",
			},
			{
				question: "Are metrics available for all supported platforms?",
				answer:
					"Analytics are available for all 17 supported platforms, but the depth of data depends on what each platform's API exposes. Twitter, LinkedIn, and Instagram provide the richest analytics. Platforms like Mastodon and Bluesky provide core engagement counts. The API clearly indicates which metrics are available per platform.",
			},
			{
				question: "Can I export analytics data?",
				answer:
					"Yes. Use the /v1/analytics/export endpoint to download data as CSV or JSON. You can filter by date range, platform, and metric type. For automated reporting, set up scheduled exports that deliver data to your S3 bucket, webhook URL, or email on a daily or weekly cadence.",
			},
		],
	},

	// ─── Webhooks API ───────────────────────────────────────────────────
	{
		slug: "webhooks-api",
		name: "Webhooks API",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="size-4"
			>
				<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
				<path d="M13.73 21a2 2 0 0 1-3.46 0" />
			</svg>
		),
		heroTitle: "Webhooks API for Developers",
		heroDescription:
			"Real-time notifications for post delivery, engagement milestones, and account events. Never poll for status again.",
		features: [
			{
				title: "Delivery Confirmations",
				description:
					"Receive an instant webhook when a post is successfully published on each platform. Includes the live URL, platform-specific post ID, and final rendered content.",
			},
			{
				title: "Engagement Alerts",
				description:
					"Get notified when posts hit engagement milestones — 100 likes, 1K impressions, first comment, or custom thresholds you define. React to viral content in real time.",
			},
			{
				title: "Failure Notifications",
				description:
					"Know immediately when a post fails to publish, with detailed error codes, failure reasons, and whether a retry is scheduled. Build alerts or fallback flows without delay.",
			},
			{
				title: "Account Events",
				description:
					"Monitor account-level changes — token expirations, permission changes, rate limit warnings, and disconnections. Stay ahead of issues before they affect your users.",
			},
			{
				title: "Configurable Retry Logic",
				description:
					"Failed webhook deliveries are retried up to 5 times over 24 hours with exponential backoff. View delivery attempts, response codes, and timing in the webhook logs.",
			},
			{
				title: "Webhook Signing & Verification",
				description:
					"Every webhook payload is signed with HMAC-SHA256 using your endpoint's secret key. Verify signatures server-side to ensure payloads are authentic and untampered.",
			},
			{
				title: "Event Filtering",
				description:
					"Subscribe to exactly the events you care about. Filter by event type, platform, workspace, or post tags. Reduce noise and processing overhead with precise subscriptions.",
			},
			{
				title: "Batch Events",
				description:
					"For high-volume use cases, enable batch mode to receive multiple events in a single webhook delivery. Reduce HTTP overhead and simplify processing for busy integrations.",
			},
		],
		benefits: [
			{
				title: "One Webhook, Every Platform",
				description:
					"Building a reliable polling system across 21 platforms is fragile and expensive. RelayAPI pushes events to you the moment they happen, replacing thousands of polling requests with a single webhook endpoint.",
			},
			{
				title: "Enterprise-Grade Reliability",
				description:
					"Webhooks are delivered with 99.9% reliability backed by automatic retries, dead-letter queues, and delivery logging. Every event is stored for 30 days so you can replay missed deliveries at any time.",
			},
			{
				title: "Developer-First Experience",
				description:
					"Test webhooks locally with our CLI tunnel, inspect payloads in the dashboard, replay past events with one click, and use our SDKs for signature verification. Debugging webhooks has never been easier.",
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
      "post.engagement_milestone",
      "account.disconnected"
    ],
    "secret": "whsec_your_signing_secret_here"
  }'

# Response:
# {
#   "id": "wh_m3n4o5p6q7",
#   "url": "https://yourapp.com/webhooks/relayapi",
#   "events": ["post.published", "post.failed", "post.engagement_milestone", "account.disconnected"],
#   "status": "active",
#   "created_at": "2026-03-20T10:30:00Z"
# }`,
			},
			{
				language: "json",
				label: "Webhook Payload",
				code: `{
  "id": "evt_r8s9t0u1v2",
  "type": "post.published",
  "created_at": "2026-03-20T14:00:05Z",
  "data": {
    "post_id": "post_a1b2c3d4e5",
    "platform": "twitter",
    "platform_post_id": "1902345678901234567",
    "url": "https://twitter.com/yourhandle/status/1902345678901234567",
    "content": "Excited to announce our new product launch!",
    "published_at": "2026-03-20T14:00:03Z"
  }
}`,
			},
			{
				language: "typescript",
				label: "TypeScript — Verify Signature",
				code: `import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(\`sha256=\${expected}\`)
  );
}

// In your webhook handler:
app.post("/webhooks/relayapi", (req, res) => {
  const signature = req.headers["x-relayapi-signature"] as string;
  const isValid = verifyWebhookSignature(
    JSON.stringify(req.body),
    signature,
    process.env.WEBHOOK_SECRET!
  );

  if (!isValid) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.body;
  switch (event.type) {
    case "post.published":
      console.log(\`Post \${event.data.post_id} live at \${event.data.url}\`);
      break;
    case "post.failed":
      console.error(\`Post \${event.data.post_id} failed: \${event.data.error}\`);
      break;
  }

  res.status(200).json({ received: true });
});`,
			},
		],
		faq: [
			{
				question: "What event types are available?",
				answer:
					"Core events: post.published, post.failed, post.scheduled, post.deleted, post.engagement_milestone. Account events: account.connected, account.disconnected, account.token_expiring, account.rate_limited. Media events: media.processed, media.failed. You can subscribe to specific events or use wildcards like 'post.*' to receive all post-related events.",
			},
			{
				question: "What happens if my endpoint is down when a webhook is sent?",
				answer:
					"Failed deliveries are retried up to 5 times over 24 hours with exponential backoff (30s, 5m, 30m, 2h, 12h). If all retries fail, the event is moved to a dead-letter queue visible in your dashboard. You can replay any event from the last 30 days with a single API call or button click.",
			},
			{
				question: "How do I verify that a webhook is really from RelayAPI?",
				answer:
					"Every webhook includes an X-RelayAPI-Signature header containing an HMAC-SHA256 hash of the payload using your endpoint's secret key. Verify the signature server-side before processing. Our TypeScript and Python SDKs include a verifySignature() helper that handles this for you, including timing-safe comparison.",
			},
			{
				question: "Are webhook deliveries guaranteed?",
				answer:
					"RelayAPI guarantees at-least-once delivery. In rare cases (network partitions, retries), you may receive the same event more than once. Each event has a unique id field — use it to deduplicate on your end. Events are delivered in approximate chronological order but strict ordering is not guaranteed.",
			},
			{
				question: "Can I test webhooks during development?",
				answer:
					"Yes. Use the RelayAPI CLI to create a local tunnel: 'relayapi webhooks listen --port 3000'. This forwards live webhook events to your local dev server. You can also use the dashboard to send test events to any registered endpoint, or replay historical events to debug your handler.",
			},
			{
				question: "Is there a way to receive multiple events in one request?",
				answer:
					"Yes. Enable batch mode on your webhook endpoint to receive up to 100 events per delivery. Events are grouped by type and delivered every 5 seconds or when the batch reaches 100 events, whichever comes first. This is ideal for high-volume integrations that want to reduce HTTP overhead.",
			},
		],
	},
];

export function getApiBySlug(slug: string): ApiData | undefined {
	return apis.find((a) => a.slug === slug);
}
