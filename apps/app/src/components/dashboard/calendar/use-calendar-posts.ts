import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek } from "date-fns";

/** Get yyyy-MM-dd for a date in a specific timezone */
function dateKeyInTz(date: Date, tz: string): string {
  return date.toLocaleDateString("en-CA", { timeZone: tz });
}

/** Get hour (0-23) for a date in a specific timezone */
function hourInTz(date: Date, tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(date),
  );
}

export interface CalendarPost {
  id: string;
  /** Original post ID (same for all per-platform splits of the same post) */
  postId: string;
  content: string;
  /** Single platform for this card (each card = one platform, like Buffer) */
  platform: string;
  /** All platforms on the original post (for reference) */
  platforms: string[];
  status: "scheduled" | "published" | "draft" | "failed" | "publishing" | "partial";
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  media?: Array<{ url: string; type?: string }> | null;
  /** External posts from synced platforms — can't be edited/fetched via /api/posts/{id} */
  isExternal?: boolean;
  platformUrl?: string | null;
  accountName?: string | null;
  accountAvatarUrl?: string | null;
  metrics?: Record<string, number> | null;
}

interface UseCalendarPostsResult {
  postsByDate: Map<string, CalendarPost[]>;
  postsByHour: Map<string, CalendarPost[]>;
  drafts: CalendarPost[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  silentRefetch: () => void;
  optimisticMove: (postId: string, target: string) => Promise<boolean>;
  truncated: boolean;
}

export function useCalendarPosts(
  currentDate: Date,
  filterQuery: Record<string, string | undefined>,
  statusFilter?: string,
  period: "week" | "month" = "month",
  timezone?: string,
): UseCalendarPostsResult {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [posts, setPosts] = useState<CalendarPost[]>([]);
  const [drafts, setDrafts] = useState<CalendarPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const fetchId = useRef(0);

  const from = period === "week"
    ? startOfWeek(currentDate, { weekStartsOn: 1 }).toISOString()
    : startOfMonth(currentDate).toISOString();
  const to = period === "week"
    ? endOfWeek(currentDate, { weekStartsOn: 1 }).toISOString()
    : endOfMonth(currentDate).toISOString();

  const fetchPosts = useCallback(async (silent = false) => {
    const id = ++fetchId.current;
    if (!silent) setLoading(true);
    setError(null);
    setTruncated(false);

    try {
      let allPosts: CalendarPost[] = [];
      let cursor: string | null = null;
      let pages = 0;
      const MAX_PAGES = 10; // safety valve: 10 * 100 = 1000 posts max

      do {
        const url = new URL("/api/posts", window.location.origin);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);
        url.searchParams.set("from", from);
        url.searchParams.set("to", to);
        url.searchParams.set("include", "media");
        if (statusFilter && statusFilter !== "All") {
          url.searchParams.set("status", statusFilter.toLowerCase());
        }
        for (const [k, v] of Object.entries(filterQuery)) {
          if (v) url.searchParams.set(k, v);
        }

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
        if (id !== fetchId.current) return;

        if (!res.ok) {
          const err = await res.json().catch(() => null);
          setError(err?.error?.message || `Error ${res.status}`);
          return;
        }

        const json = await res.json();
        // Split each post into per-platform cards (like Buffer)
        for (const raw of (json.data || []) as any[]) {
          if (raw.source === "external") {
            // External post — single platform, can't be edited
            allPosts.push({
              id: raw.id,
              postId: raw.id,
              content: raw.content || "",
              platform: raw.platform || "",
              platforms: [raw.platform].filter(Boolean),
              status: "published",
              scheduled_at: null,
              published_at: raw.published_at || null,
              created_at: raw.created_at || raw.published_at || "",
              media: raw.thumbnail_url ? [{ url: raw.thumbnail_url, type: raw.media_type === "video" ? "video/mp4" : "image/jpeg" }] : (raw.media_urls?.length ? raw.media_urls.map((u: string) => ({ url: u })) : null),
              isExternal: true,
              platformUrl: raw.platform_url || null,
              accountName: raw.account_name || null,
              accountAvatarUrl: raw.account_avatar_url || null,
              metrics: raw.metrics || null,
            });
          } else {
            // Internal post — split into one card per platform
            const platforms: string[] = raw.platforms || [];
            if (platforms.length <= 1) {
              allPosts.push({
                id: raw.id,
                postId: raw.id,
                content: raw.content || "",
                platform: platforms[0] || "",
                platforms,
                status: raw.status || "draft",
                scheduled_at: raw.scheduled_at || null,
                published_at: raw.published_at || null,
                created_at: raw.created_at || "",
                media: raw.media || null,
              });
            } else {
              for (const p of platforms) {
                allPosts.push({
                  id: `${raw.id}__${p}`,
                  postId: raw.id,
                  content: raw.content || "",
                  platform: p,
                  platforms,
                  status: raw.status || "draft",
                  scheduled_at: raw.scheduled_at || null,
                  published_at: raw.published_at || null,
                  created_at: raw.created_at || "",
                  media: raw.media || null,
                });
              }
            }
          }
        }
        cursor = json.next_cursor || null;
        pages++;
      } while (cursor && pages < MAX_PAGES);

      setPosts(allPosts);
      setTruncated(cursor !== null);
    } catch {
      if (id !== fetchId.current) return;
      setError("Network connection lost.");
    } finally {
      if (id === fetchId.current) setLoading(false);
    }
  }, [from, to, statusFilter, JSON.stringify(filterQuery)]);

  // Fetch drafts separately (no date range)
  const fetchDrafts = useCallback(async () => {
    try {
      let allDrafts: CalendarPost[] = [];
      let cursor: string | null = null;
      let pages = 0;
      const MAX_PAGES = 3;

      do {
        const url = new URL("/api/posts", window.location.origin);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);
        url.searchParams.set("status", "draft");
        url.searchParams.set("include", "media");
        for (const [k, v] of Object.entries(filterQuery)) {
          if (v) url.searchParams.set(k, v);
        }

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return;

        const json = await res.json();
        for (const raw of (json.data || []) as any[]) {
          allDrafts.push({
            id: raw.id,
            postId: raw.id,
            content: raw.content || "",
            platform: raw.platforms?.[0] || "",
            platforms: raw.platforms || [],
            status: raw.status || "draft",
            scheduled_at: raw.scheduled_at || null,
            published_at: raw.published_at || null,
            created_at: raw.created_at || "",
            media: raw.media || null,
          });
        }
        cursor = json.next_cursor || null;
        pages++;
      } while (cursor && pages < MAX_PAGES);

      setDrafts(allDrafts.filter((d) => !d.scheduled_at));
    } catch {
      // Silently fail — drafts are supplementary
    }
  }, [JSON.stringify(filterQuery)]);

  useEffect(() => {
    fetchPosts();
    fetchDrafts();
  }, [fetchPosts, fetchDrafts]);

  // Group posts by date (timezone-aware)
  const postsByDate = useMemo(() => {
    const map = new Map<string, CalendarPost[]>();
    for (const post of posts) {
      const dateStr = post.scheduled_at || post.published_at;
      if (!dateStr) continue;
      const key = dateKeyInTz(new Date(dateStr), tz);
      const list = map.get(key) ?? [];
      list.push(post);
      map.set(key, list);
    }
    return map;
  }, [posts, tz]);

  // Group posts by hour (timezone-aware, for week view), sorted by time within each hour
  const postsByHour = useMemo(() => {
    const map = new Map<string, CalendarPost[]>();
    for (const post of posts) {
      const dateStr = post.scheduled_at || post.published_at;
      if (!dateStr) continue;
      const d = new Date(dateStr);
      const key = `${dateKeyInTz(d, tz)}T${String(hourInTz(d, tz)).padStart(2, "0")}`;
      const list = map.get(key) ?? [];
      list.push(post);
      map.set(key, list);
    }
    // Sort each bucket by time ascending
    for (const list of map.values()) {
      list.sort((a, b) => {
        const tA = new Date(a.scheduled_at || a.published_at || a.created_at).getTime();
        const tB = new Date(b.scheduled_at || b.published_at || b.created_at).getTime();
        return tA - tB;
      });
    }
    return map;
  }, [posts, tz]);

  const optimisticMove = useCallback(
    async (postId: string, target: string): Promise<boolean> => {
      // Find the post in current data (postId here is the dnd-kit id, which may be a split ID)
      const post = posts.find((p) => p.id === postId) || drafts.find((d) => d.id === postId);
      if (!post || post.isExternal) return false;
      const realPostId = post.postId; // Original post ID for API call

      let newScheduledAt: string;

      if (target.includes("T")) {
        // Week view: target is "yyyy-MM-ddTHH:mm" — use the exact datetime
        newScheduledAt = `${target}:00`;
      } else {
        // Month view: target is "yyyy-MM-dd" — preserve original time or default to 09:00
        const originalDate = post.scheduled_at ? new Date(post.scheduled_at) : null;
        const hours = originalDate ? String(originalDate.getHours()).padStart(2, "0") : "09";
        const minutes = originalDate ? String(originalDate.getMinutes()).padStart(2, "0") : "00";
        const seconds = originalDate ? String(originalDate.getSeconds()).padStart(2, "0") : "00";
        newScheduledAt = `${target}T${hours}:${minutes}:${seconds}`;
      }

      const prevPosts = [...posts];
      const prevDrafts = [...drafts];

      // Optimistic update — move ALL split cards of the same original post
      const newIso = new Date(newScheduledAt).toISOString();

      // Remove from drafts if it was a draft
      if (!post.scheduled_at) {
        setDrafts((prev) => prev.filter((d) => d.postId !== realPostId));
      }

      setPosts((prev) =>
        prev.map((p) =>
          p.postId === realPostId
            ? { ...p, scheduled_at: newIso, status: "scheduled" as const }
            : p,
        ),
      );

      try {
        const res = await fetch(`/api/posts/${realPostId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduled_at: new Date(newScheduledAt).toISOString() }),
        });

        if (!res.ok) {
          // Rollback
          setPosts(prevPosts);
          setDrafts(prevDrafts);
          return false;
        }
        return true;
      } catch {
        // Rollback
        setPosts(prevPosts);
        setDrafts(prevDrafts);
        return false;
      }
    },
    [posts, drafts],
  );

  const refetch = useCallback(() => {
    fetchPosts();
    fetchDrafts();
  }, [fetchPosts, fetchDrafts]);

  /** Background refetch — no loading spinner */
  const silentRefetch = useCallback(() => {
    fetchPosts(true);
    fetchDrafts();
  }, [fetchPosts, fetchDrafts]);

  return { postsByDate, postsByHour, drafts, loading, error, refetch, silentRefetch, optimisticMove, truncated };
}
