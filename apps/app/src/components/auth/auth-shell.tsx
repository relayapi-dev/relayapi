import type { ReactNode } from "react";
import { Icons } from "../icons";

/**
 * Shared chrome for the auth screens (login / signup), modelled on the
 * RelayAPI design-system "Sign in" mockup: a slim top bar with the brand mark,
 * a flat centered column (no card — borders do the structural work), and a
 * muted legal footer pinned to the bottom of the viewport.
 */
export function AuthShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-screen flex-col bg-background text-foreground">
			<header className="flex items-center justify-between px-6 py-5">
				<a
					href="/"
					className="inline-flex items-center gap-2.5 transition-opacity hover:opacity-80"
				>
					<span className="inline-flex size-[1.625rem] items-center justify-center rounded-[0.4375rem] bg-foreground">
						<Icons.logo className="size-3.5 text-background" />
					</span>
					<span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">
						RelayAPI
					</span>
				</a>
			</header>

			<main className="flex flex-1 items-center justify-center px-6 pb-10">
				<div className="w-full max-w-[23.75rem]">{children}</div>
			</main>

			<footer className="px-6 pb-7 text-center text-xs text-muted-foreground">
				<a
					href="/terms"
					className="transition-colors hover:text-foreground"
				>
					Terms of Service
				</a>
				<span className="px-1.5">·</span>
				<a
					href="/privacy"
					className="transition-colors hover:text-foreground"
				>
					Privacy Policy
				</a>
			</footer>
		</div>
	);
}

function GoogleGlyph({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden="true">
			<path
				d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
				fill="#4285F4"
			/>
			<path
				d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
				fill="#34A853"
			/>
			<path
				d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
				fill="#FBBC05"
			/>
			<path
				d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
				fill="#EA4335"
			/>
		</svg>
	);
}

/**
 * Full-width OAuth provider button. Grayscale glyph + "Continue with …" label,
 * with an optional "Last used" badge floating off the top-right corner (shown
 * to returning users — see the `relayapi:last_auth_method` localStorage hint).
 */
export function ProviderButton({
	label,
	onClick,
	lastUsed = false,
}: {
	label: string;
	onClick: () => void;
	lastUsed?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="relative flex h-[2.875rem] w-full items-center justify-center gap-2.5 rounded-md border border-border bg-card text-sm font-medium text-foreground transition-colors duration-100 ease-[var(--ease-relay)] hover:bg-accent"
		>
			<GoogleGlyph className="size-[1.0625rem] grayscale opacity-90" />
			<span>Continue with {label}</span>
			{lastUsed ? (
				<span className="absolute -top-2 right-2.5 rounded-full bg-foreground px-[0.4375rem] py-0.5 text-[0.65625rem] font-medium text-background">
					Last used
				</span>
			) : null}
		</button>
	);
}

/** "OR" rule between the provider buttons and the email form. */
export function AuthDivider() {
	return (
		<div className="my-5 flex items-center gap-3 text-[0.6875rem] tracking-[0.08em] text-muted-foreground">
			<span className="h-px flex-1 bg-border" />
			OR
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

export const LAST_AUTH_KEY = "relayapi:last_auth_method";
