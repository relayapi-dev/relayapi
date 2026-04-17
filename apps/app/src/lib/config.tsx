import { Icons } from "../components/icons";
import { cn } from "./utils";

export const Highlight = ({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) => {
	return <span className={cn("text-primary", className)}>{children}</span>;
};

export const BLUR_FADE_DELAY = 0.15;

export const siteConfig = {
	name: "Relay",
	description:
		"Unified social media API — post to 17 platforms with a single call.",
	cta: "Get Started",
	url: "https://relayapi.dev",
	keywords: [
		"Social Media API",
		"Cross-Platform Posting",
		"Unified API",
		"Social Media Automation",
	],
	links: {
		email: "support@relayapi.dev",
		twitter: "https://x.com/giuliozanchetta",
		github: "https://github.com/relayapi-dev",
		instagram: "https://instagram.com/relayapi",
	},
	nav: {
		links: [
			{
				id: 1,
				name: "Product",
				href: "#",
				submenu: [
					{
						id: 1,
						icon: <Icons.code className="size-4 text-muted-foreground" />,
						name: "Unified Posting",
						href: "#workflow",
						description: "Post to all platforms at once",
					},
					{
						id: 2,
						icon: <Icons.code className="size-4 text-muted-foreground" />,
						name: "Media Management",
						href: "#features",
						description: "Upload and manage media files",
					},
					{
						id: 3,
						icon: <Icons.code className="size-4 text-muted-foreground" />,
						name: "Analytics",
						href: "#features",
						description: "Track engagement across platforms",
					},
					{
						id: 4,
						icon: <Icons.code className="size-4 text-muted-foreground" />,
						name: "Webhooks",
						href: "#features",
						description: "Real-time delivery notifications",
					},
				],
			},
			{ id: 2, name: "Docs", href: "https://docs.relayapi.dev/" },
			{ id: 3, name: "Pricing", href: "/pricing" },
		],
	},
	hero: {
		badgeIcon: <Icons.stackedIcons className="size-4" />,
		badge: "One API for every social platform",
		title: '"Ehy claude, post this to all my socials"',
		description:
			"Relay is an open-source unified API that lets your AI or app post to 17 social platforms at once.",
		cta: {
			primary: {
				text: "Start for free",
				href: "/signup",
			},
		},
	},
	demoSection: {
		title: "Simple. Seamless. Smart.",
		description:
			"See how Relay turns a single API call into posts across every platform",
		items: [
			{
				id: 1,
				title: "Connect Accounts",
				content:
					"Link your social media accounts in seconds via OAuth. Twitter, Instagram, LinkedIn, TikTok, and more.",
				image:
					"https://images.unsplash.com/photo-1720371300677-ba4838fa0678?q=80&w=2070&auto=format&fit=crop&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
			},
			{
				id: 2,
				title: "Compose Once",
				content:
					"Write your content once and let Relay optimize it for each platform's format, character limits, and media specs.",
				image:
					"https://images.unsplash.com/photo-1686170287433-c95faf6d3608?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxmZWF0dXJlZC1waG90b3MtZmVlZHwzfHx8ZW58MHx8fHx8fA%3D%3D",
			},
			{
				id: 3,
				title: "Publish Everywhere",
				content:
					"One POST request publishes to all connected platforms simultaneously. Track delivery status in real time.",
				image:
					"https://images.unsplash.com/photo-1720378042271-60aff1e1c538?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxmZWF0dXJlZC1waG90b3MtZmVlZHwxMHx8fGVufDB8fHx8fA%3D%3D",
			},
			{
				id: 4,
				title: "Track & Iterate",
				content:
					"Get unified analytics across all platforms. See what works, refine your strategy, and grow your audience.",
				image:
					"https://images.unsplash.com/photo-1666882990322-e7f3b8df4f75?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1yZWxhdGVkfDF8fHxlbnwwfHx8fHw%3D",
			},
		],
	},
	companyShowcase: {
		companyLogos: [
			{
				id: 1,
				name: "Wayne Enterprises",
				logo: (
					<img
						src="https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/logos/wayne-enterprises.svg"
						alt="Wayne Enterprises"
						className="max-h-10"
					/>
				),
			},
			{
				id: 3,
				name: "Umbrella Corp",
				logo: (
					<img
						src="https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/logos/umbrella-corp.svg"
						alt="Umbrella Corp"
						className="max-h-10"
					/>
				),
			},
			{
				id: 4,
				name: "Monsters Inc",
				logo: (
					<img
						src="https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/logos/monsters-inc.svg"
						alt="Monsters Inc"
						className="max-h-10"
					/>
				),
			},
			{
				id: 5,
				name: "Wonka Industries",
				logo: (
					<img
						src="https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/logos/wonka-industries.svg"
						alt="Wonka Industries"
						className="max-h-10"
					/>
				),
			},
			{
				id: 6,
				name: "Acme Corporation",
				logo: (
					<img
						src="https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/logos/acme-corporation.png"
						alt="Acme Corporation"
						className="max-h-10"
					/>
				),
			},
			{
				id: 7,
				name: "Dunder Mifflin",
				logo: (
					<img
						src="https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/logos/dunder-mifflin.svg"
						alt="Dunder Mifflin"
						className="max-h-10"
					/>
				),
			},
			{
				id: 8,
				name: "Initech",
				logo: (
					<img
						src="https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/logos/initech.png"
						alt="Initech"
						className="max-h-10"
					/>
				),
			},
		],
	},
	workflowSection: {
		badge: {
			icon: <Icons.terminal className="size-4 text-muted-foreground" />,
			text: "Integrate",
		},
		title: (
			<>
				One endpoint for <Highlight>every platform</Highlight>
			</>
		),
		description:
			"Relay handles authentication, rate limits, media formatting, and platform quirks so you can focus on building your product",
		sections: {
			title: "Go from zero to publishing in minutes",
			description:
				"Connect your social accounts, get your API key, and start publishing with a single REST call. No SDKs to install.",
			ctaButton: {
				text: "View Docs",
				href: "/docs",
			},
			blocks: [
				{
					id: 1,
					icon: <Icons.terminal className="size-4 text-muted-foreground" />,
					title: "Connect accounts via OAuth",
					description:
						"Link Twitter, Instagram, LinkedIn, TikTok, and 11 more platforms in seconds. We handle token refresh and re-auth automatically.",
				},
				{
					id: 2,
					icon: <Icons.shock className="size-4 text-muted-foreground" />,
					title: "Publish with one API call",
					description:
						"Send a single POST request with your content and target platforms. Relay formats and delivers to each network simultaneously.",
				},
			],
		},
	},
	workflowConnectSection: {
		title: "Media uploads. Webhooks. Scheduling.",
		description:
			"Upload images and videos to our CDN, schedule posts for the perfect time, and get notified when content goes live via webhooks.",
		ctaButton: {
			text: "View Docs",
			href: "/docs",
		},
		blocks: [
			{
				id: 1,
				icon: <Icons.magicClick className="size-4 text-muted-foreground" />,
				title: "Upload media once, use everywhere",
				description:
					"Upload images and videos to Relay. We auto-resize and reformat for each platform's requirements.",
			},
			{
				id: 2,
				icon: <Icons.magicStar className="size-4 text-muted-foreground" />,
				title: "Real-time delivery webhooks",
				description:
					"Get notified instantly when your posts are published, fail, or receive engagement. Never miss a status update.",
			},
		],
	},
	featureSection: {
		badge: {
			icon: <Icons.globe className="size-4 text-muted-foreground" />,
			text: "Scale",
		},
		title: (
			<>
				Stop managing 12 APIs. <Highlight>Just use one.</Highlight>
			</>
		),
		description:
			"Relay abstracts away the complexity of each social platform's API. Consistent request format, unified error handling, and standardized responses.",
		sections: {
			title: "Built for teams and developers worldwide",
			description:
				"From indie makers to marketing teams at scale. Trusted by companies that need reliable cross-platform publishing.",
			ctaButton: {
				text: "View Docs",
				href: "/docs",
			},
			blocks: [
				{
					id: 1,
					icon: <Icons.puzzle className="size-4 text-muted-foreground" />,
					title: "Trusted by growing teams",
					description:
						"Development teams and marketing platforms rely on Relay to power their social publishing workflows at scale.",
				},
				{
					id: 2,
					icon: <Icons.globe className="size-4 text-muted-foreground" />,
					title: "Serving developers globally",
					description:
						"Relay powers social publishing for developers and companies around the world with 99.9% uptime and edge-deployed infrastructure.",
				},
			],
		},
	},
	connectSection: {
		badge: {
			icon: <Icons.terminal className="size-4 text-muted-foreground" />,
			text: "Connect",
		},
		title: (
			<>
				Sign up. Connect. <Highlight>Publish.</Highlight>
			</>
		),
		description:
			"Get from zero to publishing across all platforms in under 5 minutes",
		step1: {
			title: "Create your API key",
			description:
				"Sign up, create a workspace, and generate your API key. Start making requests immediately with our developer-friendly REST API.",
		},
		step2: {
			title: "Connect your social accounts",
			description:
				"Link Twitter, Instagram, LinkedIn, TikTok, Facebook, YouTube, Reddit, and more via OAuth. All credentials are encrypted at rest.",
		},
		step3: {
			title: "Publish to every platform at once",
			description:
				"Send a single API request with your content. Relay handles formatting, media optimization, and delivery to each platform.",
		},
	},
	testimonialSection: {
		badge: {
			icon: (
				<svg
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					className="text-muted-foreground"
				>
					<path
						d="M4 4C3.44772 4 3 4.44772 3 5V7C3 7.55228 3.44772 8 4 8H5V10C5 10.5523 5.44772 11 6 11H7C7.55228 11 8 10.5523 8 10V5C8 4.44772 7.55228 4 7 4H4Z"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M11 4C10.4477 4 10 4.44772 10 5V7C10 7.55228 10.4477 8 11 8H12V10C12 10.5523 12.4477 11 13 11H14C14.5523 11 15 10.5523 15 10V5C15 4.44772 14.5523 4 14 4H11Z"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			),
			text: "Scale",
		},
		title: (
			<>
				Hear from our <Highlight>totally real</Highlight> users
			</>
		),
		description:
			"These are 100% real testimonials from actual customers. We definitely did not make these up.",
		testimonials: [
			{
				id: "1",
				name: "Jesus Christ",
				role: "Son of God at Heaven Inc.",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/jesus.jpg",
				description: (
					<p>
						I used to mass-communicate through parables and word of mouth. With
						Relay, I can post to all 17 platforms at once.
						<Highlight>
							Truly a miracle. Even I couldn&apos;t have done it better.
						</Highlight>
					</p>
				),
			},
			{
				id: "2",
				name: "Chuck Norris",
				role: "Chief Roundhouse Officer at Fists of Fury LLC",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/chuck-norris.jpg",
				description: (
					<p>
						I don&apos;t use APIs. APIs use me. But I made an exception for
						Relay because it&apos;s the only API that doesn&apos;t flinch when I
						send a request.
					</p>
				),
			},
			{
				id: "3",
				name: "Darth Vader",
				role: "Dark Lord of the Sith at The Galactic Empire",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/darth-vader.jpg",
				description: (
					<p>
						I find your lack of cross-platform posting disturbing. Relay brought
						order to our galactic social media chaos.
						<Highlight>
							The Empire&apos;s propaganda has never been more efficient.
						</Highlight>
					</p>
				),
			},
			{
				id: "4",
				name: "Gandalf",
				role: "Senior Wizard at Middle Earth Solutions",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/gandalf.jpg",
				description: (
					<p>
						A wizard never mistimes a social post, nor sends it too early. He
						posts precisely when he means to. With Relay, of course.
					</p>
				),
			},
			{
				id: "5",
				name: "Shrek",
				role: "CEO at Swamp Enterprises",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/shrek.jpg",
				description: (
					<p>
						Social media is like onions — it has layers. Relay handles all the
						layers for me so I can get back to me swamp.
						<Highlight>
							Better out than in, I always say. Especially posts.
						</Highlight>
					</p>
				),
			},
			{
				id: "6",
				name: "Batman",
				role: "Vigilante & CTO at Wayne Enterprises",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/batman.jpg",
				description: (
					<p>
						I work alone. But even I needed help posting across platforms.
						<Highlight>
							Relay is the Robin I actually wanted. Silent, efficient, no cape.
						</Highlight>
					</p>
				),
			},
			{
				id: "7",
				name: "Yoda",
				role: "Grand Master at The Jedi Council",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/yoda.jpg",
				description: (
					<p>
						Post to all platforms, you must. With Relay, easy it is.
						<Highlight>Strong with this API, the Force is. Mmmm.</Highlight>
					</p>
				),
			},
			{
				id: "8",
				name: "Gordon Ramsay",
				role: "Head Chef at Hell&apos;s Kitchen",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/gordon-ramsay.jpg",
				description: (
					<p>
						Finally, an API that isn&apos;t bloody RAW! Relay is perfectly
						seasoned, well-documented, and beautifully plated.
						<Highlight>
							This is the first thing in tech I haven&apos;t sent back to the
							kitchen.
						</Highlight>
					</p>
				),
			},
			{
				id: "9",
				name: "Bob Ross",
				role: "Chief Happiness Officer at Happy Little Trees Inc.",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/bob-ross.jpg",
				description: (
					<p>
						There are no mistakes in social media, only happy little posts. And
						with Relay, every post is a happy little accident across all
						platforms.
						<Highlight>
							Just beat the devil out of manual cross-posting.
						</Highlight>
					</p>
				),
			},
			{
				id: "10",
				name: "Mr. T",
				role: "VP of Pitying Fools at The A-Team",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/mr-t.jpg",
				description: (
					<p>
						I pity the fool who doesn&apos;t use Relay! Building integrations
						for each platform? That&apos;s crazy talk, sucka!
						<Highlight>
							Relay is the gold chain of APIs — bold, powerful, and stylish.
						</Highlight>
					</p>
				),
			},
			{
				id: "11",
				name: "Thor Odinson",
				role: "God of Thunder at Asgard Technologies",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/thor.jpg",
				description: (
					<p>
						By Odin&apos;s beard! This API is worthy! I smashed my keyboard
						trying to build social integrations until I found Relay.
						<Highlight>I am Thor, and I approve this API.</Highlight>
					</p>
				),
			},
			{
				id: "12",
				name: "SpongeBob SquarePants",
				role: "Fry Cook & Social Media Manager at The Krusty Krab",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/spongebob.jpg",
				description: (
					<p>
						I&apos;M READY! I&apos;M READY! I&apos;M READY to post to 17
						platforms at once! Mr. Krabs saved so much money switching to Relay.
						<Highlight>The best API in all of Bikini Bottom!</Highlight>
					</p>
				),
			},
			{
				id: "13",
				name: "Mario",
				role: "Lead Plumber at Mushroom Kingdom",
				img: "https://pub-4cc181c2247149beb15ea4dd0c959249.r2.dev/testimonials/mario.jpg",
				description: (
					<p>
						It&apos;s-a me, Mario! I used to jump through pipes to deliver
						messages. Now I just use-a Relay and it&apos;s like getting a Super
						Star.
						<Highlight>Wahoo! One API to rule-a them all!</Highlight>
					</p>
				),
			},
		],
	},
	pricing: {
		title: "Simple, transparent pricing",
		description:
			"Start free with 200 requests/month. Upgrade to Pro for full access.",
		pricingItems: [
			{
				name: "Free",
				href: "/signup",
				price: "$0",
				period: "month",
				yearlyPrice: "$0",
				features: [
					"200 requests/month",
					"All 17 platforms",
					"Unlimited profiles",
					"Media uploads",
					"Webhook notifications",
					"No credit card required",
				],
				description: "Try the API with no commitment",
				buttonText: "Sign Up Free",
				buttonColor: "bg-accent text-primary",
				isPopular: false,
			},
			{
				name: "Pro",
				href: "/signup",
				price: "$5",
				period: "month",
				yearlyPrice: "$50",
				features: [
					"10,000 requests included",
					"$1 per 1,000 extra calls",
					"All 17 platforms",
					"Unlimited profiles",
					"Media uploads & scheduling",
					"Webhook notifications",
					"Comments API included",
					"Analytics API included",
					"1,000 req/min rate limit",
					"Custom pricing over $100/mo spend",
				],
				description: "Full access, pay as you grow",
				buttonText: "Get Started",
				buttonColor: "bg-primary text-primary-foreground",
				isPopular: true,
			},
		],
	},
	faqSection: {
		title: "Frequently Asked Questions",
		description:
			"Answers to common questions about Relay. If you have any other questions, reach out to our support team.",
		faQitems: [
			{
				id: 1,
				question: "What is Relay?",
				answer:
					"Relay is a unified social media API that lets you post to 17 platforms (Instagram, LinkedIn, TikTok, Facebook, YouTube, Reddit, Pinterest, Bluesky, Threads, Telegram, Snapchat, Google Business, WhatsApp, Mastodon, Discord, X/Twitter, and SMS via Twilio) with a single API call. No need to build and maintain separate integrations for each network.",
			},
			{
				id: 2,
				question: "How does Relay work?",
				answer:
					"Connect your social media accounts via OAuth, get your API key, and make a single POST request with your content and target platforms. Relay handles authentication, media formatting, rate limiting, and delivery to each platform.",
			},
			{
				id: 3,
				question: "How secure is my data?",
				answer:
					"All social account credentials are encrypted with AES-256-GCM at rest. API keys are SHA-256 hashed before storage. We use Cloudflare Workers for edge-deployed infrastructure with built-in DDoS protection.",
			},
			{
				id: 4,
				question: "Which platforms are supported?",
				answer:
					"We currently support Instagram, LinkedIn, TikTok, Facebook, YouTube, Reddit, Pinterest, Bluesky, Threads, Telegram, Snapchat, Google Business, WhatsApp, Mastodon, Discord, and SMS (via Twilio). 17 platforms and growing. X/Twitter support is paused due to their API pricing changes but can be enabled on demand with adjusted pricing.",
			},
			{
				id: 5,
				question: "Is there a free plan?",
				answer:
					"Yes! Our Free plan gives you 200 requests/month across all 17 platforms — no credit card required. When you're ready for more, Pro is $5/month with 10,000 requests included and $1 per 1,000 extra calls. Analytics and Comments APIs are included in Pro at no extra cost.",
			},
			{
				id: 6,
				question: "Can I use Relay with my existing app?",
				answer:
					"Absolutely. Relay is a standard REST API that works with any language or framework. We provide OpenAPI specs, and our docs include examples in cURL, JavaScript, Python, and more.",
			},
		],
	},
	ctaSection: {
		id: "cta",
		title: "Start publishing to every platform today",
		backgroundImage: "/agent-cta-background.png",
		button: {
			text: "Get your API key",
			href: "/signup",
		},
		subtext:
			"Stop juggling 17 different APIs. One integration, every platform, free to start.",
	},
	footerLinks: [
		{
			title: "Product",
			links: [
				{ id: 1, title: "Posting API", url: "/product/posting-api" },
				{ id: 2, title: "Media API", url: "/product/media-api" },
				{ id: 3, title: "Analytics API", url: "/product/analytics-api" },
				{ id: 4, title: "Webhooks API", url: "/product/webhooks-api" },
				{ id: 5, title: "Pricing", url: "/pricing" },
			],
		},
		{
			title: "Platforms",
			links: [
				{ id: 6, title: "Instagram", url: "/product/instagram" },
				{ id: 7, title: "X / Twitter", url: "/product/twitter" },
				{ id: 8, title: "LinkedIn", url: "/product/linkedin" },
				{ id: 9, title: "TikTok", url: "/product/tiktok" },
				{ id: 10, title: "Facebook", url: "/product/facebook" },
				{ id: 11, title: "YouTube", url: "/product/youtube" },
				{ id: 12, title: "All Platforms", url: "/#company" },
			],
		},
		{
			title: "Resources",
			links: [
				{ id: 13, title: "Documentation", url: "https://docs.relayapi.dev/" },
				{ id: 14, title: "API Reference", url: "https://docs.relayapi.dev/" },
				{ id: 15, title: "Login", url: "/login" },
				{ id: 16, title: "Sign Up", url: "/signup" },
			],
		},
		{
			title: "Legal",
			links: [
				{ id: 17, title: "Privacy Policy", url: "/privacy" },
				{ id: 18, title: "Terms of Service", url: "/terms" },
			],
		},
	],
};

export type SiteConfig = typeof siteConfig;
