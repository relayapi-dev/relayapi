import { useState } from "react";

import { Button } from "../ui/button";

const PRO_BASE_PRICE = 5;
const PRO_INCLUDED_CALLS = 10_000;
const COST_PER_1K = 1; // $1 per 1K extra calls
const CUSTOM_SPEND_THRESHOLD = 100;

const MIN_SLIDER = 10_000;
const MAX_SLIDER = 200_000;

/**
 * Progressive slider mapping (piecewise linear):
 *   0%–40% of track  →  10,000–50,000   (slow zone)
 *  40%–100% of track → 50,000–200,000   (fast zone)
 */
const BREAK_PCT = 0.4;
const BREAK_CALLS = 50_000;

function pctToCalls(pct: number): number {
    if (pct <= BREAK_PCT) {
        return MIN_SLIDER + (pct / BREAK_PCT) * (BREAK_CALLS - MIN_SLIDER);
    }
    return (
        BREAK_CALLS +
        ((pct - BREAK_PCT) / (1 - BREAK_PCT)) * (MAX_SLIDER - BREAK_CALLS)
    );
}

function callsToPct(calls: number): number {
    if (calls <= BREAK_CALLS) {
        return (
            ((calls - MIN_SLIDER) / (BREAK_CALLS - MIN_SLIDER)) * BREAK_PCT
        );
    }
    return (
        BREAK_PCT +
        ((calls - BREAK_CALLS) / (MAX_SLIDER - BREAK_CALLS)) * (1 - BREAK_PCT)
    );
}

function roundCalls(raw: number): number {
    if (raw <= MIN_SLIDER) return MIN_SLIDER;
    if (raw >= MAX_SLIDER) return MAX_SLIDER;
    if (raw <= 50_000) return Math.round(raw / 1_000) * 1_000;
    if (raw <= 100_000) return Math.round(raw / 5_000) * 5_000;
    return Math.round(raw / 10_000) * 10_000;
}

function calculatePrice(calls: number): number {
    const extra = Math.max(0, calls - PRO_INCLUDED_CALLS);
    return PRO_BASE_PRICE + (extra / 1000) * COST_PER_1K;
}

function formatNumber(n: number): string {
    return n.toLocaleString("en-US");
}

function formatPrice(price: number): string {
    if (price % 1 === 0) return `$${price}`;
    return `$${price.toFixed(2)}`;
}

const FREE_FEATURES: { text: string; included: boolean }[] = [
    { text: "All 17 platforms", included: true },
    { text: "Unlimited profiles", included: true },
    { text: "Media uploads", included: true },
    { text: "Webhook notifications", included: true },
    { text: "100 req/min rate limit", included: true },
    { text: "Comments API", included: false },
    { text: "Analytics API", included: false },
];

function getProFeatures(isCustom: boolean) {
    return [
        { text: "All 17 platforms", included: true },
        { text: "Unlimited profiles", included: true },
        { text: "Media uploads & scheduling", included: true },
        { text: "Webhook notifications", included: true },
        { text: isCustom ? "Custom rate limit" : "1,000 req/min rate limit", included: true },
        { text: "Comments API", included: true, highlight: true },
        { text: "Analytics API", included: true, highlight: true },
    ];
}

const SLIDER_STEPS = 1000;

function PricingSlider({
    value,
    onChange,
}: {
    value: number;
    onChange: (v: number) => void;
}) {
    const fraction = callsToPct(value);
    const sliderValue = Math.round(fraction * SLIDER_STEPS);

    const pct = fraction * 100;

    return (
        <div className="space-y-2">
            <style dangerouslySetInnerHTML={{ __html: `
                .pricing-slider {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 100%;
                    height: 40px;
                    background: transparent;
                    cursor: pointer;
                    margin: 0;
                    padding: 0;
                    position: relative;
                    z-index: 2;
                }
                .pricing-slider:focus {
                    outline: none;
                }
                .pricing-slider::-webkit-slider-runnable-track {
                    height: 6px;
                    border-radius: 9999px;
                    background: transparent;
                }
                .pricing-slider::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    margin-top: -9px;
                }
                .pricing-slider::-moz-range-track {
                    height: 6px;
                    border-radius: 9999px;
                    background: transparent;
                    border: none;
                }
                .pricing-slider::-moz-range-thumb {
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    background: transparent;
                    border: none;
                    cursor: pointer;
                }
            ` }} />
            <div className="relative h-10 flex items-center">
                {/* Track background */}
                <div className="absolute inset-x-0 h-1.5 rounded-full bg-border" />
                {/* Track fill */}
                <div
                    className="absolute left-0 h-1.5 rounded-full bg-primary"
                    style={{ width: `${pct}%` }}
                />
                {/* Visual thumb */}
                <div
                    className="absolute -translate-x-1/2 w-4 h-4 rounded-full bg-primary shadow-[0_0_0_3px_rgba(235,53,20,0.2)] pointer-events-none"
                    style={{ left: `${pct}%` }}
                />
                {/* Native range input on top (invisible, handles interaction) */}
                <input
                    type="range"
                    min={0}
                    max={SLIDER_STEPS}
                    value={sliderValue}
                    onChange={(e) => {
                        const pct = Number(e.target.value) / SLIDER_STEPS;
                        onChange(roundCalls(pctToCalls(pct)));
                    }}
                    className="pricing-slider absolute inset-0"
                />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
                <span>{formatNumber(MIN_SLIDER)}</span>
                <span>{formatNumber(MAX_SLIDER)}+</span>
            </div>
        </div>
    );
}

function FeatureRow({
    text,
    included,
    highlight,
}: {
    text: string;
    included: boolean;
    highlight?: boolean;
}) {
    return (
        <div className="flex items-start gap-2">
            {included ? (
                <svg
                    className={`mt-0.5 h-4 w-4 shrink-0 ${highlight ? "text-primary" : "text-muted-foreground"}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                    />
                </svg>
            ) : (
                <svg
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                    />
                </svg>
            )}
            <span
                className={`text-sm ${
                    highlight
                        ? "text-foreground font-medium"
                        : included
                          ? "text-muted-foreground"
                          : "text-muted-foreground/40 line-through"
                }`}
            >
                {text}
            </span>
        </div>
    );
}

const COMPETITORS = [
    {
        name: "RelayAPI",
        highlight: true,
        price10: "$5",
        price50: "$10",
        price500: "$145",
        note: "~300 API calls/customer (50 posts, comments). GET/HEAD requests are free. $5 base incl. 10K calls + $1/1K extra",
    },
    {
        name: "Per-account API",
        highlight: false,
        price10: "$299",
        price50: "$779",
        price500: "$2,624",
        note: "Representative profile-based pricing with higher base fees and account overage",
    },
    {
        name: "Usage-based account API",
        highlight: false,
        price10: "$55",
        price50: "$275",
        price500: "$2,750",
        note: "Representative account-priced model with linear per-account growth",
    },
];

function ComparisonTable() {
    return (
        <div className="border-t border-border">
            <div className="p-8 md:p-14 space-y-8">
                <div className="space-y-2">
                    <h3 className="text-2xl font-medium tracking-tighter md:text-3xl">
                        Compare the real cost
                    </h3>
                    <p className="text-sm text-muted-foreground max-w-xl">
                        Most social APIs charge per account or stack add-on
                        pricing on top of a base plan. Here&apos;s how RelayAPI
                        compares against common pricing models.
                    </p>
                </div>

                <div className="overflow-x-auto -mx-8 px-8 md:mx-0 md:px-0">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border">
                                <th className="text-left py-3 pr-4 font-medium text-muted-foreground">
                                    Platform
                                </th>
                                <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                                    10 customers
                                </th>
                                <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                                    50 customers
                                </th>
                                <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                                    500 customers
                                </th>
                                <th className="text-left py-3 pl-4 font-medium text-muted-foreground hidden lg:table-cell">
                                    Notes
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {COMPETITORS.map((c) => (
                                <tr
                                    key={c.name}
                                    className={`border-b border-border last:border-0 ${c.highlight ? "bg-primary/5" : ""}`}
                                >
                                    <td className="py-4 pr-4">
                                        <span
                                            className={`font-medium ${c.highlight ? "text-primary" : "text-foreground"}`}
                                        >
                                            {c.name}
                                        </span>
                                    </td>
                                    <td className="py-4 px-4 text-right">
                                        <span
                                            className={`font-semibold tabular-nums ${c.highlight ? "text-primary" : "text-foreground"}`}
                                        >
                                            {c.price10}
                                        </span>
                                        <span className="text-muted-foreground">
                                            /mo
                                        </span>
                                    </td>
                                    <td className="py-4 px-4 text-right">
                                        <span
                                            className={`font-semibold tabular-nums ${c.highlight ? "text-primary" : "text-foreground"}`}
                                        >
                                            {c.price50}
                                        </span>
                                        <span className="text-muted-foreground">
                                            /mo
                                        </span>
                                    </td>
                                    <td className="py-4 px-4 text-right">
                                        <span
                                            className={`font-semibold tabular-nums ${c.highlight ? "text-primary" : "text-foreground"}`}
                                        >
                                            {c.price500}
                                        </span>
                                        <span className="text-muted-foreground">
                                            /mo
                                        </span>
                                    </td>
                                    <td className="py-4 pl-4 text-muted-foreground hidden lg:table-cell">
                                        {c.note}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <p className="text-xs text-muted-foreground">
                    Prices as of March 2026. Includes analytics and
                    comments/DMs where available. RelayAPI does not charge per
                    connected customer. Abuse of free GET/HEAD requests may
                    result in account suspension.
                </p>
            </div>
        </div>
    );
}

export function PricingSection() {
    const [calls, setCalls] = useState(MIN_SLIDER);
    const price = calculatePrice(calls);
    const isCustom = price > CUSTOM_SPEND_THRESHOLD;

    return (
        <section id="pricing" className="relative w-full">
            <div className="mx-auto">
                <div className="grid divide-x divide-border md:grid-cols-6">
                    {/* Left: explanation */}
                    <div className="col-span-2 flex flex-col gap-6 p-8 md:p-14">
                        <div className="space-y-4">
                            <h3 className="text-3xl font-medium tracking-tighter md:text-4xl">
                                Built for developers. Priced to scale.
                            </h3>
                            <p className="text-balance text-muted-foreground">
                                Start free with 200 requests/month. Upgrade to
                                Pro for full access and pay only for what you
                                use.
                            </p>
                        </div>

                        <div className="space-y-3 border-t border-border pt-6">
                            <p className="text-sm font-medium text-secondary-foreground">
                                How it works
                            </p>
                            <ul className="space-y-1.5 text-sm text-muted-foreground">
                                <li>Free plan: 200 requests/month</li>
                                <li>
                                    Pro: {formatNumber(PRO_INCLUDED_CALLS)}{" "}
                                    calls included at $5/mo
                                </li>
                                <li>
                                    Overage: $1 per 1,000 extra calls
                                </li>
                                <li>
                                    Spending over $100/mo? We&apos;ll customize
                                    your rate
                                </li>
                            </ul>
                            <p className="text-xs text-muted-foreground/70 pt-1">
                                A request is any action that creates or changes data — publishing
                                a post, uploading media, or connecting an account. Listing posts,
                                checking analytics, and reading data never count toward your limit.
                            </p>
                        </div>

                        {/* Competitor comparison callout */}
                        <div className="space-y-3 border-t border-border pt-6">
                            <p className="text-sm font-medium text-secondary-foreground">
                                Why Relay?
                            </p>
                            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2">
                                <p className="text-sm font-medium text-foreground">
                                    Analytics & Comments included
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    Other APIs charge $10–50/mo extra for
                                    analytics and comments as paid add-ons. With
                                    Relay, they&apos;re included in every Pro
                                    plan at no extra cost.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Right: two plan cards side by side */}
                    <div className="col-span-4">
                        <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border h-full">
                            {/* Free card */}
                            <div className="flex flex-col p-8 md:p-10">
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                                            Free
                                        </p>
                                        <span className="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                                            Most popular ;P
                                        </span>
                                    </div>
                                    <div className="flex items-baseline gap-1">
                                        <span className="text-4xl font-semibold tracking-tight md:text-5xl">
                                            $0
                                        </span>
                                        <span className="text-lg text-muted-foreground">
                                            /month
                                        </span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">
                                        200 requests/month
                                    </p>
                                </div>

                                <div className="mt-8 space-y-3 flex-1">
                                    {FREE_FEATURES.map((f, i) => (
                                        <FeatureRow key={i} {...f} />
                                    ))}
                                </div>

                                <Button
                                    size="lg"
                                    asChild
                                    variant="outline"
                                    className="mt-8 w-full cursor-pointer rounded-full border-border bg-transparent text-secondary-foreground transition-all duration-300 ease-in-out hover:bg-accent hover:scale-[1.02]"
                                >
                                    <a href="#">Sign Up Free</a>
                                </Button>
                            </div>

                            {/* Pro card */}
                            <div className="flex flex-col p-8 md:p-10">
                                <div className="space-y-4">
                                    <p className="text-sm font-medium text-primary uppercase tracking-wider">
                                        Pro
                                    </p>
                                    <div className="flex items-baseline gap-1">
                                        <span className="text-4xl font-semibold tracking-tight md:text-5xl">
                                            {isCustom
                                                ? "Custom"
                                                : formatPrice(price)}
                                        </span>
                                        {!isCustom && (
                                            <span className="text-lg text-muted-foreground">
                                                /month
                                            </span>
                                        )}
                                    </div>
                                    {isCustom ? (
                                        <p className="text-sm text-muted-foreground">
                                            Let&apos;s build a plan for your
                                            volume
                                        </p>
                                    ) : calls <= PRO_INCLUDED_CALLS ? (
                                        <p className="text-sm text-muted-foreground">
                                            {formatNumber(PRO_INCLUDED_CALLS)}{" "}
                                            requests included
                                        </p>
                                    ) : (
                                        <p className="text-sm text-muted-foreground">
                                            {formatNumber(calls)} requests/month
                                        </p>
                                    )}
                                </div>

                                {/* Slider */}
                                <div className="mt-6">
                                    <p className="text-xs text-muted-foreground mb-2">
                                        Estimate your monthly requests
                                    </p>
                                    <PricingSlider
                                        value={calls}
                                        onChange={setCalls}
                                    />
                                </div>

                                <div className="mt-6 space-y-3 flex-1">
                                    {getProFeatures(isCustom).map((f, i) => (
                                        <FeatureRow key={i} {...f} />
                                    ))}
                                </div>

                                <Button
                                    size="lg"
                                    asChild
                                    className="mt-8 w-full cursor-pointer rounded-full bg-primary text-primary-foreground transition-all duration-300 ease-in-out hover:bg-primary/80 hover:scale-[1.02]"
                                >
                                    <a href="#">
                                        {isCustom
                                            ? "Contact Us"
                                            : "Get Started"}
                                    </a>
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Competitor price comparison */}
                <ComparisonTable />
            </div>
        </section>
    );
}
