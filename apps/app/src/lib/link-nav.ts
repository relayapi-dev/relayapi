import type { MouseEvent } from "react";

/** Keep the browser default for modified clicks (open-in-new-tab, etc.). */
export function isModifiedClick(e: MouseEvent): boolean {
	return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/**
 * For links inside a container that closes/animates/unmounts on tap (slide-out
 * drawers, AnimatePresence menus), the native <a href> must own navigation: a
 * real anchor tap begins document unload synchronously, which is reliable on iOS
 * Safari and wins the race against any prefetch-triggered reload. Closing or
 * animating the menu in the same tick is exactly what makes iOS DROP the
 * navigation, so for plain in-app links we let the anchor navigate and skip the
 * menu-close side effect (the full-document load tears the menu down anyway).
 *
 * Returns true when the caller should SKIP its onClose() side effect — i.e. a
 * plain in-app navigation the native anchor will handle. Returns false for
 * modified clicks, external links, and in-page hash anchors, so the caller
 * closes the menu and the browser keeps native behavior (open-in-new-tab,
 * external nav, hash jump). This function intentionally does NOT preventDefault
 * or assign location — the anchor does the navigating.
 */
export function followLink(
	e: MouseEvent<HTMLAnchorElement>,
	href: string,
): boolean {
	if (isModifiedClick(e)) return false;
	// Only plain in-app navigations (absolute paths) are left to the native
	// anchor. External links (protocol-relative or with a scheme) and "#" anchors
	// keep native behavior and should still close the menu.
	if (!href.startsWith("/") || href.startsWith("//")) return false;
	return true;
}
