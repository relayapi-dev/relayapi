export function SelfHostSection() {
    return (
        <section className="py-16 md:py-20 px-6">
            <div className="max-w-2xl mx-auto text-center space-y-4">
                <div className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground bg-muted/50 border border-border rounded-full px-4 py-1.5">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" /><path d="M9 18c-4.51 2-5-2-7-2" /></svg>
                    Open Source
                </div>
                <h2 className="text-2xl md:text-3xl font-bold tracking-tighter text-foreground text-balance">
                    Prefer to run it yourself? You can.
                </h2>
                <p className="text-muted-foreground text-balance leading-relaxed">
                    RelayAPI is fully open source. If our plans don't fit your needs, you're free to
                    self-host the entire platform on your own infrastructure — no strings attached.
                </p>
                <div className="pt-2">
                    <a
                        href="https://github.com/relayapi-dev/relayapi"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors underline underline-offset-4 decoration-border hover:decoration-primary"
                    >
                        View on GitHub
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" x2="21" y1="14" y2="3" /></svg>
                    </a>
                </div>
            </div>
        </section>
    );
}
