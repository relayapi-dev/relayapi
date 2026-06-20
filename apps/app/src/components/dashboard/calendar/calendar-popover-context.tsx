import { createContext } from "react";

export interface CalendarPopoverContextValue {
  /** id of the post card whose preview popover is currently open, or null */
  openId: string | null;
  setOpenId: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Shares "which post card preview is open" across the whole calendar so that
 * opening one preview closes any other. A null context means there is no shared
 * controller and cards fall back to their own local open state (e.g. the drag
 * overlay, which renders outside the provider).
 */
export const CalendarPopoverContext = createContext<CalendarPopoverContextValue | null>(null);

/** Marks a calendar post-card trigger so an open preview can detect a click on another card. */
export const CALENDAR_CARD_ATTR = "data-calendar-card";

/**
 * Radix `onInteractOutside` handler shared by every calendar preview popover.
 *
 * Without it, clicking a second card while one preview is open makes Radix
 * dismiss the open popover on pointer-down and swallow the click that should
 * open the next preview — so it only switches on the *second* click.
 *
 * Here we detect when the outside interaction lands on another post card and
 * call `preventDefault()`, which cancels the dismiss. The clicked card's own
 * handler then sets the shared `openId`; because every popover's open state is
 * derived from that id, the previous preview closes while the new one opens in
 * the same gesture — a single-click switch.
 */
export function handleCalendarPreviewInteractOutside(event: {
  detail?: { originalEvent?: Event } | null;
  preventDefault: () => void;
}) {
  const orig = event.detail?.originalEvent as (Event & { relatedTarget?: EventTarget | null }) | undefined;
  // `target` covers pointer-down-outside (the clicked element); `relatedTarget`
  // covers focus-outside (the element receiving focus when the card is clicked).
  const nodes = [orig?.target, orig?.relatedTarget];
  if (nodes.some((n) => n instanceof Element && n.closest(`[${CALENDAR_CARD_ATTR}]`))) {
    event.preventDefault();
  }
}
