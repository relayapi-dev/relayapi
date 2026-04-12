import type { ReactNode } from "react";

export interface PlatformData {
    slug: string;
    name: string;
    icon: ReactNode;
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M22 8.5c0 1.37-1.12 2.5-2.5 2.5S17 9.87 17 8.5c0 1.37-1.12 2.5-2.5 2.5S12 9.87 12 8.5c0 1.37-1.12 2.5-2.5 2.5S7 9.87 7 8.5C7 9.87 5.88 11 4.5 11S2 9.87 2 8.5l1.39-5.42S3.68 2 4.7 2h14.6c1.02 0 1.31 1.08 1.31 1.08zm-1 3.7V20c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-7.8a3.96 3.96 0 0 0 4-.58c.69.55 1.56.88 2.5.88c.95 0 1.82-.33 2.5-.88c.69.55 1.56.88 2.5.88c.95 0 1.82-.33 2.5-.88c.68.55 1.56.88 2.5.88c.53 0 1.04-.11 1.5-.3m-2 5.13c0-.2 0-.41-.05-.63l-.03-.16h-2.97v1.17h1.81c-.06.22-.14.44-.31.62-.33.33-.78.51-1.26.51-.5 0-.99-.21-1.35-.56-.69-.71-.69-1.86.02-2.58.69-.7 1.83-.7 2.55-.03l.14.13.84-.85-.16-.14c-.56-.52-1.3-.81-2.08-.81h-.01c-.81 0-1.57.31-2.14.87-.59.58-.92 1.34-.92 2.13 0 .8.31 1.54.88 2.09a3.2 3.2 0 0 0 2.22.91h.02c.8 0 1.51-.29 2.03-.8.47-.48.77-1.2.77-1.87" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
            </svg>
        ),
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
        icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M12 0C5.381-.008.008 5.352 0 11.971V12c0 6.64 5.359 12 12 12 6.64 0 12-5.36 12-12 0-6.641-5.36-12-12-12zm0 20.801c-4.846.015-8.786-3.904-8.801-8.75V12c-.014-4.846 3.904-8.786 8.75-8.801H12c4.847-.014 8.786 3.904 8.801 8.75V12c.015 4.847-3.904 8.786-8.75 8.801H12zm5.44-11.76c0 1.359-1.12 2.479-2.481 2.479-1.366-.007-2.472-1.113-2.479-2.479 0-1.361 1.12-2.481 2.479-2.481 1.361 0 2.481 1.12 2.481 2.481zm0 5.919c0 1.36-1.12 2.48-2.481 2.48-1.367-.008-2.473-1.114-2.479-2.48 0-1.359 1.12-2.479 2.479-2.479 1.361-.001 2.481 1.12 2.481 2.479zm-5.919 0c0 1.36-1.12 2.48-2.479 2.48-1.368-.007-2.475-1.113-2.481-2.48 0-1.359 1.12-2.479 2.481-2.479 1.358-.001 2.479 1.12 2.479 2.479zm0-5.919c0 1.359-1.12 2.479-2.479 2.479-1.367-.007-2.475-1.112-2.481-2.479 0-1.361 1.12-2.481 2.481-2.481 1.358 0 2.479 1.12 2.479 2.481z" />
            </svg>
        ),
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
