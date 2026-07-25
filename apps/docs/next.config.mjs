import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const contentSecurityPolicy = [
	"default-src 'self'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
	"form-action 'self'",
	"object-src 'none'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"img-src 'self' data: blob: https:",
	"connect-src 'self'",
	"worker-src 'self' blob:",
	"upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{
		key: "Permissions-Policy",
		value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	},
	...(process.env.NODE_ENV === "production"
		? [
				{
					key: "Strict-Transport-Security",
					value: "max-age=31536000; includeSubDomains",
				},
				{ key: "Content-Security-Policy", value: contentSecurityPolicy },
			]
		: []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
	poweredByHeader: false,
	transpilePackages: ["shiki", "@shikijs/core", "@shikijs/engine-javascript"],
	async headers() {
		return [{ source: "/:path*", headers: securityHeaders }];
	},
	async rewrites() {
		return [
			{
				source: "/index.mdx",
				destination: "/llms.mdx",
			},
			{
				source: "/:path*.mdx",
				destination: "/llms.mdx/:path*",
			},
		];
	},
};

export default withMDX(nextConfig);
