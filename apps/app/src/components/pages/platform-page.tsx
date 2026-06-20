import { getPlatformBySlug, platforms } from "../../lib/platform-data";
import { highlightCode } from "../../lib/code-highlight";
import { platformGlyph } from "../../lib/product-glyphs";

/**
 * Platform product page — cream / Cursor-style landing for a single platform.
 * Renders inside Layout.astro (which supplies the LandingNav, LandingFooter and
 * the `.relay-landing` cream theme), so this component owns only the page body.
 * Every coloured <a> needs a trailing `!` because the landing wrapper resets
 * link colour to inherit (see project_landing_anchor_important).
 */

const STEPS = [
	{
		n: 1,
		title: "Connect your account",
		body: (name: string) =>
			`Authorize your ${name} account via OAuth in about 30 seconds.`,
	},
	{
		n: 2,
		title: "Build your integration",
		body: () => "Use the REST API or our SDKs to publish content from your stack.",
	},
	{
		n: 3,
		title: "We handle the rest",
		body: () =>
			"RelayAPI manages publishing, rate limits, and delivery notifications.",
	},
];

export function PlatformPage({ slug }: { slug: string }) {
	const platform = getPlatformBySlug(slug);

	if (!platform) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<p className="text-[16px] text-landing-muted">Platform not found.</p>
			</div>
		);
	}

	const others = platforms.filter((p) => p.slug !== platform.slug);

	const code = `const res = await fetch("https://api.relayapi.dev/v1/posts", {
  method: "POST",
  headers: {
    Authorization: "Bearer rlay_live_xxxx",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content: "Check out our latest update!",
    platforms: ["${platform.slug}"],
    media: ["https://cdn.example.com/image.jpg"],
  }),
});`;

	return (
		<>
			{/* ===================== HERO ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 pb-[clamp(2rem,4vw,3rem)] pt-[clamp(3.5rem,7vw,6rem)] text-center sm:px-8">
				<span className="mx-auto mb-7 flex size-14 items-center justify-center rounded-[14px] bg-landing-card text-landing-ink ring-1 ring-landing-ink/[0.08] [&>svg]:size-7">
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d={platformGlyph(platform.slug)} />
					</svg>
				</span>
				<h1 className="mx-auto max-w-[20ch] text-balance text-[clamp(30px,4.5vw,52px)] font-medium leading-[1.08] tracking-[-0.035em] text-landing-ink">
					{platform.heroTitle}
				</h1>
				<p className="mx-auto mt-5 max-w-[58ch] text-balance text-[17px] leading-[1.55] text-[#6e6a62]">
					{platform.heroDescription}
				</p>
				<div className="mt-8 flex flex-wrap justify-center gap-[10px]">
					<a
						href="/signup"
						className="rounded-full bg-landing-ink px-[22px] py-3 text-[15px] font-medium text-[#f3f1ea]! transition-opacity duration-150 hover:opacity-[0.88]"
					>
						Get started free
					</a>
					<a
						href="https://docs.relayapi.dev/"
						target="_blank"
						rel="noopener noreferrer"
						className="rounded-full bg-[#e4e1d9] px-[22px] py-3 text-[15px] font-medium text-landing-ink! transition-colors duration-150 hover:bg-[#dbd7cc]"
					>
						View API docs
					</a>
				</div>
				<p className="mt-4 text-[13px] text-[#9a968c]">
					No credit card required · Free plan available
				</p>
			</section>

			{/* ===================== CODE WINDOW ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 pb-[clamp(2.5rem,5vw,4rem)] sm:px-8">
				<div
					className="mx-auto max-w-[52rem] overflow-hidden rounded-feature-window bg-landing-panel-dark shadow-feature-window"
				>
					<div className="flex items-center border-b border-landing-line-dark px-4 py-2.5">
						<div className="flex gap-[7px]">
							<span className="size-[10px] rounded-full bg-white/15" />
							<span className="size-[10px] rounded-full bg-white/15" />
							<span className="size-[10px] rounded-full bg-white/15" />
						</div>
						<span className="ml-3 text-[12px] text-white/45 [font-family:var(--font-mono-landing)]">
							POST /v1/posts
						</span>
					</div>
					<div className="overflow-x-auto px-5 py-5 sm:px-6">
						<pre className="text-[12.5px] leading-[1.7] text-[#d7d2c7] [font-family:var(--font-mono-landing)] sm:text-[13.5px]">
							<code dangerouslySetInnerHTML={{ __html: highlightCode(code) }} />
						</pre>
					</div>
				</div>
			</section>

			{/* ===================== COMPARISON ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 py-[clamp(2.5rem,5vw,4rem)] sm:px-8">
				<div className="mx-auto max-w-[60rem]">
					<div className="grid gap-5 md:grid-cols-2">
						<div className="rounded-[20px] border border-landing-ink/[0.08] bg-landing-card p-7 sm:p-8">
							<h2 className="text-[18px] font-semibold tracking-[-0.01em] text-landing-ink">
								{platform.directApiName}
							</h2>
							<ul className="mt-6 flex flex-col gap-4">
								{platform.painPoints.map((point) => (
									<li key={point} className="flex items-start gap-3">
										<svg
											className="mt-[3px] size-4 shrink-0 text-landing-ink/30"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2.2"
											strokeLinecap="round"
											strokeLinejoin="round"
											aria-hidden="true"
										>
											<path d="M18 6 6 18M6 6l12 12" />
										</svg>
										<span className="text-[14.5px] leading-[1.55] text-[#6e6a62]">
											{point}
										</span>
									</li>
								))}
							</ul>
						</div>

						<div className="rounded-[20px] border border-landing-ink/[0.14] bg-landing-card p-7 ring-1 ring-landing-ink/[0.05] sm:p-8">
							<h2 className="text-[18px] font-semibold tracking-[-0.01em] text-landing-ink">
								RelayAPI
							</h2>
							<ul className="mt-6 flex flex-col gap-4">
								{platform.solutions.map((solution) => (
									<li key={solution} className="flex items-start gap-3">
										<svg
											className="mt-[3px] size-4 shrink-0 text-landing-accent"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2.4"
											strokeLinecap="round"
											strokeLinejoin="round"
											aria-hidden="true"
										>
											<path d="M5 13l4 4L19 7" />
										</svg>
										<span className="text-[14.5px] leading-[1.55] text-[#46443d]">
											{solution}
										</span>
									</li>
								))}
							</ul>
						</div>
					</div>
					<div className="mt-7 flex justify-center">
						<span className="inline-flex items-center gap-2 rounded-full bg-landing-accent/[0.1] px-4 py-2 text-[13.5px] font-medium text-landing-accent">
							<svg
								viewBox="0 0 24 24"
								className="size-4 fill-current"
								aria-hidden="true"
							>
								<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
							</svg>
							{platform.savingText}
						</span>
					</div>
				</div>
			</section>

			{/* ===================== WARNING (conditional) ===================== */}
			{platform.warningBanner && (
				<section className="mx-auto w-full max-w-[77.5rem] px-5 pb-[clamp(2rem,4vw,3rem)] sm:px-8">
					<div
						className="mx-auto max-w-[60rem] rounded-[18px] border border-[#e0c08a] bg-[#f7eeda] p-6"
					>
						<h3 className="text-[16px] font-semibold text-[#7a5a1e]">
							{platform.warningBanner.title}
						</h3>
						<p className="mt-2 text-[14.5px] leading-[1.55] text-[#8a6a30]">
							{platform.warningBanner.description}
						</p>
					</div>
				</section>
			)}

			{/* ===================== CONTENT TYPES ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 py-[clamp(2.5rem,5vw,4rem)] text-center sm:px-8">
				<div>
					<h2 className="text-[clamp(24px,3vw,36px)] font-medium tracking-[-0.03em] text-landing-ink">
						Supported content types
					</h2>
					<div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
						{platform.contentTypes.map((type) => (
							<span
								key={type}
								className="rounded-full border border-landing-ink/[0.1] bg-landing-card px-4 py-2 text-[14px] font-medium text-[#46443d]"
							>
								{type}
							</span>
						))}
					</div>
				</div>
			</section>

			{/* ===================== HOW IT WORKS ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 py-[clamp(2.5rem,5vw,4rem)] sm:px-8">
				<div className="mx-auto max-w-[60rem]">
					<h2 className="text-center text-[clamp(24px,3vw,36px)] font-medium tracking-[-0.03em] text-landing-ink">
						How it works
					</h2>
					<div className="mt-10 grid gap-8 sm:grid-cols-3">
						{STEPS.map((step) => (
							<div
								key={step.n}
								className="flex flex-col items-center text-center"
							>
								<span className="flex size-11 items-center justify-center rounded-full bg-landing-ink text-[17px] font-medium text-[#f3f1ea]">
									{step.n}
								</span>
								<h3 className="mt-5 text-[16px] font-semibold text-landing-ink">
									{step.title}
								</h3>
								<p className="mt-2 max-w-[26ch] text-[14.5px] leading-[1.55] text-[#6e6a62]">
									{step.body(platform.name)}
								</p>
							</div>
						))}
					</div>
				</div>
			</section>

			{/* ===================== FEATURE CARDS ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 py-[clamp(2.5rem,5vw,4rem)] sm:px-8">
				<div
					className="mx-auto grid max-w-[60rem] gap-5 sm:grid-cols-3"
				>
					{platform.features.map((feature) => (
						<div
							key={feature.title}
							className="rounded-[20px] border border-landing-ink/[0.08] bg-landing-card p-7"
						>
							<h3 className="text-[16px] font-semibold tracking-[-0.01em] text-landing-ink">
								{feature.title}
							</h3>
							<p className="mt-2.5 text-[14.5px] leading-[1.55] text-[#6e6a62]">
								{feature.description}
							</p>
						</div>
					))}
				</div>
			</section>

			{/* ===================== FAQ ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 py-[clamp(2.5rem,5vw,4rem)] sm:px-8">
				<div className="mx-auto max-w-[48rem]">
					<h2 className="text-center text-[clamp(24px,3vw,36px)] font-medium tracking-[-0.03em] text-landing-ink">
						Frequently asked questions
					</h2>
					<div className="mt-8 flex flex-col">
						{platform.faq.map((item) => (
							<details
								key={item.question}
								className="group border-b border-landing-ink/[0.1] py-5 first:pt-0"
							>
								<summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16.5px] font-medium text-landing-ink [&::-webkit-details-marker]:hidden">
									{item.question}
									<svg
										className="size-4 shrink-0 text-[#9a968c] transition-transform duration-200 group-open:rotate-45"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<path d="M12 5v14M5 12h14" />
									</svg>
								</summary>
								<p className="mt-3 max-w-[64ch] text-[15px] leading-[1.6] text-[#6e6a62]">
									{item.answer}
								</p>
							</details>
						))}
					</div>
				</div>
			</section>

			{/* ===================== OTHER PLATFORMS ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 py-[clamp(2.5rem,5vw,4rem)] sm:px-8">
				<div className="mx-auto max-w-[60rem]">
					<h2 className="text-center text-[clamp(24px,3vw,36px)] font-medium tracking-[-0.03em] text-landing-ink">
						Explore other platforms
					</h2>
					<div className="mt-8 grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
						{others.map((p) => (
							<a
								key={p.slug}
								href={`/product/${p.slug}`}
								className="flex flex-col items-center gap-2.5 rounded-[16px] border border-landing-ink/[0.08] bg-landing-card p-4 text-landing-ink! transition-colors duration-150 hover:bg-landing-ink/[0.04] [&>svg]:size-5"
							>
								<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
									<path d={platformGlyph(p.slug)} />
								</svg>
								<span className="text-center text-[12.5px] font-medium text-[#46443d]">
									{p.name}
								</span>
							</a>
						))}
					</div>
				</div>
			</section>

			{/* ===================== CLOSING CTA ===================== */}
			<section className="mx-auto w-full max-w-[77.5rem] px-5 py-[clamp(4rem,8vw,7rem)] text-center sm:px-8">
				<h2 className="mx-auto max-w-[22ch] text-balance text-[clamp(32px,4.6vw,56px)] font-medium tracking-[-0.04em] text-landing-ink">
					Start building with {platform.name}.
				</h2>
				<p className="mx-auto mt-5 max-w-[50ch] text-balance text-[17px] leading-[1.5] text-[#6e6a62]">
					Join developers who chose RelayAPI over wiring up{" "}
					{platform.directApiName} by hand.
				</p>
				<div className="mt-8 flex flex-wrap justify-center gap-[12px]">
					<a
						href="/signup"
						className="rounded-full bg-landing-ink px-[30px] py-[15px] text-[17px] font-medium text-[#f3f1ea]! transition-opacity duration-150 hover:opacity-[0.88]"
					>
						Get started free
					</a>
					<a
						href="https://docs.relayapi.dev/"
						target="_blank"
						rel="noopener noreferrer"
						className="rounded-full bg-[#e4e1d9] px-[30px] py-[15px] text-[17px] font-medium text-landing-ink! transition-colors duration-150 hover:bg-[#dbd7cc]"
					>
						Read the docs
					</a>
				</div>
			</section>
		</>
	);
}
