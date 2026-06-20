
export interface PlatformData {
    slug: string;
    name: string;
    heroTitle: string;
    heroDescription: string;
    directApiName: string;
    painPoints: string[];
    solutions: string[];
    savingText: string;
    warningBanner?: { title: string; description: string };
    contentTypes: string[];
    features: { title: string; description: string }[];
    faq: { question: string; answer: string }[];
}

export const platforms: PlatformData[] = [
    {
        slug: "instagram",
        name: "Instagram",
        heroTitle: "One API Call to Post on Instagram",
        heroDescription:
            "The Instagram Graph API demands Facebook app review, complex OAuth flows, and strict media format requirements. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Instagram Graph API",
        painPoints: [
            "Facebook App Review can take weeks and requires detailed permissions justification for each scope",
            "Media must be hosted on a publicly accessible URL before publishing -- no direct uploads allowed",
            "Carousel posts require creating individual media containers, then combining them in a second API call",
            "Rate limits are opaque and inconsistent, varying by endpoint with no clear documentation",
            "Frequent deprecations and breaking changes between Graph API versions with short migration windows",
        ],
        solutions: [
            "RelayAPI manages the full OAuth flow and app review process so you never interact with Facebook Login directly",
            "Upload media to RelayAPI and we handle public hosting, CDN delivery, and URL generation automatically",
            "Create carousel posts with a single API call -- pass an array of media and we build the containers for you",
            "Built-in rate limit management with automatic retries, backoff, and request queuing across all endpoints",
            "We absorb Graph API version changes and deprecations so your integration never breaks",
        ],
        savingText: "Save 3+ hours of development time",
        warningBanner: {
            title: "Business or Creator Account Required",
            description:
                "Instagram publishing via the Graph API requires a Business or Creator account connected to a Facebook Page. Personal accounts cannot publish through the API.",
        },
        contentTypes: ["Photos", "Videos", "Stories", "Carousels", "Reels"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Go from zero to publishing Instagram posts in under 10 minutes. One API call replaces dozens of Graph API requests, container creation steps, and media hosting setup.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Instagram Graph API under the hood. You get full platform compliance without managing Facebook App Review, token refreshes, or permissions yourself.",
            },
            {
                title: "Carousels and Reels Made Simple",
                description:
                    "Publishing carousels and Reels through the Graph API requires multiple sequential requests. With RelayAPI, send one request with your media array and we handle the rest.",
            },
        ],
        faq: [
            {
                question: "Do I need a Business or Creator account to post to Instagram?",
                answer: "Yes. The Instagram Graph API only supports publishing for Business and Creator accounts linked to a Facebook Page. Personal Instagram accounts cannot publish via the API. You can convert your account in the Instagram app settings.",
            },
            {
                question: "What content types can I publish to Instagram through RelayAPI?",
                answer: "RelayAPI supports Photos, Videos, Stories, Carousels (up to 10 images/videos), and Reels. Each content type is handled through a single unified endpoint with automatic media format validation.",
            },
            {
                question: "How does RelayAPI compare to using the Instagram Graph API directly?",
                answer: "The Graph API requires you to manage Facebook App Review, host media on public URLs, create individual media containers for carousels, handle token refresh flows, and track API version migrations. RelayAPI wraps all of this into a single POST request.",
            },
            {
                question: "Can I schedule Instagram posts with RelayAPI?",
                answer: "Yes. You can pass a scheduled publish time with any post request. RelayAPI queues the content and publishes at the specified time, handling token validity and retry logic automatically.",
            },
            {
                question: "How does media handling work for Instagram?",
                answer: "Upload your media files directly to RelayAPI. We host them on our CDN, generate the public URLs Instagram requires, validate dimensions and formats, and clean up after publishing. No need to manage your own media hosting infrastructure.",
            },
        ],
    },
    {
        slug: "twitter",
        name: "X / Twitter",
        heroTitle: "One API Call to Post on X / Twitter",
        heroDescription:
            "The Twitter API v2 requires paid access tiers, strict OAuth 2.0 with PKCE, and imposes aggressive rate limits that vary by plan. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Twitter API v2",
        painPoints: [
            "Paid API access is mandatory -- even basic posting requires at least the Basic tier at $100/month",
            "OAuth 2.0 with PKCE and separate user-context vs app-context tokens adds significant auth complexity",
            "Tweet thread creation requires sequential API calls with reply-chaining and careful error handling",
            "Rate limits are extremely tight (e.g., 17 tweets per 24 hours on Basic tier) with opaque enforcement",
            "Media uploads use a separate chunked upload endpoint with finalization polling before attaching to tweets",
        ],
        solutions: [
            "Use your existing Twitter API credentials through RelayAPI without worrying about tier-specific endpoint restrictions",
            "RelayAPI handles the full OAuth 2.0 PKCE flow, token storage, and automatic refresh for user-context operations",
            "Post entire threads with a single API call -- pass an array of tweets and we chain the replies automatically",
            "Intelligent rate limit tracking with request queuing, automatic backoff, and usage monitoring per account",
            "Upload media to RelayAPI and we manage chunked uploads, processing status polling, and attachment to tweets",
        ],
        savingText: "Save 3+ hours of development time",
        contentTypes: ["Text Posts", "Images", "Videos", "Polls", "Threads"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Post tweets, threads, and media with a single API call. No need to manage chunked uploads, reply chains, or poll creation flows separately.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Twitter API v2. Your posts appear natively in timelines with full engagement metrics, while we handle token management and rate limit compliance.",
            },
            {
                title: "Threads Without the Complexity",
                description:
                    "Creating Twitter threads requires sequential replies with error handling at each step. RelayAPI lets you send an array of tweet content and we handle the reply-chaining, media attachment, and error recovery.",
            },
        ],
        faq: [
            {
                question: "Do I still need a Twitter API key to use RelayAPI?",
                answer: "You connect your X / Twitter account through RelayAPI's OAuth flow. We manage the API credentials, token lifecycle, and access tier limitations on your behalf.",
            },
            {
                question: "What content types can I publish to X / Twitter through RelayAPI?",
                answer: "RelayAPI supports text posts, images (up to 4 per tweet), videos (up to 2 minutes 20 seconds), polls, and multi-tweet threads. All through a single unified endpoint.",
            },
            {
                question: "How does RelayAPI handle Twitter's strict rate limits?",
                answer: "We track rate limit headers in real-time across all your connected accounts, queue requests when limits are approached, and automatically retry with exponential backoff. You receive clear error messages instead of opaque 429 responses.",
            },
            {
                question: "Can I post threads with RelayAPI?",
                answer: "Yes. Pass an array of tweet objects (each with optional media) in a single request. RelayAPI posts them sequentially as replies, handles failures gracefully, and returns the full thread with tweet IDs.",
            },
        ],
    },
    {
        slug: "linkedin",
        name: "LinkedIn",
        heroTitle: "One API Call to Post on LinkedIn",
        heroDescription:
            "The LinkedIn Marketing API requires partner program approval, complex URN-based content schemas, and strict OAuth 2.0 scopes. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "LinkedIn Marketing API",
        painPoints: [
            "Marketing API access requires LinkedIn Partner Program approval, which can take weeks with no guaranteed timeline",
            "Content creation uses URN-based schemas with nested JSON structures that differ between post types",
            "Image and video uploads require a two-step process: register the asset, then upload binary data to a pre-signed URL",
            "OAuth 2.0 tokens expire after 60 days with no refresh token on basic scopes, requiring users to re-authorize",
            "API versioning uses date-based headers and LinkedIn frequently deprecates endpoints with limited migration guides",
        ],
        solutions: [
            "RelayAPI manages LinkedIn Partner Program compliance and permissions so you can start posting immediately",
            "Simple JSON payloads replace complex URN schemas -- just pass your text, media, and targeting parameters",
            "Upload media directly to RelayAPI and we handle asset registration, binary upload, and URN resolution",
            "Automatic token refresh and re-authorization flows keep your LinkedIn connections active indefinitely",
            "We track LinkedIn API version changes and update our integration layer so your code never breaks",
        ],
        savingText: "Save 3+ hours of development time",
        contentTypes: ["Text Posts", "Images", "Videos", "Documents", "Articles", "Polls"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Publish LinkedIn posts with a single API call. No URN construction, no asset registration, no nested JSON schemas. Just send your content and go.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official LinkedIn Marketing API. Your posts appear natively in feeds with full analytics, while we handle partner program compliance and token lifecycle.",
            },
            {
                title: "Rich Media Without the Complexity",
                description:
                    "LinkedIn's multi-step media upload process (register, upload, attach) is reduced to a single request. Support for images, videos, documents, and multi-image posts out of the box.",
            },
        ],
        faq: [
            {
                question: "Do I need LinkedIn Marketing API access to use RelayAPI?",
                answer: "No. RelayAPI handles the Marketing API access and partner program requirements. You connect your LinkedIn account through our OAuth flow and can start publishing immediately.",
            },
            {
                question: "What content types can I publish to LinkedIn through RelayAPI?",
                answer: "RelayAPI supports text posts, single images, multi-image posts, native videos, document sharing (PDFs), articles, and polls. All through one unified endpoint.",
            },
            {
                question: "Can I post to LinkedIn Company Pages?",
                answer: "Yes. You can publish to both personal profiles and Company Pages you administer. Specify the target in your request and RelayAPI handles the different URN formats and permission scopes.",
            },
            {
                question: "How does RelayAPI handle LinkedIn token expiration?",
                answer: "LinkedIn access tokens expire after 60 days. RelayAPI monitors token validity, uses refresh tokens where available, and notifies you proactively if re-authorization is needed -- before your publishing flow breaks.",
            },
        ],
    },
    {
        slug: "whatsapp",
        name: "WhatsApp",
        heroTitle: "One API Call to Message on WhatsApp",
        heroDescription:
            "The WhatsApp Business Platform requires Meta business verification, pre-approved message templates, and complex webhook handling. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "WhatsApp Business Platform API",
        painPoints: [
            "Meta Business verification and WhatsApp Business API access approval can take days to weeks",
            "All outbound messages outside 24-hour windows must use pre-approved message templates reviewed by Meta",
            "Webhook setup requires HTTPS endpoints, signature verification, and handling multiple event types",
            "Phone number registration, quality rating, and messaging limits are tightly coupled and hard to manage",
            "Media uploads require hosting files on public URLs or uploading to the WhatsApp media endpoint with resumable uploads",
        ],
        solutions: [
            "RelayAPI streamlines the business verification and API access process with guided setup and status tracking",
            "Manage and submit message templates through RelayAPI with status tracking and automatic formatting",
            "We handle webhook infrastructure, signature verification, and event routing -- you get clean callbacks",
            "Built-in phone number management with quality monitoring and automatic messaging limit optimization",
            "Upload media directly to RelayAPI -- we handle format conversion, hosting, and WhatsApp media endpoint integration",
        ],
        savingText: "Save 4+ hours of development time",
        warningBanner: {
            title: "WhatsApp Business Account Required",
            description:
                "Publishing via the WhatsApp Business Platform API requires a verified Meta Business account and an approved WhatsApp Business phone number. Personal WhatsApp accounts cannot be used.",
        },
        contentTypes: ["Text Messages", "Images", "Videos", "Documents", "Templates", "Interactive Messages"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Send WhatsApp messages with a single API call. No webhook infrastructure, no template XML, no media hosting. Connect your Business account and start messaging.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official WhatsApp Business Platform API. Messages are delivered natively with read receipts and delivery status, while we handle verification and compliance.",
            },
            {
                title: "Template Management Made Simple",
                description:
                    "Create, submit, and track message template approvals through RelayAPI. We handle template formatting, variable substitution, and locale management across your campaigns.",
            },
        ],
        faq: [
            {
                question: "Do I need a WhatsApp Business account to send messages?",
                answer: "Yes. The WhatsApp Business Platform API requires a Meta Business account with a registered WhatsApp Business phone number. Personal WhatsApp accounts are not supported for API messaging.",
            },
            {
                question: "What message types can I send through RelayAPI?",
                answer: "RelayAPI supports text messages, images, videos, documents, audio, location sharing, contacts, pre-approved templates with variables, and interactive messages (buttons, lists).",
            },
            {
                question: "How do message templates work?",
                answer: "To message users outside the 24-hour conversation window, you must use Meta-approved templates. RelayAPI lets you create, submit for review, and manage templates through our API. Once approved, send them with dynamic variables in a single call.",
            },
            {
                question: "Can I receive and reply to incoming WhatsApp messages?",
                answer: "Yes. RelayAPI handles the webhook infrastructure for incoming messages. You receive clean webhook callbacks with parsed message content, and can reply within the 24-hour session window using free-form messages.",
            },
        ],
    },
    {
        slug: "pinterest",
        name: "Pinterest",
        heroTitle: "One API Call to Pin on Pinterest",
        heroDescription:
            "The Pinterest API v5 requires app review with business use case justification, complex board management, and strict image format requirements. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Pinterest API v5",
        painPoints: [
            "App access requires Pinterest business account verification and app review with detailed use case documentation",
            "Pin creation requires separate board management, and board IDs must be resolved before creating pins",
            "Image specifications are strict -- minimum 100x100 pixels, recommended 1000x1500, with specific aspect ratio requirements",
            "Rate limits are per-user and per-app with different tiers, and exceeding them results in 24-hour lockouts",
            "Video pin creation uses an async processing pipeline with status polling before the pin becomes visible",
        ],
        solutions: [
            "RelayAPI handles Pinterest business verification and app review so you can start pinning immediately",
            "Create pins with board names instead of IDs -- we resolve boards automatically and create them if needed",
            "Upload any image and RelayAPI validates dimensions, resizes if needed, and ensures Pinterest format compliance",
            "Intelligent rate limit management with per-account tracking, automatic queuing, and lockout prevention",
            "Video processing is handled asynchronously with automatic status polling and webhook notifications on completion",
        ],
        savingText: "Save 3+ hours of development time",
        warningBanner: {
            title: "Pinterest Business Account Required",
            description:
                "Publishing Pins via the Pinterest API requires a Pinterest Business account. Personal accounts must be converted to Business accounts in Pinterest settings.",
        },
        contentTypes: ["Image Pins", "Video Pins", "Idea Pins", "Product Pins", "Carousel Pins"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Create Pinterest Pins with a single API call. No board ID lookups, no image resizing, no video processing polls. Send your content and link, we handle the rest.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Pinterest API v5. Your Pins appear natively with full SEO benefits and analytics, while we manage app review, tokens, and format compliance.",
            },
            {
                title: "Visual Content Optimization",
                description:
                    "Pinterest rewards specific image dimensions and formats. RelayAPI automatically optimizes your media for maximum reach, handling aspect ratios, resizing, and format conversion.",
            },
        ],
        faq: [
            {
                question: "Do I need a Pinterest Business account?",
                answer: "Yes. The Pinterest API only supports Business accounts. You can convert a personal account to a Business account for free in your Pinterest settings.",
            },
            {
                question: "What content types can I publish to Pinterest through RelayAPI?",
                answer: "RelayAPI supports Image Pins, Video Pins, Idea Pins (multi-page stories), Product Pins with shopping metadata, and Carousel Pins. All with automatic format optimization.",
            },
            {
                question: "How does RelayAPI handle Pinterest's image requirements?",
                answer: "Pinterest recommends 1000x1500 pixel images with a 2:3 aspect ratio. RelayAPI validates your images, warns about suboptimal dimensions, and can resize automatically to maximize Pin performance.",
            },
            {
                question: "Can I manage Pinterest boards through RelayAPI?",
                answer: "Yes. You can create boards, list existing boards, and specify target boards by name when creating Pins. RelayAPI resolves board names to IDs automatically.",
            },
        ],
    },
    {
        slug: "bluesky",
        name: "Bluesky",
        heroTitle: "One API Call to Post on Bluesky",
        heroDescription:
            "The AT Protocol API uses a decentralized identity model with DIDs, record-based content creation, and blob uploads for media. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "AT Protocol (Bluesky API)",
        painPoints: [
            "The AT Protocol uses decentralized identifiers (DIDs) and handle resolution that differ from traditional REST APIs",
            "Content creation requires constructing lexicon-based records with facets for links, mentions, and hashtags",
            "Media uploads use a blob upload endpoint with CID-based references that must be resolved before posting",
            "Video uploads require PDS DID resolution and separate service authentication for the video processing endpoint",
            "Rich text parsing requires manual byte-offset calculation for facets (links, mentions, tags) with UTF-8 grapheme counting",
        ],
        solutions: [
            "RelayAPI abstracts DID resolution and handle management -- just pass a username and we handle identity",
            "Post with plain text and RelayAPI automatically detects and creates facets for links, mentions, and hashtags",
            "Upload media to RelayAPI and we handle blob uploads, CID resolution, and record embedding automatically",
            "Video uploads work with a single API call -- we manage PDS DID resolution, service auth, and processing",
            "Automatic rich text parsing with correct UTF-8 byte offset calculation for all facet types",
        ],
        savingText: "Save 3+ hours of development time",
        contentTypes: ["Text Posts", "Images", "Videos", "Links", "Quote Posts", "Threads"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Post to Bluesky with a single API call. No DID resolution, no facet construction, no blob CID management. Send your text and media, we create the AT Protocol records.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official AT Protocol API. Your posts appear natively in Bluesky feeds with full engagement features, while we handle decentralized identity and record management.",
            },
            {
                title: "Rich Text Without Byte Counting",
                description:
                    "AT Protocol requires precise UTF-8 byte offsets for every link, mention, and hashtag. RelayAPI parses your text automatically and generates correct facets, including proper grapheme counting for international text.",
            },
        ],
        faq: [
            {
                question: "Do I need an app password to connect my Bluesky account?",
                answer: "You can connect via app password or OAuth. RelayAPI supports both authentication methods. App passwords can be generated in your Bluesky account settings and provide scoped API access.",
            },
            {
                question: "What content types can I publish to Bluesky through RelayAPI?",
                answer: "RelayAPI supports text posts (up to 300 characters with automatic grapheme counting), images (up to 4 per post), videos, link cards with previews, quote posts, and threaded replies.",
            },
            {
                question: "How does RelayAPI handle Bluesky's rich text facets?",
                answer: "AT Protocol requires byte-level offsets for links, mentions, and hashtags. RelayAPI automatically parses your text, detects rich text elements, resolves mention handles to DIDs, and constructs facets with correct UTF-8 byte positions.",
            },
            {
                question: "Can I post to custom Bluesky PDS instances?",
                answer: "Yes. RelayAPI supports posting to any AT Protocol PDS, not just bsky.social. Specify your PDS endpoint when connecting your account and we handle DID resolution for your instance.",
            },
        ],
    },
    {
        slug: "google-business",
        name: "Google Business",
        heroTitle: "One API Call to Post on Google Business",
        heroDescription:
            "The Google Business Profile API requires Google Cloud project setup, complex location-based resource paths, and limited posting capabilities. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Google Business Profile API",
        painPoints: [
            "Google Cloud project setup with OAuth consent screen configuration and business verification is complex and slow",
            "API uses deeply nested resource paths (accounts/locations/localPosts) with account and location IDs required for every call",
            "Post types are limited and each has different required fields, media requirements, and call-to-action configurations",
            "OAuth scopes are specific and granular -- different permissions needed for reading, posting, and managing reviews",
            "Google frequently changes the Business Profile API with deprecations and moves between different Google API surfaces",
        ],
        solutions: [
            "RelayAPI handles Google Cloud configuration, OAuth consent, and business verification in a guided setup flow",
            "Post using simple location names or IDs -- we resolve the full resource path and manage account/location mapping",
            "Unified post format with automatic field validation and call-to-action configuration for all post types",
            "We manage all required OAuth scopes and permissions, requesting only what's needed for your use case",
            "Our integration layer absorbs Google API surface changes, deprecations, and endpoint migrations automatically",
        ],
        savingText: "Save 3+ hours of development time",
        warningBanner: {
            title: "Verified Google Business Profile Required",
            description:
                "Publishing through the Google Business Profile API requires a verified Google Business Profile. Your business location must be claimed and verified by Google before API posting is available.",
        },
        contentTypes: ["Updates", "Offers", "Events", "Photos", "Products"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Publish Google Business posts with a single API call. No resource path construction, no location ID lookups, no post type-specific field mapping. Send your content and call-to-action, we handle the rest.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Google Business Profile API. Your posts appear in Google Search and Maps, while we handle Google Cloud project setup, verification, and OAuth complexity.",
            },
            {
                title: "Multi-Location Management",
                description:
                    "Managing posts across multiple business locations requires complex account/location resolution. RelayAPI lets you post to any location by name and supports bulk publishing across all your locations.",
            },
        ],
        faq: [
            {
                question: "Do I need a verified Google Business Profile?",
                answer: "Yes. Your business must have a claimed and verified Google Business Profile before you can publish posts via the API. Verification typically involves receiving a postcard or phone verification from Google.",
            },
            {
                question: "What types of posts can I publish to Google Business?",
                answer: "RelayAPI supports Updates (general posts), Offers (with coupon codes and redemption links), Events (with dates and details), Photos, and Product posts. Each with automatic CTA button configuration.",
            },
            {
                question: "Can I post to multiple business locations at once?",
                answer: "Yes. RelayAPI supports multi-location publishing. You can target specific locations by name or ID, or broadcast a post across all your verified locations in a single request.",
            },
            {
                question: "How long do Google Business posts stay visible?",
                answer: "Standard update posts are visible for about 6 months. Event posts are visible until the event end date. Offer posts expire based on your specified offer period. RelayAPI lets you set these parameters and schedule posts accordingly.",
            },
        ],
    },
    {
        slug: "tiktok",
        name: "TikTok",
        heroTitle: "One API Call to Post on TikTok",
        heroDescription:
            "The TikTok Content Posting API requires developer app approval, video-first content requirements, and complex disclosure labeling. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "TikTok Content Posting API",
        painPoints: [
            "TikTok developer app approval requires detailed use case review and can take several weeks with back-and-forth",
            "Video uploads use a multi-step init/upload/publish flow with chunk uploads for files over 64MB",
            "Content disclosure requirements (paid partnership, branded content) must be set correctly or posts are rejected",
            "OAuth uses a non-standard flow with limited scope control and tokens that expire after 24 hours",
            "The API is relatively new and changes frequently, with features being added and deprecated rapidly",
        ],
        solutions: [
            "RelayAPI manages the developer app approval process and maintains API access compliance on your behalf",
            "Upload videos to RelayAPI with a single call -- we handle chunking, init/upload/publish flow, and processing",
            "Content disclosure labels are set through simple parameters -- we validate and format them per TikTok requirements",
            "Automatic token refresh handles TikTok's short-lived tokens so your publishing flow never breaks",
            "We track TikTok API changes daily and update our integration layer, so your code stays stable",
        ],
        savingText: "Save 3+ hours of development time",
        warningBanner: {
            title: "TikTok Creator or Business Account Required",
            description:
                "Publishing via the TikTok Content Posting API requires a Creator or Business account. The API does not support direct publishing -- videos are posted as drafts that users must confirm in the TikTok app.",
        },
        contentTypes: ["Videos", "Photo Posts", "Carousels"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Publish TikTok content with a single API call. No multi-step upload flow, no chunk management, no disclosure label formatting. Send your video and metadata, we handle the pipeline.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official TikTok Content Posting API. Your content goes through TikTok's native pipeline with full creator tools support, while we manage app approval and token lifecycle.",
            },
            {
                title: "Compliance Built In",
                description:
                    "TikTok's content disclosure requirements are complex and strictly enforced. RelayAPI validates disclosure labels, branded content tags, and privacy settings before submission to prevent rejections.",
            },
        ],
        faq: [
            {
                question: "Are TikTok posts published directly or as drafts?",
                answer: "The TikTok Content Posting API publishes content as drafts by default, which users must confirm in the TikTok app. Some approved applications can publish directly. RelayAPI supports both modes depending on your API access level.",
            },
            {
                question: "What content types can I publish to TikTok through RelayAPI?",
                answer: "RelayAPI supports video uploads (the primary TikTok format), photo posts, and photo carousels. Videos can include captions, hashtags, and disclosure labels. We handle format validation and transcoding requirements.",
            },
            {
                question: "How does RelayAPI handle TikTok's video requirements?",
                answer: "TikTok has specific requirements for video format, resolution, duration, and file size. RelayAPI validates your videos before upload, handles chunked uploads for large files, and manages the async processing pipeline.",
            },
            {
                question: "Can I add music or effects through the API?",
                answer: "The TikTok Content Posting API does not support adding music or effects programmatically. Videos must be fully produced before upload. RelayAPI focuses on reliable publishing of your pre-produced content.",
            },
        ],
    },
    {
        slug: "facebook",
        name: "Facebook",
        heroTitle: "One API Call to Post on Facebook",
        heroDescription:
            "The Facebook Graph API requires app review, complex permission scopes, and Page-based publishing workflows with nested API calls. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Facebook Graph API",
        painPoints: [
            "Facebook App Review requires detailed permission justifications, screencasts, and can take weeks of back-and-forth",
            "Page publishing requires Page access tokens that are separate from user tokens, with their own refresh lifecycle",
            "Multi-photo posts, videos, and Reels each use different endpoints with different payload formats",
            "Rate limiting is opaque -- limits are per-app, per-user, and per-Page with no clear documentation on thresholds",
            "Graph API version deprecation happens on a fixed schedule, and breaking changes require regular migration effort",
        ],
        solutions: [
            "RelayAPI manages the app review process and maintains all required permissions so you never deal with Meta review",
            "We handle Page token management, user-to-Page token exchange, and automatic token refresh behind the scenes",
            "Unified post endpoint works for text, photos, videos, and Reels -- we route to the correct Graph API endpoint",
            "Built-in rate limit tracking across app, user, and Page scopes with automatic queuing and backoff",
            "We migrate between Graph API versions automatically and absorb breaking changes in our integration layer",
        ],
        savingText: "Save 3+ hours of development time",
        warningBanner: {
            title: "Facebook Page Required",
            description:
                "Publishing via the Facebook Graph API requires a Facebook Page. Personal profile posting is not supported through the API. You must be an admin or editor of the Page.",
        },
        contentTypes: ["Text Posts", "Photos", "Videos", "Reels", "Stories", "Links"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Publish to Facebook Pages with a single API call. No app review, no Page token management, no endpoint routing by content type. Send your content and we handle everything.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Facebook Graph API. Your posts appear natively in feeds with full engagement features, while we handle app review, token management, and version migrations.",
            },
            {
                title: "All Content Types, One Endpoint",
                description:
                    "Facebook uses different API endpoints for text, photos, videos, Reels, and Stories. RelayAPI provides a single unified endpoint that automatically routes to the correct Graph API surface based on your content.",
            },
        ],
        faq: [
            {
                question: "Can I post to personal Facebook profiles?",
                answer: "No. The Facebook Graph API only supports publishing to Pages, not personal profiles. You need a Facebook Page where you are an admin or editor to publish content through the API.",
            },
            {
                question: "What content types can I publish to Facebook through RelayAPI?",
                answer: "RelayAPI supports text posts, single and multi-photo posts, videos, Reels, Stories, and link posts with rich previews. All content types are available through one unified endpoint.",
            },
            {
                question: "How does RelayAPI compare to using the Graph API directly?",
                answer: "The Graph API requires app review (weeks), separate Page tokens, different endpoints per content type, manual version migrations, and complex permission scopes. RelayAPI replaces all of this with a single authenticated POST request.",
            },
            {
                question: "Can I schedule Facebook posts with RelayAPI?",
                answer: "Yes. You can pass a scheduled publish time with your request. RelayAPI uses Facebook's native scheduling where available, or manages the scheduling queue and publishes at the specified time.",
            },
        ],
    },
    {
        slug: "youtube",
        name: "YouTube",
        heroTitle: "One API Call to Upload on YouTube",
        heroDescription:
            "The YouTube Data API v3 requires Google Cloud project setup, complex resumable uploads, and strict quota limits that cost real money to exceed. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "YouTube Data API v3",
        painPoints: [
            "Google Cloud project setup with OAuth consent screen, API enablement, and quota requests is complex and time-consuming",
            "Video uploads use resumable upload protocol with chunk management, progress tracking, and failure recovery",
            "Default API quota is 10,000 units/day -- a single video upload costs 1,600 units, allowing only ~6 uploads per day",
            "Thumbnail uploads, captions, and playlist management each require separate API calls with different endpoints",
            "YouTube Shorts require specific aspect ratios and duration limits but use the same upload endpoint with metadata flags",
        ],
        solutions: [
            "RelayAPI handles Google Cloud configuration, OAuth setup, and quota management so you can focus on your content",
            "Upload videos with a single API call -- we manage resumable uploads, chunk management, and automatic retry on failure",
            "Our quota optimization minimizes API unit usage per operation and pools quota across operations intelligently",
            "Set thumbnails, captions, and playlist assignments in the same request as your video upload",
            "Shorts are handled automatically -- we detect vertical video, set the correct metadata, and add the #Shorts tag",
        ],
        savingText: "Save 4+ hours of development time",
        warningBanner: {
            title: "YouTube Channel Required",
            description:
                "Publishing via the YouTube Data API requires a YouTube channel linked to your Google account. Brand Accounts provide better team management. API quota limits apply and may require a quota increase request.",
        },
        contentTypes: ["Videos", "Shorts", "Community Posts"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Upload YouTube videos with a single API call. No resumable upload protocol, no chunk management, no separate thumbnail/caption requests. Send your video file and metadata, we handle the pipeline.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official YouTube Data API v3. Your videos are published natively with full YouTube features (monetization, analytics, captions), while we handle Google Cloud setup and quota management.",
            },
            {
                title: "Quota-Optimized Uploads",
                description:
                    "YouTube's 10,000 units/day quota is severely limiting. RelayAPI optimizes API unit usage, batches metadata operations, and manages quota budgets so you can upload more videos without hitting limits.",
            },
        ],
        faq: [
            {
                question: "Do I need a YouTube Brand Account?",
                answer: "You need a YouTube channel, which can be on a personal Google account or a Brand Account. Brand Accounts are recommended for team management and organization. RelayAPI supports both account types.",
            },
            {
                question: "What content types can I publish to YouTube through RelayAPI?",
                answer: "RelayAPI supports standard video uploads, YouTube Shorts (vertical, under 60 seconds), and Community Posts (text, images, polls for eligible channels). Thumbnails and captions can be set in the same request.",
            },
            {
                question: "How does RelayAPI handle YouTube's quota limits?",
                answer: "YouTube's default quota is 10,000 units/day. A video upload costs 1,600 units. RelayAPI optimizes unit usage by batching operations and provides quota monitoring. If you need higher limits, we guide you through Google's quota increase request process.",
            },
            {
                question: "Can I upload YouTube Shorts through RelayAPI?",
                answer: "Yes. Upload vertical video (9:16 aspect ratio, under 60 seconds) and RelayAPI automatically flags it as a Short, adds appropriate metadata, and ensures it appears in the Shorts shelf.",
            },
            {
                question: "Can I schedule YouTube video publishes?",
                answer: "Yes. You can upload videos as private or unlisted with a scheduled publish time. RelayAPI sets the appropriate privacy status and scheduled publish timestamp using YouTube's native scheduling feature.",
            },
        ],
    },
    {
        slug: "threads",
        name: "Threads",
        heroTitle: "One API Call to Post on Threads",
        heroDescription:
            "The Threads API requires Instagram Business account linkage, Meta app review, and shares the Instagram Graph API's complexity. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Threads API",
        painPoints: [
            "Threads API access requires an Instagram Business or Creator account linked to a Facebook Page, plus Meta app review",
            "Media container creation uses a two-step flow similar to Instagram -- create container, then publish it",
            "Rate limits are shared with Instagram API quotas, making cross-platform publishing harder to manage",
            "The API is relatively new with limited documentation and features compared to more mature platform APIs",
            "Text formatting is limited and URL/mention detection requires specific formatting patterns",
        ],
        solutions: [
            "RelayAPI manages the Instagram account linkage and Meta app review process for seamless Threads access",
            "Publish Threads posts with a single API call -- we handle the two-step container creation and publishing flow",
            "Smart rate limit management across both Instagram and Threads quotas with unified tracking and queuing",
            "We stay on top of Threads API updates and new features, adding support as soon as they become available",
            "Automatic URL and mention detection with proper formatting -- just send plain text and we handle enrichment",
        ],
        savingText: "Save 3+ hours of development time",
        warningBanner: {
            title: "Instagram Business or Creator Account Required",
            description:
                "The Threads API requires your Threads account to be linked to an Instagram Business or Creator account connected to a Facebook Page. Personal accounts are not supported.",
        },
        contentTypes: ["Text Posts", "Images", "Videos", "Carousels", "Links"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Post to Threads with a single API call. No container creation, no two-step publishing flow, no Instagram account juggling. Send your content and we handle the Threads-specific pipeline.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Threads API. Your posts appear natively in Threads feeds with full engagement, while we handle Meta app review, account linkage, and API updates.",
            },
            {
                title: "Cross-Post to Instagram and Threads",
                description:
                    "Since Threads shares infrastructure with Instagram, RelayAPI lets you publish to both platforms simultaneously with a single request, optimizing content for each platform's format requirements.",
            },
        ],
        faq: [
            {
                question: "Do I need an Instagram account to post to Threads?",
                answer: "Yes. The Threads API requires an Instagram Business or Creator account linked to your Threads profile. Personal Instagram accounts are not supported for API access.",
            },
            {
                question: "What content types can I publish to Threads through RelayAPI?",
                answer: "RelayAPI supports text posts (up to 500 characters), single images, videos, carousel posts (up to 10 items), and link posts. Reply threads are also supported.",
            },
            {
                question: "How does RelayAPI handle the Threads and Instagram rate limit overlap?",
                answer: "Threads and Instagram share API quota. RelayAPI tracks usage across both platforms in real-time, manages a unified rate limit budget, and queues requests to prevent either platform from hitting limits.",
            },
            {
                question: "Can I schedule Threads posts with RelayAPI?",
                answer: "Yes. Pass a scheduled publish time with your request and RelayAPI queues the content for publication at the specified time, handling token validity and retry logic automatically.",
            },
        ],
    },
    {
        slug: "reddit",
        name: "Reddit",
        heroTitle: "One API Call to Post on Reddit",
        heroDescription:
            "The Reddit API requires OAuth app registration, subreddit-specific rules enforcement, and aggressive rate limiting with strict user-agent requirements. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Reddit API",
        painPoints: [
            "OAuth app registration requires manual approval for higher rate limits, and user-agent strings must follow a specific format",
            "Each subreddit has different posting rules (flair requirements, title formats, link vs self-post restrictions) that the API doesn't validate upfront",
            "Rate limits are strict (100 requests per minute for OAuth apps) and exceed penalties can result in temporary bans",
            "Media uploads use a separate endpoint and require polling for processing completion before referencing in posts",
            "Reddit's API documentation is inconsistent, with undocumented endpoints and behavior differences between old and new Reddit",
        ],
        solutions: [
            "RelayAPI manages OAuth credentials, user-agent formatting, and rate tier optimization automatically",
            "We validate posts against subreddit rules before submission, preventing silent failures and moderator removals",
            "Intelligent rate limit tracking with request queuing, backoff, and per-account usage monitoring",
            "Upload media to RelayAPI and we handle the upload endpoint, processing wait, and post attachment seamlessly",
            "Our integration is tested against actual Reddit behavior, not just documentation, ensuring reliable posting",
        ],
        savingText: "Save 3+ hours of development time",
        contentTypes: ["Text Posts", "Link Posts", "Images", "Videos", "Polls", "Crossposts"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Submit Reddit posts with a single API call. No subreddit rule lookups, no media processing polls, no user-agent formatting. Specify the subreddit, content type, and post body -- we handle the rest.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Reddit API. Your posts appear natively in subreddits with full voting and commenting, while we handle OAuth, rate limits, and subreddit rule validation.",
            },
            {
                title: "Subreddit Rule Validation",
                description:
                    "Reddit silently removes posts that violate subreddit rules. RelayAPI pre-validates your posts against flair requirements, title formats, and content restrictions before submission.",
            },
        ],
        faq: [
            {
                question: "Do I need a Reddit account to post through RelayAPI?",
                answer: "Yes. You connect your Reddit account through our OAuth flow. Posts are submitted under your Reddit username, and you must have sufficient karma and account age to post in most subreddits.",
            },
            {
                question: "What content types can I submit to Reddit through RelayAPI?",
                answer: "RelayAPI supports text posts (self-posts), link posts, image posts (single or gallery), video posts, polls, and crossposts. Each with automatic flair detection and subreddit rule validation.",
            },
            {
                question: "How does RelayAPI handle subreddit-specific rules?",
                answer: "We fetch and cache subreddit rules, then validate your post before submission. This includes flair requirements, title format rules, allowed domains, content type restrictions, and posting frequency limits.",
            },
            {
                question: "Can I post to multiple subreddits at once?",
                answer: "Yes, but be aware that Reddit discourages spam-like cross-posting. RelayAPI supports multi-subreddit posting with appropriate delays and uses native crosspost functionality where possible to stay within Reddit's guidelines.",
            },
        ],
    },
    {
        slug: "telegram",
        name: "Telegram",
        heroTitle: "One API Call to Message on Telegram",
        heroDescription:
            "The Telegram Bot API requires bot creation through BotFather, webhook configuration, and understanding of chat-based messaging models. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Telegram Bot API",
        painPoints: [
            "Bot creation through BotFather is manual, and managing bot tokens across environments requires careful secret management",
            "Webhook setup requires HTTPS endpoints with valid SSL certificates and handling Telegram's specific update format",
            "Sending to channels requires the bot to be added as an admin, and group messaging has different permission models",
            "Rate limits are per-bot and per-chat with different thresholds (30 messages/second to chats, 20 messages/minute to groups)",
            "Media groups (albums) require sending multiple messages with a specific media_group_id and handling partial failures",
        ],
        solutions: [
            "RelayAPI manages bot tokens securely and handles environment-specific configuration automatically",
            "We provide webhook infrastructure with SSL, update parsing, and event routing -- no server setup required",
            "Publish to channels, groups, and individual chats with a unified API -- we handle permission resolution",
            "Intelligent rate limit management with per-chat and per-group tracking, automatic queuing, and retry logic",
            "Send media albums with a single request -- we construct the media group, handle partial failures, and confirm delivery",
        ],
        savingText: "Save 3+ hours of development time",
        contentTypes: ["Text Messages", "Photos", "Videos", "Documents", "Audio", "Polls", "Media Groups"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Send Telegram messages with a single API call. No webhook server, no bot token management, no media group construction. Specify the chat, content, and formatting -- we handle delivery.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Telegram Bot API. Your messages are delivered natively with read receipts and inline keyboards, while we handle bot management, webhooks, and rate limits.",
            },
            {
                title: "Channel and Group Publishing",
                description:
                    "Publishing to Telegram channels and groups requires admin permissions and different API patterns. RelayAPI unifies channel, group, and direct messaging into a single endpoint with automatic permission handling.",
            },
        ],
        faq: [
            {
                question: "Do I need to create a Telegram bot?",
                answer: "Yes. Telegram's API requires a bot for programmatic messaging. You create a bot via BotFather and connect it through RelayAPI. Your bot must be added as an admin to any channels or groups you want to publish to.",
            },
            {
                question: "What message types can I send through RelayAPI?",
                answer: "RelayAPI supports text messages (with Markdown and HTML formatting), photos, videos, documents, audio files, voice messages, polls, location sharing, and media groups (albums of up to 10 items).",
            },
            {
                question: "Can I send messages to Telegram channels?",
                answer: "Yes. Add your bot as a channel admin and specify the channel username or ID in your request. RelayAPI handles the channel-specific API patterns and validates admin permissions before sending.",
            },
            {
                question: "How does RelayAPI handle Telegram's formatting options?",
                answer: "Telegram supports Markdown, HTML, and MarkdownV2 formatting. RelayAPI accepts any format and handles entity parsing, escape sequences, and formatting validation automatically.",
            },
        ],
    },
    {
        slug: "snapchat",
        name: "Snapchat",
        heroTitle: "One API Call to Post on Snapchat",
        heroDescription:
            "The Snapchat Marketing API requires business account verification, complex creative asset management, and Snap-specific content formats. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Snapchat Marketing API",
        painPoints: [
            "Business account setup and API access approval requires organization verification and can take weeks",
            "Creative asset uploads use a multi-step flow with separate endpoints for different media types and ad formats",
            "Content must conform to Snap's specific format requirements -- vertical video, specific resolutions, and duration limits",
            "The API is primarily advertising-focused, making organic content publishing through the API complex to navigate",
            "OAuth implementation uses Snap's custom flow with short-lived tokens and complex scope requirements",
        ],
        solutions: [
            "RelayAPI streamlines the business verification and API access process with guided setup and progress tracking",
            "Upload any media format and RelayAPI handles creative asset creation, format conversion, and Snap compliance",
            "Automatic media optimization for Snap's format requirements -- we handle vertical crop, resolution, and duration",
            "Unified publishing endpoint works for both organic and promotional content across Snap's different surfaces",
            "We manage Snap's OAuth flow, token lifecycle, and scope management so your integration stays connected",
        ],
        savingText: "Save 3+ hours of development time",
        warningBanner: {
            title: "Snapchat Business Account Required",
            description:
                "The Snapchat Marketing API requires a verified Snapchat Business account and approved API access. Personal Snapchat accounts cannot be used for API publishing.",
        },
        contentTypes: ["Snaps", "Stories", "Spotlight", "Ads"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Publish Snapchat content with a single API call. No creative asset management, no multi-step uploads, no format conversion. Send your media and metadata, we handle the Snap pipeline.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Snapchat Marketing API. Your content appears natively across Snap surfaces, while we handle business verification, token management, and format compliance.",
            },
            {
                title: "Vertical-First Media Optimization",
                description:
                    "Snapchat requires vertical (9:16) content with specific resolution and duration limits. RelayAPI validates and optimizes your media for Snap's requirements, preventing upload rejections.",
            },
        ],
        faq: [
            {
                question: "Do I need a Snapchat Business account?",
                answer: "Yes. The Snapchat Marketing API requires a verified Business account with approved API access. Personal Snapchat accounts cannot publish through the API.",
            },
            {
                question: "What content types can I publish to Snapchat through RelayAPI?",
                answer: "RelayAPI supports Snaps, Stories, Spotlight submissions, and ad creatives. All content must meet Snap's vertical format requirements, which RelayAPI validates automatically.",
            },
            {
                question: "How does Snapchat content differ from other platforms?",
                answer: "Snapchat is vertical-first (9:16 aspect ratio) with strict duration limits. Stories are 1-60 seconds, and Spotlight accepts up to 60 seconds. RelayAPI validates these constraints and optimizes your media before upload.",
            },
            {
                question: "Can I post to Snapchat Spotlight through RelayAPI?",
                answer: "Yes. RelayAPI supports Spotlight submissions with appropriate metadata, hashtags, and topic tags. We handle the Spotlight-specific submission flow and format requirements.",
            },
        ],
    },
    {
        slug: "mastodon",
        name: "Mastodon",
        heroTitle: "One API Call to Post on Mastodon",
        heroDescription:
            "The Mastodon API varies across instances with different versions, rate limits, and custom configurations. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Mastodon API",
        painPoints: [
            "Each Mastodon instance runs different software versions with varying API compatibility and feature support",
            "OAuth app registration must be done per-instance, requiring dynamic client registration for multi-instance support",
            "Rate limits vary by instance (default 300/5min) and some instances enforce stricter custom limits",
            "Media uploads have instance-specific file size limits and supported format lists that differ from the spec",
            "Content visibility (public, unlisted, followers-only, direct) and content warnings interact in non-obvious ways",
        ],
        solutions: [
            "RelayAPI normalizes API differences across Mastodon instances and forks (Pleroma, Akkoma, Misskey) into a consistent interface",
            "We handle per-instance OAuth app registration, token management, and dynamic client creation automatically",
            "Instance-specific rate limits are detected and tracked automatically with per-instance queuing and backoff",
            "Upload media to RelayAPI and we validate against the target instance's limits, convert formats, and handle thumbnails",
            "Simple visibility parameters with automatic content warning handling and instance-specific rule compliance",
        ],
        savingText: "Save 3+ hours of development time",
        contentTypes: ["Text Posts", "Images", "Videos", "Polls", "Audio"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Post to any Mastodon instance with a single API call. No per-instance OAuth registration, no version detection, no format negotiation. Specify your instance and content, we handle the rest.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Mastodon API. Your posts appear natively in timelines with full ActivityPub federation, while we handle instance compatibility, OAuth, and rate limits.",
            },
            {
                title: "Multi-Instance Compatibility",
                description:
                    "The fediverse includes Mastodon, Pleroma, Akkoma, and other compatible platforms. RelayAPI detects the instance type and adapts API calls for maximum compatibility across the fediverse.",
            },
        ],
        faq: [
            {
                question: "Can I post to any Mastodon instance?",
                answer: "Yes. RelayAPI supports any Mastodon-compatible instance, including Pleroma, Akkoma, and other fediverse platforms. Connect your account from any instance and we handle the API differences.",
            },
            {
                question: "What content types can I publish to Mastodon through RelayAPI?",
                answer: "RelayAPI supports text posts (up to instance character limit, typically 500), images (up to 4), videos, polls, and audio attachments. Content warnings and visibility levels are fully supported.",
            },
            {
                question: "How does RelayAPI handle different Mastodon instance configurations?",
                answer: "We detect instance software, version, and configuration automatically. This includes character limits, file size limits, supported media formats, and custom rate limits. Your posts are validated against the target instance's specific configuration.",
            },
            {
                question: "Does posting through RelayAPI federate normally?",
                answer: "Yes. Posts made through RelayAPI via the Mastodon API federate across the fediverse exactly like posts made through the Mastodon web interface. There is no difference in reach or federation behavior.",
            },
        ],
    },
    {
        slug: "discord",
        name: "Discord",
        heroTitle: "One API Call to Message on Discord",
        heroDescription:
            "The Discord API requires bot creation, gateway intent configuration, and understanding of guild-based permission hierarchies. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Discord API",
        painPoints: [
            "Bot creation through the Developer Portal requires intent configuration, and privileged intents need approval at 100+ servers",
            "Rate limits are per-route with different bucket sizes, and hitting global rate limits can affect all bot operations",
            "Webhooks, bot messages, and interactions (slash commands) use completely different API patterns and auth methods",
            "File uploads are limited to 25MB (or 50MB/100MB with Nitro boosted servers) with specific embed formatting rules",
            "Message formatting uses Discord-specific Markdown with embeds, components, and attachments that have complex schemas",
        ],
        solutions: [
            "RelayAPI handles bot setup, intent configuration, and privilege requests through a guided setup flow",
            "Per-route rate limit tracking with bucket-aware queuing prevents global rate limit hits across all operations",
            "Unified messaging endpoint works across webhooks, bot messages, and channel posts with automatic routing",
            "Upload media to RelayAPI and we handle file size validation, CDN hosting, and embed construction automatically",
            "Simple formatting parameters replace complex embed schemas -- pass your content and we build rich Discord messages",
        ],
        savingText: "Save 3+ hours of development time",
        contentTypes: ["Text Messages", "Embeds", "Images", "Videos", "Files", "Polls"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Send Discord messages with a single API call. No embed schema construction, no rate limit bucket management, no webhook vs bot routing. Specify the channel, content, and formatting -- we handle delivery.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Discord API. Your messages appear natively with embeds, attachments, and rich formatting, while we handle bot management, rate limits, and API versioning.",
            },
            {
                title: "Rich Embeds Made Simple",
                description:
                    "Discord's embed schema is powerful but complex. RelayAPI lets you create rich embeds with simple parameters -- title, description, images, and fields -- while we construct the proper embed objects.",
            },
        ],
        faq: [
            {
                question: "Do I need a Discord bot to send messages?",
                answer: "You can use either a bot or webhooks. Bots offer more control (channel selection, reactions, threads) while webhooks are simpler for one-way posting. RelayAPI supports both methods through the same endpoint.",
            },
            {
                question: "What message types can I send through RelayAPI?",
                answer: "RelayAPI supports text messages, rich embeds (with titles, descriptions, images, fields), file attachments (images, videos, documents), polls, and threaded replies. Components like buttons can be included for bot-based messaging.",
            },
            {
                question: "Can I post to multiple Discord channels or servers?",
                answer: "Yes. Connect multiple bots or webhooks and target specific channels by ID or name. RelayAPI handles the routing, permission checks, and rate limit isolation per server.",
            },
            {
                question: "How does RelayAPI handle Discord's rate limits?",
                answer: "Discord uses per-route rate limit buckets with global limits. RelayAPI tracks bucket headers in real-time, queues requests per-route, and prevents global rate limit hits that could affect your entire bot.",
            },
        ],
    },
    {
        slug: "twilio",
        name: "Twilio SMS",
        heroTitle: "One API Call to Send SMS via Twilio",
        heroDescription:
            "The Twilio API requires phone number provisioning, A2P 10DLC registration for US messaging, and compliance with carrier filtering rules. RelayAPI handles OAuth, rate limits, media hosting, and API changes.",
        directApiName: "Twilio API",
        painPoints: [
            "A2P 10DLC registration for US messaging requires brand registration, campaign vetting, and can take days to weeks",
            "Phone number provisioning, compliance bundles, and messaging service configuration add significant setup overhead",
            "Carrier filtering and deliverability vary by carrier, content type, and sending volume with limited visibility",
            "Pricing is complex with per-segment charges, carrier fees, and different rates for domestic vs international messages",
            "Handling delivery status callbacks, opt-out management (STOP/START), and error codes requires webhook infrastructure",
        ],
        solutions: [
            "RelayAPI guides you through A2P 10DLC registration and handles brand/campaign setup for US messaging compliance",
            "We manage phone number provisioning, messaging service configuration, and compliance bundles on your behalf",
            "Built-in deliverability monitoring with carrier filtering detection, content optimization, and throughput management",
            "Transparent pricing with per-message cost estimates and automatic segment optimization to reduce costs",
            "We handle delivery callbacks, opt-out compliance (STOP/START), and error recovery so you get clean status updates",
        ],
        savingText: "Save 3+ hours of development time",
        warningBanner: {
            title: "A2P 10DLC Registration Required for US Messaging",
            description:
                "Sending SMS to US numbers requires A2P 10DLC registration with carrier-verified brand and campaign information. Messages sent without registration may be filtered or blocked by carriers.",
        },
        contentTypes: ["SMS", "MMS", "WhatsApp via Twilio", "Short Codes"],
        features: [
            {
                title: "Ship Faster",
                description:
                    "Send SMS and MMS with a single API call. No phone number provisioning, no A2P registration management, no webhook infrastructure. Specify the recipient and message, we handle delivery.",
            },
            {
                title: "Official API, Zero Hassle",
                description:
                    "RelayAPI uses the official Twilio API. Your messages are delivered through Twilio's global network with full delivery tracking, while we handle compliance, phone numbers, and carrier requirements.",
            },
            {
                title: "Deliverability Optimization",
                description:
                    "Carrier filtering is the biggest challenge in SMS. RelayAPI monitors deliverability, detects filtering patterns, optimizes message content, and manages sending throughput to maximize delivery rates.",
            },
        ],
        faq: [
            {
                question: "Do I need my own Twilio account?",
                answer: "You can connect your existing Twilio account or use RelayAPI's managed messaging infrastructure. Both options support full SMS/MMS capabilities with delivery tracking and compliance management.",
            },
            {
                question: "What message types can I send through RelayAPI?",
                answer: "RelayAPI supports SMS (text-only), MMS (with images, videos, and other media), WhatsApp via Twilio, and short code messaging. International messaging to 180+ countries is supported.",
            },
            {
                question: "What is A2P 10DLC and do I need it?",
                answer: "A2P 10DLC (Application-to-Person 10-Digit Long Code) is required for sending SMS to US phone numbers from standard phone numbers. It involves registering your brand and campaign with carriers. RelayAPI handles the entire registration process for you.",
            },
            {
                question: "How does RelayAPI handle opt-out compliance?",
                answer: "TCPA compliance requires honoring STOP/START keywords. RelayAPI automatically manages opt-out lists, processes STOP/START messages, and prevents messaging to opted-out numbers. Compliance is handled without any code on your end.",
            },
            {
                question: "Can I send international SMS through RelayAPI?",
                answer: "Yes. RelayAPI supports international SMS to 180+ countries through Twilio's global network. We handle country-specific formatting, sender ID requirements, and regulatory compliance for each destination.",
            },
        ],
    },
];

export function getPlatformBySlug(slug: string): PlatformData | undefined {
    return platforms.find((p) => p.slug === slug);
}
