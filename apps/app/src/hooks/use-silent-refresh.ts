import { useCallback, useRef } from "react";

/**
 * Silently fetches the first page of a paginated API endpoint and merges
 * new/updated items into existing state — without setting any loading state.
 *
 * Used as a replacement for `refetch()` on WebSocket events and polling,
 * so the UI doesn't flash a spinner on every update.
 */
export function useSilentRefresh<T>(opts: {
  path: string | null;
  query?: Record<string, string | undefined>;
  setData: React.Dispatch<React.SetStateAction<T[]>>;
  getId: (item: T) => string;
  limit?: number;
}): { silentRefresh: () => void } {
  const { path, query, setData, getId, limit = 20 } = opts;
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);

  const doFetch = useCallback(async () => {
    if (!path) return;
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;

    try {
      const url = new URL(`/api/${path}`, window.location.origin);
      url.searchParams.set("limit", String(limit));
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
        }
      }

      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;

      const json = await res.json();
      const freshItems = (json.data || []) as T[];

      setData((prev) => {
        const existingMap = new Map<string, { item: T; index: number }>();
        for (let i = 0; i < prev.length; i++) {
          const item = prev[i]!;
          existingMap.set(getId(item), { item, index: i });
        }

        const newItems: T[] = [];
        const updatedIds = new Set<string>();

        for (const item of freshItems) {
          const id = getId(item);
          const existing = existingMap.get(id);
          if (existing) {
            // Update existing item in-place
            existingMap.set(id, { item, index: existing.index });
            updatedIds.add(id);
          } else {
            newItems.push(item);
          }
        }

        // Rebuild existing list with updates applied
        const updatedPrev = prev.map((item) => {
          const id = getId(item);
          if (updatedIds.has(id)) {
            return existingMap.get(id)!.item;
          }
          return item;
        });

        if (newItems.length === 0 && updatedIds.size === 0) return prev;
        if (newItems.length === 0) return updatedPrev;
        return [...newItems, ...updatedPrev];
      });
    } catch {
      // Silent — don't surface errors for background refreshes
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        doFetch();
      }
    }
  }, [path, limit, JSON.stringify(query), setData, getId]);

  return { silentRefresh: doFetch };
}
