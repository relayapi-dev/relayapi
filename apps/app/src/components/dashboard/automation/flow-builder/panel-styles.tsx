// Shared chrome for the canvas's floating right-side panels.
//
// Every right-side panel — Runs, Insights, Simulator, Property, Trigger and
// Binding — uses these so they read as one monochrome system: a shadow-free,
// rounded, bordered card that floats off the canvas surface with an `m-3`
// gutter. Width is set per-panel (the panels differ in how much they show).
//
// The flow builder intentionally uses a fixed light palette (it renders the
// canvas on a hard-coded `#f9f9f8` surface), so these constants use neutral
// hex values rather than theme tokens to stay in lockstep with the canvas.

import type { ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";

/** Floating panel shell — monochrome, shadow-free, rounded. Append a width. */
export const PANEL_SHELL_CLS =
	"m-3 flex min-h-0 flex-col overflow-hidden rounded-[22px] border border-[#e6e9ef] bg-white";

/** Scroll-body background shared by every panel. */
export const PANEL_BODY_CLS = "flex-1 bg-[#fbfcfe]";

/** Neutral circular icon bubble used in panel headers and node cards. */
export const PANEL_ICON_BUBBLE_CLS =
	"flex size-9 shrink-0 items-center justify-center rounded-full bg-[#f4f5f7] text-[#5a6373]";

/** Round, neutral icon button (close / refresh / back affordances). */
export const PANEL_ICON_BUTTON_CLS =
	"shrink-0 rounded-full p-1.5 text-[#9aa1ad] transition hover:bg-[#f1f2f5] hover:text-[#353a44]";

/**
 * Standard panel header row: an icon bubble (or a back chevron), a
 * title/subtitle stack, optional inline actions, and a close button. Shared
 * across panels so the chrome is identical everywhere.
 */
export function PanelHeader({
	icon,
	title,
	subtitle,
	onClose,
	onBack,
	actions,
}: {
	icon?: ReactNode;
	title: ReactNode;
	subtitle?: ReactNode;
	onClose?: () => void;
	onBack?: () => void;
	actions?: ReactNode;
}) {
	return (
		<div className="flex shrink-0 items-center gap-3 border-b border-[#eef0f4] px-5 py-4">
			{onBack ? (
				<button
					type="button"
					onClick={onBack}
					className={`-ml-1 ${PANEL_ICON_BUTTON_CLS}`}
					aria-label="Back"
				>
					<ChevronLeft className="size-4" />
				</button>
			) : icon ? (
				<div className={PANEL_ICON_BUBBLE_CLS}>{icon}</div>
			) : null}
			<div className="min-w-0 flex-1">
				<h3 className="truncate text-[15px] font-semibold leading-5 text-[#353a44]">
					{title}
				</h3>
				{subtitle ? (
					<p className="mt-0.5 truncate text-[12px] leading-4 text-[#8b92a0]">
						{subtitle}
					</p>
				) : null}
			</div>
			{actions}
			{onClose ? (
				<button
					type="button"
					onClick={onClose}
					className={PANEL_ICON_BUTTON_CLS}
					aria-label="Close"
				>
					<X className="size-4" />
				</button>
			) : null}
		</div>
	);
}
