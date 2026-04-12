import { Feature } from "../animations/feature-slide";
import { siteConfig } from "../../lib/config";

export function DemoSection() {
    const { title, description, items } = siteConfig.demoSection;

    return (
        <section
            id="demo"
            className="w-full relative"
        >
            <div className="border-b px-6 py-10 md:py-14">
                <div className="max-w-2xl mx-auto text-center space-y-3">
                    <p className="text-xs font-medium uppercase tracking-widest text-sky-500">How it works</p>
                    <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">{title}</h2>
                    <p className="text-muted-foreground text-balance">{description}</p>
                </div>
            </div>
            <Feature
                collapseDelay={5000}
                linePosition="bottom"
                featureItems={items}
                lineColor="bg-sky-500"
            />
        </section>
    );
}
