import { siteConfig } from "../../lib/config";
import { Icons } from "../icons";
import { Button } from "../ui/button";

export function Footer() {
    const { footerLinks, name, links } = siteConfig;

    return (
        <footer className="w-full">
            {/* Integrated CTA box */}
            <div className="px-6 md:px-12 pt-12 pb-8">
                <div className="bg-primary rounded-2xl p-8 md:p-12 flex flex-col items-center text-center space-y-6">
                    <h2 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tighter text-white text-balance">
                        Stop maintaining 17 integrations.
                    </h2>
                    <p className="text-white/80 text-lg font-medium">
                        Start shipping features.
                    </p>
                    <Button
                        asChild
                        size="lg"
                        variant="outline"
                        className="border-white text-white hover:bg-white/10 rounded-full px-8"
                    >
                        <a href="#">Get started</a>
                    </Button>
                </div>
            </div>

            {/* Footer links grid */}
            <div className="px-8 md:px-12 py-12">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                    {footerLinks.map((section) => (
                        <div
                            key={section.title}
                            className="flex flex-col gap-4"
                        >
                            <h3 className="text-sm font-semibold text-foreground">
                                {section.title}
                            </h3>
                            <ul className="flex flex-col gap-3">
                                {section.links.map((link) => (
                                    <li key={link.id}>
                                        <a
                                            href={link.url}
                                            {...(link.url.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                                            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            {link.title}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}

                    {/* Compliance badges column */}
                    <div className="flex flex-col gap-4">
                        <h3 className="text-sm font-semibold text-foreground">
                            Compliance
                        </h3>
                        <div className="flex items-center gap-3">
                            <Icons.soc2 className="w-10 h-10" />
                            <Icons.hipaa className="w-10 h-10" />
                            <Icons.gdpr className="w-10 h-10" />
                        </div>
                    </div>
                </div>
            </div>

            {/* Social icons row */}
            <div className="px-8 md:px-12 pb-6 flex items-center gap-4">
                <a
                    href={links.twitter}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Twitter"
                >
                    <svg
                        className="w-5 h-5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                    >
                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                </a>
                <a
                    href={links.github}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="GitHub"
                >
                    <svg
                        className="w-5 h-5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                    >
                        <path
                            fillRule="evenodd"
                            clipRule="evenodd"
                            d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                        />
                    </svg>
                </a>
            </div>

            {/* Copyright bar */}
            <div className="border-t border-border py-4">
                <p className="text-sm text-muted-foreground text-center">
                    &copy; {new Date().getFullYear()} {name}. All rights reserved.
                </p>
            </div>
        </footer>
    );
}
