"use client";

import { Download, FileText, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

function GithubIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" className={className}>
			<path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
		</svg>
	);
}

export function SidebarFooter() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => setMounted(true), []);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<a
						href="https://relayapi.dev/signup"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center justify-center rounded-md bg-fd-primary px-2 py-1.5 text-xs font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/80"
					>
						Dashboard
					</a>
					<div className="flex items-center gap-0.5">
						<a
							href="https://github.com/relayapi-dev/relayapi"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
							title="GitHub"
						>
							<GithubIcon className="size-4.5" />
						</a>
					</div>
				</div>
				{mounted && (
					<button
						onClick={() =>
							setTheme(resolvedTheme === "dark" ? "light" : "dark")
						}
						className="inline-flex items-center rounded-full border p-0.5"
						aria-label="Toggle Theme"
					>
						<Sun
							className={`size-6.5 rounded-full p-1.5 transition-colors ${
								resolvedTheme === "light"
									? "bg-fd-accent text-fd-accent-foreground"
									: "text-fd-muted-foreground"
							}`}
							fill="currentColor"
						/>
						<Moon
							className={`size-6.5 rounded-full p-1.5 transition-colors ${
								resolvedTheme === "dark"
									? "bg-fd-accent text-fd-accent-foreground"
									: "text-fd-muted-foreground"
							}`}
							fill="currentColor"
						/>
					</button>
				)}
			</div>
			<div className="flex gap-2">
				<a
					href="/llms-full.txt"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex w-1/2 items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
					title="Full documentation for LLMs"
				>
					<FileText className="size-4 mr-1" aria-hidden />
					llms.txt
				</a>
				<a
					href="https://api.relayapi.dev/openapi.json"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex w-1/2 items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
					title="Download OpenAPI specification"
				>
					<Download className="size-4 mr-1" aria-hidden />
					OpenAPI
				</a>
			</div>
		</div>
	);
}
