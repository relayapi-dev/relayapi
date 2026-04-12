import { Navbar } from "../section/navbar";
import { PricingSection } from "../section/pricing-section";
import { FAQSection } from "../section/faq-section";
import { SelfHostSection } from "../section/self-host-section";
import { Button } from "../ui/button";

export function PricingPage() {
    return (
        <div className="max-w-7xl mx-auto border-x border-border">
            <Navbar />
            <main className="flex flex-col divide-y divide-border pt-16">
                {/* Hero */}
                <section className="py-16 md:py-24 px-6 text-center">
                    <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                        Pricing
                    </p>
                    <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter text-foreground mt-4 text-balance">
                        Simple, transparent pricing
                    </h1>
                    <p className="text-lg text-muted-foreground max-w-2xl mx-auto mt-6 text-balance">
                        Start free with 200 requests/month. Upgrade to Pro for $5/mo.
                        No hidden fees, no per-platform charges.
                    </p>
                </section>

                {/* Pricing slider (reused from homepage) */}
                <PricingSection />

                {/* FAQ */}
                <FAQSection />

                {/* Self-host callout */}
                <SelfHostSection />

                {/* Footer CTA */}
                <section className="py-8">
                    <div className="px-6 md:px-12 pb-8">
                        <div className="bg-primary rounded-2xl p-8 md:p-12 flex flex-col items-center text-center space-y-6">
                            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-white text-balance">
                                Ready to get started?
                            </h2>
                            <p className="text-white/80 text-lg font-medium">
                                Free plan available. No credit card required.
                            </p>
                            <Button
                                asChild
                                size="lg"
                                variant="outline"
                                className="border-white text-white hover:bg-white/10 rounded-full px-8"
                            >
                                <a href="/signup">Start Free Trial</a>
                            </Button>
                        </div>
                    </div>

                    <div className="border-t border-border py-4">
                        <p className="text-sm text-muted-foreground text-center">
                            &copy; {new Date().getFullYear()} Relay. All rights reserved.
                        </p>
                    </div>
                </section>
            </main>
        </div>
    );
}
