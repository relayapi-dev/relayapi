"use client";

import { useState } from "react";
import { Zap, Shield, Heart } from "lucide-react";
import { getApiBySlug } from "../../lib/api-data";
import type { ApiData } from "../../lib/api-data";
import { platforms } from "../../lib/platform-data";
import { Navbar } from "../section/navbar";
import { Button } from "../ui/button";
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "../ui/accordion";

// ---------- Syntax highlighting helpers ----------

function highlightCode(code: string, language: string) {
    const keywords =
        /\b(const|let|var|function|return|import|from|export|default|if|else|async|await|new|class|try|catch|throw|for|while|of|in|typeof|instanceof|void|null|undefined|true|false)\b/g;
    const strings = /(["'`])(?:(?=(\\?))\2.)*?\1/g;
    const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)/gm;
    const numbers = /\b(\d+\.?\d*)\b/g;

    let result = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Order matters: comments first, then strings, then keywords
    result = result.replace(
        comments,
        '<span style="color:#6a9955">$&</span>'
    );
    result = result.replace(
        strings,
        '<span style="color:#ce9178">$&</span>'
    );
    result = result.replace(
        keywords,
        '<span style="color:#569cd6">$&</span>'
    );
    result = result.replace(
        numbers,
        '<span style="color:#b5cea8">$&</span>'
    );

    return result;
}

// ---------- Main component ----------

export function ApiPage({ slug }: { slug: string }) {
    const api = getApiBySlug(slug);

    if (!api) {
        return (
            <div className="max-w-7xl mx-auto border-x border-border">
                <Navbar />
                <div className="pt-16 md:pt-32 pb-10 md:pb-16 px-4 md:px-6 text-center">
                    <h1 className="text-4xl font-medium tracking-tighter text-foreground">
                        API not found
                    </h1>
                    <p className="mt-4 text-muted-foreground">
                        The API you're looking for doesn't exist.
                    </p>
                    <Button asChild size="lg" className="mt-8 rounded-full px-8">
                        <a href="/">Go Home</a>
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-7xl mx-auto border-x border-border">
            {/* 1. Navbar */}
            <Navbar />

            <main className="pt-16">
            {/* 2. Hero Section */}
            <HeroSection api={api} />

            {/* 3. Features Grid */}
            <FeaturesSection api={api} />

            {/* 4. How It Works */}
            <HowItWorksSection />

            {/* 5. Why Developers Choose RelayAPI */}
            <BenefitsSection api={api} />

            {/* 6. Code Examples */}
            <CodeExamplesSection api={api} />

            {/* 7. Supported Platforms */}
            <PlatformsSection />

            {/* 8. FAQ */}
            <FaqSection api={api} />

            {/* 9. Footer CTA */}
            <FooterCta />

            {/* 10. Copyright */}
            <div className="border-t border-border py-4">
                <p className="text-sm text-muted-foreground text-center">
                    &copy; 2026 Relay. All rights reserved.
                </p>
            </div>
            </main>
        </div>
    );
}

// ---------- Section components ----------

function HeroSection({ api }: { api: ApiData }) {
    return (
        <section className="pt-16 md:pt-32 pb-10 md:pb-16 px-4 md:px-6">
            <div className="max-w-5xl mx-auto text-center space-y-6">
                <h1 className="text-4xl md:text-5xl lg:text-6xl font-medium tracking-tighter text-foreground text-balance">
                    {api.heroTitle}
                </h1>
                <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto text-balance">
                    {api.heroDescription}
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4 w-full sm:w-auto px-2 sm:px-0">
                    <Button
                        asChild
                        size="lg"
                        className="w-full sm:w-auto rounded-full px-8"
                    >
                        <a href="#">Start Building Free</a>
                    </Button>
                    <Button
                        asChild
                        size="lg"
                        variant="outline"
                        className="w-full sm:w-auto rounded-full px-8"
                    >
                        <a href="https://docs.relayapi.dev/">View API Docs</a>
                    </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                    No credit card required &middot; Full API access
                </p>
            </div>
        </section>
    );
}

function FeaturesSection({ api }: { api: ApiData }) {
    return (
        <section className="py-10 md:py-24 px-4 md:px-6">
            <div className="max-w-5xl mx-auto space-y-8">
                <div className="space-y-3">
                    <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider text-center">
                        Features
                    </p>
                    <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-foreground text-center">
                        Everything you need
                    </h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-8 md:p-12">
                    {api.features.map((feature) => (
                        <div
                            key={feature.title}
                            className="rounded-xl border border-border bg-card p-6 space-y-3"
                        >
                            <h3 className="font-semibold text-foreground">
                                {feature.title}
                            </h3>
                            <p className="text-sm text-muted-foreground">
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
    const steps = [
        {
            number: 1,
            title: "Get Your API Key",
            description:
                "Sign up and generate your credentials in seconds.",
        },
        {
            number: 2,
            title: "Connect Social Accounts",
            description:
                "Link platforms via OAuth with our guided setup flow.",
        },
        {
            number: 3,
            title: "Start Building",
            description:
                "Use the API to publish, manage, and track content across all platforms.",
        },
    ];

    return (
        <section className="py-10 md:py-24 px-4 md:px-6">
            <div className="max-w-5xl mx-auto space-y-12">
                <div className="space-y-3">
                    <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider text-center">
                        How It Works
                    </p>
                    <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-foreground text-center">
                        Up and running in minutes
                    </h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    {steps.map((step) => (
                        <div
                            key={step.number}
                            className="flex flex-col items-center text-center space-y-4"
                        >
                            <div className="flex items-center justify-center w-10 h-10 bg-primary text-white rounded-full text-lg font-semibold">
                                {step.number}
                            </div>
                            <h3 className="text-lg font-semibold text-foreground">
                                {step.title}
                            </h3>
                            <p className="text-sm text-muted-foreground max-w-xs">
                                {step.description}
                            </p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

function BenefitsSection({ api }: { api: ApiData }) {
    const icons = [Zap, Shield, Heart];

    return (
        <section className="py-10 md:py-24 px-4 md:px-6">
            <div className="max-w-5xl mx-auto space-y-8">
                <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-foreground text-center">
                    Why Developers Choose RelayAPI
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {api.benefits.map((benefit, index) => {
                        const Icon = icons[index] ?? Zap;
                        return (
                            <div
                                key={benefit.title}
                                className="rounded-xl border border-border bg-card p-8 space-y-4"
                            >
                                <Icon className="w-6 h-6 text-primary" />
                                <h3 className="text-lg font-semibold text-foreground">
                                    {benefit.title}
                                </h3>
                                <p className="text-sm text-muted-foreground">
                                    {benefit.description}
                                </p>
                            </div>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}

function CodeExamplesSection({ api }: { api: ApiData }) {
    const [activeTab, setActiveTab] = useState(0);

    if (api.codeExamples.length === 0) return null;

    return (
        <section className="py-10 md:py-24 px-4 md:px-6">
            <div className="max-w-5xl mx-auto space-y-8">
                <div className="space-y-3">
                    <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider text-center">
                        Quick Start
                    </p>
                    <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-foreground text-center">
                        Start building in minutes
                    </h2>
                </div>
                <div className="space-y-4">
                    {/* Tab buttons */}
                    <div className="flex flex-wrap gap-2">
                        {api.codeExamples.map((example, index) => (
                            <button
                                key={example.label}
                                onClick={() => setActiveTab(index)}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                    index === activeTab
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-card border border-border text-foreground hover:bg-muted"
                                }`}
                            >
                                {example.label}
                            </button>
                        ))}
                    </div>

                    {/* Code block */}
                    <div className="rounded-xl overflow-hidden">
                        <pre className="bg-[#1a1a2e] text-gray-100 p-6 overflow-x-auto text-sm leading-relaxed">
                            <code
                                dangerouslySetInnerHTML={{
                                    __html: highlightCode(
                                        api.codeExamples[activeTab]?.code ?? "",
                                        api.codeExamples[activeTab]?.language ?? ""
                                    ),
                                }}
                            />
                        </pre>
                    </div>
                </div>
            </div>
        </section>
    );
}

function PlatformsSection() {
    return (
        <section className="py-10 md:py-24 px-4 md:px-6">
            <div className="max-w-5xl mx-auto space-y-8">
                <div className="space-y-3">
                    <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider text-center">
                        Integrations
                    </p>
                    <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-foreground text-center">
                        Works With All 17 Platforms
                    </h2>
                </div>
                <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {platforms.map((platform) => (
                        <a
                            key={platform.slug}
                            href={`/product/${platform.slug}`}
                            className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4 text-center transition-colors hover:bg-muted hover:border-primary/30"
                        >
                            <span className="text-foreground">
                                {platform.icon}
                            </span>
                            <span className="text-xs font-medium text-muted-foreground">
                                {platform.name}
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
        <section className="py-10 md:py-24 px-4 md:px-6">
            <div className="max-w-3xl mx-auto space-y-8">
                <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-foreground text-center">
                    Frequently Asked Questions
                </h2>
                <Accordion type="single" collapsible className="w-full">
                    {api.faq.map((item, index) => (
                        <AccordionItem key={index} value={`faq-${index}`}>
                            <AccordionTrigger>{item.question}</AccordionTrigger>
                            <AccordionContent>
                                <p className="text-muted-foreground">
                                    {item.answer}
                                </p>
                            </AccordionContent>
                        </AccordionItem>
                    ))}
                </Accordion>
            </div>
        </section>
    );
}

function FooterCta() {
    return (
        <section className="w-full">
            <div className="bg-primary rounded-2xl p-8 md:p-12 mx-6 md:mx-12 mb-8 flex flex-col items-center text-center space-y-6">
                <h2 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tighter text-white text-balance">
                    Ready to Start Building?
                </h2>
                <p className="text-white/80 text-lg font-medium max-w-lg">
                    Get your API key and start publishing across 17 platforms in
                    minutes.
                </p>
                <Button
                    asChild
                    size="lg"
                    variant="outline"
                    className="border-white text-white hover:bg-white/10 rounded-full px-8"
                >
                    <a href="#">Start Building Free</a>
                </Button>
            </div>
        </section>
    );
}
