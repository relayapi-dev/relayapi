import {
	Body,
	Container,
	Font,
	Head,
	Hr,
	Html,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import type { ReactNode } from "react";

interface BaseLayoutProps {
	preview: string;
	children: ReactNode;
}

export function BaseLayout({ preview, children }: BaseLayoutProps) {
	return (
		<Html>
			<Head>
				<Font
					fontFamily="Inter"
					fallbackFontFamily="Helvetica"
					webFont={{
						url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
						format: "woff2",
					}}
					fontWeight={400}
					fontStyle="normal"
				/>
			</Head>
			<Preview>{preview}</Preview>
			<Tailwind>
				<Body className="bg-gray-50 my-0 mx-auto font-sans">
					<Container className="max-w-[560px] mx-auto py-10 px-4">
						{/* Header */}
						<Section className="text-center mb-8">
							<Text className="text-lg font-semibold text-gray-900 m-0">
								RelayAPI
							</Text>
						</Section>

						{/* Main content card */}
						<Section className="bg-white rounded-lg shadow-sm px-8 py-8">
							{children}
						</Section>

						{/* Footer */}
						<Section className="text-center mt-8">
							<Hr className="border-gray-200 mb-4" />
							<Text className="text-xs text-gray-400 m-0">
								&copy; {new Date().getFullYear()} RelayAPI. All
								rights reserved.
							</Text>
							<Link
								href="https://relayapi.dev"
								className="text-xs text-gray-400 underline"
							>
								relayapi.dev
							</Link>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
