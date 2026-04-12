import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
	transpilePackages: ["shiki", "@shikijs/core", "@shikijs/engine-javascript"],
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
