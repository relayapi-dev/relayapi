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
