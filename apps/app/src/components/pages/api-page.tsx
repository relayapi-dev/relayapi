import { useState } from "react";
import type { ApiData } from "../../lib/api-data";
import { getApiBySlug } from "../../lib/api-data";
import { highlightCode } from "../../lib/code-highlight";
import { platforms } from "../../lib/platform-data";
import { apiIconPaths, platformGlyph } from "../../lib/product-glyphs";

/**
 * API product page — cream / Cursor-style landing for a single API surface.
 * Renders inside Layout.astro (LandingNav + LandingFooter + `.relay-landing`
 * cream theme), so this owns only the page body. Coloured <a> need a trailing
 * `!` (landing wrapper resets link colour — see project_landing_anchor_important).
 */

const SECTION = "mx-auto w-full max-w-[77.5rem] px-5 sm:px-8";
const H2 =
	"text-center text-[clamp(24px,3vw,36px)] font-medium tracking-[-0.03em] text-landing-ink";
const EYEBROW =
	"text-center text-[13px] font-medium uppercase tracking-[0.16em] text-[#9a968c]";

const STEPS = [
	{
		n: 1,
		title: "Get your API key",
		body: "Sign up and generate your credentials in seconds.",
	},
	{
		n: 2,
		title: "Connect social accounts",
		body: "Link platforms via OAuth with our guided setup flow.",
	},
	{
		n: 3,
		title: "Start building",
		body: "Use the API to publish, manage, and track content everywhere.",
	},
];

export function ApiPage({ slug }: { slug: string }) {
	const api = getApiBySlug(slug);

	if (!api) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<p className="text-[16px] text-landing-muted">API not found.</p>
			</div>
		);
	}

	return (
		<>
			<HeroSection api={api} />
			<FeaturesSection api={api} />
			<HowItWorksSection />
			<BenefitsSection api={api} />
			<CodeExamplesSection api={api} />
			<PlatformsSection />
			<FaqSection api={api} />
			<CtaSection />
		</>
	);
}

function HeroSection({ api }: { api: ApiData }) {
	return (
		<section
			className={`${SECTION} pb-[clamp(2rem,4vw,3rem)] pt-[clamp(3.5rem,7vw,6rem)] text-center`}
		>
			<span className="mx-auto mb-7 flex size-14 items-center justify-center rounded-md bg-landing-card text-landing-ink ring-1 ring-landing-ink/[0.08] [&>svg]:size-7">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					{apiIconPaths(api.slug).map((d) => (
						<path key={d} d={d} />
					))}
				</svg>
			</span>
			<h1 className="mx-auto max-w-[20ch] text-balance text-[clamp(30px,4.5vw,52px)] font-medium leading-[1.08] tracking-[-0.035em] text-landing-ink">
				{api.heroTitle}
			</h1>
			<p className="mx-auto mt-5 max-w-[58ch] text-balance text-[17px] leading-[1.55] text-[#6e6a62]">
				{api.heroDescription}
			</p>
			<div className="mt-8 flex flex-wrap justify-center gap-[10px]">
				<a
					href="/signup"
					className="rounded-full bg-landing-ink px-[22px] py-3 text-[15px] font-medium text-[#f3f1ea]! transition-opacity duration-150 hover:opacity-[0.88]"
				>
					Start building free
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
				No credit card required · Full API access
			</p>
		</section>
	);
}

function FeaturesSection({ api }: { api: ApiData }) {
	return (
		<section className={`${SECTION} py-[clamp(2.5rem,5vw,4rem)]`}>
			<div className="mx-auto max-w-[60rem]">
				<p className={EYEBROW}>Features</p>
				<h2 className={`mt-3 ${H2}`}>Everything you need</h2>
				<div className="mt-9 grid gap-5 sm:grid-cols-2">
					{api.features.map((feature) => (
						<div
							key={feature.title}
							className="rounded-md border border-landing-ink/[0.08] bg-landing-card p-7"
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
			</div>
		</section>
	);
}

function HowItWorksSection() {
	return (
		<section className={`${SECTION} py-[clamp(2.5rem,5vw,4rem)]`}>
			<div className="mx-auto max-w-[60rem]">
				<h2 className={H2}>Up and running in minutes</h2>
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
								{step.body}
							</p>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function BenefitsSection({ api }: { api: ApiData }) {
	return (
		<section className={`${SECTION} py-[clamp(2.5rem,5vw,4rem)]`}>
			<div className="mx-auto max-w-[60rem]">
				<h2 className={H2}>Why developers choose RelayAPI</h2>
				<div className="mt-9 grid gap-5 sm:grid-cols-3">
					{api.benefits.map((benefit) => (
						<div
							key={benefit.title}
							className="rounded-md border border-landing-ink/[0.08] bg-landing-card p-7"
						>
							<h3 className="text-[16px] font-semibold tracking-[-0.01em] text-landing-ink">
								{benefit.title}
							</h3>
							<p className="mt-2.5 text-[14.5px] leading-[1.55] text-[#6e6a62]">
								{benefit.description}
							</p>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function CodeExamplesSection({ api }: { api: ApiData }) {
	const [active, setActive] = useState(0);
	if (api.codeExamples.length === 0) return null;
	const current = api.codeExamples[active];

	return (
		<section className={`${SECTION} py-[clamp(2.5rem,5vw,4rem)]`}>
			<div className="mx-auto max-w-[52rem]">
				<p className={EYEBROW}>Quick start</p>
				<h2 className={`mt-3 ${H2}`}>Start building in minutes</h2>

				<div className="mt-8">
					<div className="mb-3 flex flex-wrap gap-2">
						{api.codeExamples.map((ex, i) => (
							<button
								type="button"
								key={ex.label}
								onClick={() => setActive(i)}
								className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150 ${
									i === active
										? "border-landing-ink bg-landing-ink text-[#f3f1ea]"
										: "border-landing-ink/[0.12] text-[#6e6a62] hover:text-landing-ink"
								}`}
							>
								{ex.label}
							</button>
						))}
					</div>

					<div className="overflow-hidden rounded-feature-window bg-landing-panel-dark shadow-feature-window">
						<div className="flex items-center border-b border-landing-line-dark px-4 py-2.5">
							<div className="flex gap-[7px]">
								<span className="size-[10px] rounded-full bg-white/15" />
								<span className="size-[10px] rounded-full bg-white/15" />
								<span className="size-[10px] rounded-full bg-white/15" />
							</div>
							<span className="ml-3 text-[12px] text-white/45 [font-family:var(--font-mono-landing)]">
								{current?.label}
							</span>
						</div>
						<div className="overflow-x-auto px-5 py-5 sm:px-6">
							<pre className="text-[12.5px] leading-[1.7] text-[#d7d2c7] [font-family:var(--font-mono-landing)] sm:text-[13.5px]">
								<code
									dangerouslySetInnerHTML={{
										__html: highlightCode(current?.code ?? ""),
									}}
								/>
							</pre>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function PlatformsSection() {
	return (
		<section className={`${SECTION} py-[clamp(2.5rem,5vw,4rem)]`}>
			<div className="mx-auto max-w-[60rem]">
				<p className={EYEBROW}>Integrations</p>
				<h2 className={`mt-3 ${H2}`}>Works with every platform</h2>
				<div className="mt-8 grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
					{platforms.map((p) => (
						<a
							key={p.slug}
							href={`/product/${p.slug}`}
							className="flex flex-col items-center gap-2.5 rounded-md border border-landing-ink/[0.08] bg-landing-card p-4 text-landing-ink! transition-colors duration-150 hover:bg-landing-ink/[0.04] [&>svg]:size-5"
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
	);
}

function FaqSection({ api }: { api: ApiData }) {
	if (api.faq.length === 0) return null;
	return (
		<section className={`${SECTION} py-[clamp(2.5rem,5vw,4rem)]`}>
			<div className="mx-auto max-w-[48rem]">
				<h2 className={H2}>Frequently asked questions</h2>
				<div className="mt-8 flex flex-col">
					{api.faq.map((item) => (
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
	);
}

function CtaSection() {
	return (
		<section className={`${SECTION} py-[clamp(4rem,8vw,7rem)] text-center`}>
			<h2 className="mx-auto max-w-[18ch] text-balance text-[clamp(34px,5vw,60px)] font-medium tracking-[-0.04em] text-landing-ink">
				Ready to start building?
			</h2>
			<p className="mx-auto mt-5 max-w-[48ch] text-balance text-[17px] leading-[1.5] text-[#6e6a62]">
				Get your API key and publish across 21 platforms in minutes.
			</p>
			<div className="mt-8 flex flex-wrap justify-center gap-[12px]">
				<a
					href="/signup"
					className="rounded-full bg-landing-ink px-[30px] py-[15px] text-[17px] font-medium text-[#f3f1ea]! transition-opacity duration-150 hover:opacity-[0.88]"
				>
					Start building free
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
	);
}
