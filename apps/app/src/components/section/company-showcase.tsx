import { siteConfig } from "../../lib/config";

export function CompanyShowcase() {
    const { companyShowcase } = siteConfig;

    return (
        <section
            id="company"
            className="relative flex w-full items-center justify-center py-12"
        >
            <div className="w-full max-w-7xl">
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider text-center mb-8">
                    Trusted by builders at
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                    {companyShowcase.companyLogos.map((logo) => (
                        <div
                            key={logo.id}
                            className="flex items-center justify-center px-6 py-4 grayscale opacity-60 hover:grayscale-0 hover:opacity-100 transition-all"
                        >
                            {logo.logo}
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
