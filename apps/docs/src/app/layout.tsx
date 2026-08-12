import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { ReactNode } from "react";
import { FeedbackWidget } from "@/components/feedback-widget";

// next-themes serializes its bootstrap function with Function#toString.
// OpenNext's production bundler preserves nested function names by emitting an
// unscoped `__name` call inside that string, so define the standard helper in a
// literal script before the provider emits its theme bootstrap.
const functionNameHelper = `
globalThis["__name"] = globalThis["__name"] || function(target, value) {
  return Object.defineProperty(target, "name", {
    value: value,
    configurable: true
  });
};`;

const metadataBase = new URL(
	process.env.NEXT_PUBLIC_SITE_URL || "https://docs.relayapi.dev",
);

export const metadata = {
	title: "RelayAPI Docs",
	description: "Documentation for the RelayAPI unified social media API",
	metadataBase,
	icons: {
		icon: "/favicon.svg",
	},
	openGraph: {
		title: "RelayAPI Docs",
		description: "Documentation for the RelayAPI unified social media API",
		images: ["/og.png"],
	},
	twitter: {
		card: "summary_large_image" as const,
		title: "RelayAPI Docs",
		description: "Documentation for the RelayAPI unified social media API",
		images: ["/og.png"],
	},
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: functionNameHelper }} />
			</head>
			<body className="font-sans">
				<RootProvider
					theme={{
						defaultTheme: "dark",
					}}
				>
					{children}
					<FeedbackWidget />
				</RootProvider>
			</body>
		</html>
	);
}
