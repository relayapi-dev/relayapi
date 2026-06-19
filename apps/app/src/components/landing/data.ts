// Data for the Cursor-style marketing landing page.
// Transcribed verbatim from the approved mockup
// ("RelayAPI Landing.dc.html" → renderVals()). Copy is intentionally
// kept as-is (playful placeholder testimonials + fictional logos).

/** Brand-icon SVG path data (single `<path d>` per platform). */
export const PLATFORM_PATHS = {
	instagram:
		"M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163C8.741 0 8.332.014 7.052.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z",
	linkedin:
		"M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
	tiktok:
		"M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
	facebook:
		"M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z",
	x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
	youtube:
		"M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
	threads:
		"M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.781 3.631 2.695 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.331-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.74-1.756-.503-.582-1.279-.876-2.309-.883h-.029c-.825 0-1.951.231-2.674 1.32L7.514 7.117c.99-1.519 2.578-2.347 4.572-2.347h.045c3.397.022 5.426 2.124 5.563 5.674.087.05.173.1.258.151 1.222.731 2.121 1.834 2.598 3.19.665 1.889.704 4.969-1.804 7.421-1.917 1.877-4.245 2.71-7.563 2.734Z",
} as const;

export interface ReviewTask {
	title: string;
	time: string;
	sub: string;
}

export const reviewTasks: ReviewTask[] = [
	{ title: "Launch announcement", time: "now", sub: "Done. Delivered to 21 platforms." },
	{ title: "Weekly product digest", time: "now", sub: "All set! Scheduled for Monday 9 AM." },
	{ title: "Reply to top mentions", time: "now", sub: "+12 · Drafted replies for review" },
	{ title: "Instagram Reel · v2", time: "10m", sub: "Reformatted media for Reels + TikTok" },
	{ title: "Set up auto-repost rule", time: "30m", sub: "Auto-repost Blog posts to LinkedIn" },
	{ title: "Quarterly recap thread", time: "45m", sub: "Drafted 6-post thread for X" },
];

export const logos: string[] = [
	"Wayne Enterprises",
	"Umbrella Corp",
	"Monsters Inc",
	"Wonka Industries",
	"Acme",
	"Dunder Mifflin",
	"Initech",
];

export interface ScheduleRow {
	name: string;
	path: string;
	status: string;
	color: string;
}

export const scheduleRows: ScheduleRow[] = [
	{ name: "Twitter / X", path: PLATFORM_PATHS.x, status: "delivered", color: "#7FB88A" },
	{ name: "LinkedIn", path: PLATFORM_PATHS.linkedin, status: "delivered", color: "#7FB88A" },
	{ name: "Instagram", path: PLATFORM_PATHS.instagram, status: "publishing", color: "#D9A66B" },
	{ name: "TikTok", path: PLATFORM_PATHS.tiktok, status: "queued · 12:00", color: "#8C887E" },
	{ name: "YouTube", path: PLATFORM_PATHS.youtube, status: "queued · 14:00", color: "#8C887E" },
];

export interface Testimonial {
	quote: string;
	name: string;
	role: string;
	avatarBg: string;
	initial: string;
}

export const testimonials: Testimonial[] = [
	{
		quote:
			"I used to mass-communicate through parables and word of mouth. With Relay, I can post to all 21 platforms at once. Truly a miracle.",
		name: "Jesus Christ",
		role: "Son of God at Heaven Inc.",
		avatarBg: "#E4D8C2",
	},
	{
		quote:
			"I don't use APIs. APIs use me. But I made an exception for Relay because it's the only API that doesn't flinch when I send a request.",
		name: "Chuck Norris",
		role: "Chief Roundhouse Officer, Fists of Fury LLC",
		avatarBg: "#D2BC9A",
	},
	{
		quote:
			"I find your lack of cross-platform posting disturbing. Relay brought order to our galactic social media chaos.",
		name: "Darth Vader",
		role: "Dark Lord of the Sith, The Galactic Empire",
		avatarBg: "#CCC2AD",
	},
	{
		quote:
			"A wizard never mistimes a social post, nor sends it too early. He posts precisely when he means to. With Relay, of course.",
		name: "Gandalf",
		role: "Senior Wizard, Middle Earth Solutions",
		avatarBg: "#DED7C7",
	},
	{
		quote:
			"Social media is like onions — it has layers. Relay handles all the layers for me so I can get back to me swamp.",
		name: "Shrek",
		role: "CEO, Swamp Enterprises",
		avatarBg: "#C8A883",
	},
	{
		quote:
			"I work alone. But even I needed help posting across platforms. Relay is the Robin I actually wanted. Silent, efficient, no cape.",
		name: "Batman",
		role: "Vigilante & CTO, Wayne Enterprises",
		avatarBg: "#E2D2BA",
	},
].map((t) => ({ ...t, initial: t.name.charAt(0) }));

export interface FrontierCard {
	title: string;
	body: string;
	link: string;
	bg: string;
	icon: string;
}

export const frontier: FrontierCard[] = [
	{
		title: "Every platform, one API",
		body: "Consistent request format, unified error handling, and standardized responses across all 21 networks.",
		link: "Explore platforms",
		bg: "linear-gradient(160deg,#E4D8C2,#D2BC9A)",
		icon: "M5 12h14M12 5v14",
	},
	{
		title: "Complete media understanding",
		body: "Upload once — images and video get auto-resized and reformatted to each platform's exact specs.",
		link: "Media API docs",
		bg: "linear-gradient(160deg,#DED7C7,#CCC2AD)",
		icon: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z",
	},
	{
		title: "Build enduring integrations",
		body: "Webhooks, analytics, and SDKs for TypeScript, Python, Go, and Java. Drop it into any stack.",
		link: "Read the docs",
		bg: "linear-gradient(160deg,#E2D2BA,#C8A883)",
		icon: "M16 18l6-6-6-6M8 6l-6 6 6 6",
	},
];

export interface CompareRow {
	name: string;
	c50: string;
	c500: string;
	color: string;
}

export const compareRows: CompareRow[] = [
	{ name: "RelayAPI", c50: "$10/mo", c500: "$145/mo", color: "#1A1815" },
	{ name: "Per-account API", c50: "$779/mo", c500: "$2,624/mo", color: "#9A968C" },
	{ name: "Usage-based API", c50: "$275/mo", c500: "$2,750/mo", color: "#9A968C" },
];

export interface ChangelogEntry {
	date: string;
	title: string;
}

export const changelog: ChangelogEntry[] = [
	{ date: "Jun 10, 2026", title: "Bluesky and Threads now support native video uploads" },
	{ date: "Jun 4, 2026", title: "Custom webhooks, retry policies, and per-platform scheduling" },
	{ date: "May 28, 2026", title: "Analytics API v2 — cross-platform engagement in one call" },
	{ date: "May 14, 2026", title: "New Go and Java SDKs, plus a faster media pipeline" },
];

export interface BlogPost {
	tag: string;
	title: string;
	meta: string;
	bg: string;
}

export const blog: BlogPost[] = [
	{
		tag: "Product",
		title: "Introducing RelayAPI v2",
		meta: "Relay Team · 7 min read",
		bg: "linear-gradient(160deg,#E4D8C2,#D2BC9A)",
	},
	{
		tag: "Engineering",
		title: "Delivering to 21 platforms in under 100ms",
		meta: "Giulio Z. · 5 min read",
		bg: "linear-gradient(160deg,#DED7C7,#CCC2AD)",
	},
	{
		tag: "Guides",
		title: "Posting from Claude with the OpenClaw skill",
		meta: "Relay Team · 4 min read",
		bg: "linear-gradient(160deg,#E2D2BA,#C8A883)",
	},
	{
		tag: "Research",
		title: "The hidden cost of per-account social APIs",
		meta: "Relay Team · 6 min read",
		bg: "linear-gradient(160deg,#E6DCC8,#D6C8AE)",
	},
];

export interface FooterColumn {
	title: string;
	links: string[];
}

export const footerCols: FooterColumn[] = [
	{ title: "Product", links: ["Posting API", "Media API", "Analytics API", "Webhooks API", "Pricing"] },
	{ title: "Platforms", links: ["Instagram", "X / Twitter", "LinkedIn", "TikTok", "All platforms"] },
	{ title: "Resources", links: ["Documentation", "API Reference", "Changelog", "Login", "Sign up"] },
	{ title: "Legal", links: ["Privacy Policy", "Terms of Service"] },
];

/** Shared external/internal link targets for the landing. */
export const LANDING_LINKS = {
	signup: "/signup",
	login: "/login",
	pricing: "/pricing",
	docs: "https://docs.relayapi.dev",
	quickstart: "https://docs.relayapi.dev/quickstart",
	changelog: "https://docs.relayapi.dev/changelog",
	github: "https://github.com/relayapi-dev/relayapi",
} as const;
