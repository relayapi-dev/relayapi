import { Shield, Wrench, Zap } from "lucide-react";
import type { PlatformData } from "../../lib/platform-data";
import { getPlatformBySlug, platforms } from "../../lib/platform-data";
import { Navbar } from "../section/navbar";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "../ui/accordion";
import { Button } from "../ui/button";

const FEATURE_ICONS = [Zap, Shield, Wrench];

export function PlatformPage({ slug }: { slug: string }) {
	const platform = getPlatformBySlug(slug);

	if (!platform) {
		return (
			<div className="flex items-center justify-center min-h-screen">
				<p className="text-lg text-muted-foreground">Platform not found.</p>
			</div>
		);
	}

	const otherPlatforms = platforms.filter((p) => p.slug !== platform.slug);

	const codeSnippet = `const response = await fetch('https://api.relayapi.dev/v1/posts', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer rlay_live_xxxxxxxxxx',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    content: 'Check out our latest update!',
    platforms: ['${platform.slug}'],
    media: ['https://cdn.example.com/image.jpg'],
  }),
});`;

	return (
		<div className="max-w-7xl mx-auto border-x border-border">
			{/* 1. Navbar */}
			<Navbar />

			<main className="pt-16">
				{/* 2. Hero Section */}
				<section className="pt-16 md:pt-32 pb-10 md:pb-16 px-4 md:px-6">
					<div className="max-w-5xl mx-auto flex flex-col items-center text-center">
						<h1 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tighter text-center text-balance text-foreground">
							{platform.heroTitle}
						</h1>
						<p className="text-base md:text-lg text-muted-foreground text-center max-w-2xl mx-auto mt-4 md:mt-6">
							{platform.heroDescription}
						</p>
						<div className="flex flex-col sm:flex-row items-center gap-3 mt-6 md:mt-8 w-full sm:w-auto px-2 sm:px-0">
							<Button
								asChild
								className="w-full sm:w-auto bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-8 py-3 text-base font-medium"
							>
								<a href="/signup">Get Started Free</a>
							</Button>
							<Button
								asChild
								variant="outline"
								className="w-full sm:w-auto rounded-full px-8 py-3 text-base font-medium border-border"
							>
								<a href="https://docs.relayapi.dev/">View API Docs</a>
							</Button>
						</div>
						<p className="text-sm text-muted-foreground mt-4">
							No credit card required &middot; Free plan available
						</p>
					</div>
				</section>

				{/* 3. Code Example Block */}
				<section className="py-10 md:py-24 px-4 md:px-6">
					<div className="max-w-5xl mx-auto">
						<div className="rounded-xl overflow-hidden border border-border">
							{/* Window chrome */}
							<div className="bg-[#1a1a2e] px-4 py-3 flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
									<span className="w-3 h-3 rounded-full bg-[#febc2e]" />
									<span className="w-3 h-3 rounded-full bg-[#28c840]" />
								</div>
								<span className="text-sm font-mono text-white/60">
									POST /v1/posts
								</span>
								<div className="w-[52px]" />
							</div>
							{/* Code body */}
							<div className="bg-[#1a1a2e] px-3 md:px-6 pb-6 overflow-x-auto">
								<pre className="text-xs md:text-sm leading-relaxed font-mono">
									<code>
										<span className="text-purple-400">const</span>{" "}
										<span className="text-white">response</span>{" "}
										<span className="text-white">=</span>{" "}
										<span className="text-purple-400">await</span>{" "}
										<span className="text-blue-400">fetch</span>
										<span className="text-white">(</span>
										<span className="text-green-400">
											'https://api.relayapi.dev/v1/posts'
										</span>
										<span className="text-white">, {"{"}</span>
										{"\n"}
										{"  "}
										<span className="text-white">method:</span>{" "}
										<span className="text-green-400">'POST'</span>
										<span className="text-white">,</span>
										{"\n"}
										{"  "}
										<span className="text-white">headers: {"{"}</span>
										{"\n"}
										{"    "}
										<span className="text-green-400">'Authorization'</span>
										<span className="text-white">: </span>
										<span className="text-green-400">
											'Bearer rlay_live_xxxxxxxxxx'
										</span>
										<span className="text-white">,</span>
										{"\n"}
										{"    "}
										<span className="text-green-400">'Content-Type'</span>
										<span className="text-white">: </span>
										<span className="text-green-400">'application/json'</span>
										<span className="text-white">,</span>
										{"\n"}
										{"  "}
										<span className="text-white">{"}"},</span>
										{"\n"}
										{"  "}
										<span className="text-white">body:</span>{" "}
										<span className="text-white">JSON.</span>
										<span className="text-blue-400">stringify</span>
										<span className="text-white">({"{"}</span>
										{"\n"}
										{"    "}
										<span className="text-white">content:</span>{" "}
										<span className="text-green-400">
											'Check out our latest update!'
										</span>
										<span className="text-white">,</span>
										{"\n"}
										{"    "}
										<span className="text-white">platforms: [</span>
										<span className="text-green-400">'{platform.slug}'</span>
										<span className="text-white">],</span>
										{"\n"}
										{"    "}
										<span className="text-white">media: [</span>
										<span className="text-green-400">
											'https://cdn.example.com/image.jpg'
										</span>
										<span className="text-white">],</span>
										{"\n"}
										{"  "}
										<span className="text-white">{"}"}),</span>
										{"\n"}
										<span className="text-white">{"}"});</span>
									</code>
								</pre>
							</div>
						</div>
					</div>
				</section>

				{/* 4. Comparison Table */}
				<section className="py-10 md:py-24 px-4 md:px-6 border-t border-border">
					<div className="max-w-5xl mx-auto">
						<div className="grid md:grid-cols-2 gap-8">
							{/* Direct API column */}
							<div className="rounded-xl border border-border bg-card p-8">
								<h3 className="text-xl font-semibold text-foreground mb-6">
									{platform.directApiName}
								</h3>
								<ul className="space-y-4">
									{platform.painPoints.map((point, index) => (
										<li key={index} className="flex items-start gap-3">
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="20"
												height="20"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
												className="text-red-500 shrink-0 mt-0.5"
											>
												<path d="M18 6 6 18" />
												<path d="m6 6 12 12" />
											</svg>
											<span className="text-muted-foreground">{point}</span>
										</li>
									))}
								</ul>
							</div>

							{/* RelayAPI column */}
							<div className="rounded-xl border border-border bg-card p-8">
								<h3 className="text-xl font-semibold text-foreground mb-6">
									RelayAPI
								</h3>
								<ul className="space-y-4">
									{platform.solutions.map((solution, index) => (
										<li key={index} className="flex items-start gap-3">
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="20"
												height="20"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
												className="text-green-500 shrink-0 mt-0.5"
											>
												<path d="M20 6 9 17l-5-5" />
											</svg>
											<span className="text-muted-foreground">{solution}</span>
										</li>
									))}
								</ul>
							</div>
						</div>

						{/* Saving badge */}
						<div className="flex justify-center mt-8">
							<span className="inline-flex items-center px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium">
								{platform.savingText}
							</span>
						</div>
					</div>
				</section>

				{/* 5. Warning Banner (conditional) */}
				{platform.warningBanner && (
					<section className="py-10 md:py-24 px-4 md:px-6 border-t border-border">
						<div className="max-w-5xl mx-auto">
							<div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
								<h3 className="text-lg font-bold text-foreground mb-2">
									{platform.warningBanner.title}
								</h3>
								<p className="text-muted-foreground">
									{platform.warningBanner.description}
								</p>
							</div>
						</div>
					</section>
				)}

				{/* 6. Content Types */}
				<section className="py-10 md:py-24 px-4 md:px-6 border-t border-border">
					<div className="max-w-5xl mx-auto">
						<h2 className="text-3xl md:text-4xl font-bold tracking-tighter text-center text-foreground mb-8">
							Supported Content Types
						</h2>
						<div className="flex flex-wrap items-center justify-center gap-3">
							{platform.contentTypes.map((type) => (
								<span
									key={type}
									className="px-4 py-2 rounded-full bg-card border border-border text-sm font-medium"
								>
									{type}
								</span>
							))}
						</div>
					</div>
				</section>

				{/* 7. How It Works */}
				<section className="py-10 md:py-24 px-4 md:px-6 border-t border-border">
					<div className="max-w-5xl mx-auto">
						<h2 className="text-3xl md:text-4xl font-bold tracking-tighter text-center text-foreground mb-12">
							How It Works
						</h2>
						<div className="grid md:grid-cols-3 gap-8">
							{[
								{
									step: 1,
									title: "Connect Your Account",
									description: `Authorize your ${platform.name} account via OAuth in 30 seconds`,
								},
								{
									step: 2,
									title: "Build Your Integration",
									description:
										"Use the REST API or our SDKs to publish content",
								},
								{
									step: 3,
									title: "RelayAPI Handles the Rest",
									description:
										"We manage publishing, rate limits, and delivery notifications",
								},
							].map((item) => (
								<div
									key={item.step}
									className="flex flex-col items-center text-center space-y-4"
								>
									<div className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-lg font-bold">
										{item.step}
									</div>
									<h3 className="text-lg font-semibold text-foreground">
										{item.title}
									</h3>
									<p className="text-muted-foreground">{item.description}</p>
								</div>
							))}
						</div>
					</div>
				</section>

				{/* 8. Feature Cards */}
				<section className="py-10 md:py-24 px-4 md:px-6 border-t border-border">
					<div className="max-w-5xl mx-auto">
						<div className="grid md:grid-cols-3 gap-6">
							{platform.features.map((feature, index) => {
								const Icon = FEATURE_ICONS[index] ?? Zap;
								return (
									<div
										key={feature.title}
										className="rounded-xl border border-border bg-card p-8"
									>
										<Icon className="w-6 h-6 text-primary mb-4" />
										<h3 className="text-lg font-semibold text-foreground mb-2">
											{feature.title}
										</h3>
										<p className="text-muted-foreground">
											{feature.description}
										</p>
									</div>
								);
							})}
						</div>
					</div>
				</section>

				{/* 9. FAQ Accordion */}
				<section className="py-10 md:py-24 px-4 md:px-6 border-t border-border">
					<div className="max-w-5xl mx-auto">
						<h2 className="text-3xl md:text-4xl font-bold tracking-tighter text-center text-foreground mb-12">
							Frequently Asked Questions
						</h2>
						<div className="max-w-3xl mx-auto">
							<Accordion type="single" collapsible className="w-full">
								{platform.faq.map((item, index) => (
									<AccordionItem
										key={index}
										value={index.toString()}
										className="border-b border-border py-4 first:pt-0"
									>
										<AccordionTrigger className="text-left no-underline hover:no-underline py-0 text-base">
											{item.question}
										</AccordionTrigger>
										<AccordionContent className="text-muted-foreground pt-4 pb-0">
											<p className="leading-relaxed">{item.answer}</p>
										</AccordionContent>
									</AccordionItem>
								))}
							</Accordion>
						</div>
					</div>
				</section>

				{/* 10. Other Platforms Grid */}
				<section className="py-10 md:py-24 px-4 md:px-6 border-t border-border">
					<div className="max-w-5xl mx-auto">
						<h2 className="text-3xl md:text-4xl font-bold tracking-tighter text-center text-foreground mb-8">
							Explore Other Platforms
						</h2>
						<div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
							{otherPlatforms.map((p) => (
								<a
									key={p.slug}
									href={`/product/${p.slug}`}
									className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4 hover:bg-accent/50 transition-colors"
								>
									<span className="text-2xl">{p.icon}</span>
									<span className="text-sm font-medium text-foreground">
										{p.name}
									</span>
								</a>
							))}
						</div>
					</div>
				</section>

				{/* 11. Footer CTA */}
				<section className="py-10 md:py-24 px-4 md:px-6">
					<div className="max-w-5xl mx-auto">
						<div className="bg-primary rounded-2xl p-8 md:p-12 flex flex-col items-center text-center space-y-6">
							<h2 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tighter text-white text-balance">
								Start Building with {platform.name}
							</h2>
							<p className="text-white/80 text-lg font-medium">
								Join developers who chose RelayAPI over building with{" "}
								{platform.directApiName} directly.
							</p>
							<Button
								asChild
								size="lg"
								variant="outline"
								className="border-white text-white hover:bg-white/10 rounded-full px-8"
							>
								<a href="/signup">Get Started Free</a>
							</Button>
						</div>
					</div>
				</section>

				{/* 12. Copyright bar */}
				<div className="border-t border-border py-4">
					<p className="text-sm text-muted-foreground text-center">
						&copy; 2026 Relay. All rights reserved.
					</p>
				</div>
			</main>
		</div>
	);
}
