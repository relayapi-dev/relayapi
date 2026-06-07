import type { MouseEvent } from "react";

/** Keep the browser default for modified clicks (open-in-new-tab, etc.). */
export function isModifiedClick(e: MouseEvent): boolean {
	return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/**
 * Reliable full-document navigation for links that live inside a container which
 * closes/animates/unmounts on tap (slide-out drawers, AnimatePresence menus).
 * iOS Safari drops the native <a> default navigation in that case, so navigate
 * explicitly.
 *
 * Returns true when it took over the navigation. Returns false (and does
 * nothing) for modified clicks, external links, and in-page hash anchors — none
 * of which are affected by the iOS bug — so the browser keeps its default
 * behavior (open-in-new-tab, hash jump, etc.). Callers can use the return value
 * to decide whether they still need to run their own side effect (e.g. closing
 * the menu) when the browser handles the click natively.
 */
export function followLink(
	e: MouseEvent<HTMLAnchorElement>,
	href: string,
): boolean {
	if (isModifiedClick(e)) return false;
	// Only take over plain in-app navigations (absolute paths). External links
	// (protocol-relative or with a scheme) and "#" anchors keep native behavior.
	if (!href.startsWith("/") || href.startsWith("//")) return false;
	e.preventDefault();
	window.location.href = href;
	return true;
}
