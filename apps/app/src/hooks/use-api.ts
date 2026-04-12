import { useState, useEffect, useCallback, useRef } from "react";

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  refetch: () => void;
}

export function useApi<T = unknown>(
  path: string | null,
  options?: { query?: Record<string, string | undefined> },
): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const fetchId = useRef(0);

  const fetchData = useCallback(async () => {
    if (!path) return;
    const id = ++fetchId.current;
    setLoading(true);
    setError(null);
    setErrorCode(null);

    try {
      const url = new URL(`/api/${path}`, window.location.origin);
      if (options?.query) {
        for (const [k, v] of Object.entries(options.query)) {
          if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
        }
      }

      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
      if (id !== fetchId.current) return; // stale

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        const code = err?.error?.code || null;
        setErrorCode(code);
        if (code === "FREE_LIMIT_REACHED") {
          setError("You\u2019ve reached your free plan limit. Upgrade to Pro to continue.");
        } else {
          setError(err?.error?.message || err?.message || `Error ${res.status}`);
        }
        setData(null);
      } else {
        const json = await res.json();
        setData(json as T);
      }
    } catch (err) {
      if (id !== fetchId.current) return;
      setError("Network connection lost.");
      setErrorCode("NETWORK_ERROR");
      setData(null);
    } finally {
      if (id === fetchId.current) setLoading(false);
    }
  }, [path, JSON.stringify(options?.query)]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, errorCode, refetch: fetchData };
}

interface UseMutationResult<T> {
  mutate: (body?: unknown) => Promise<T | null>;
  loading: boolean;
  error: string | null;
}

export function useMutation<T = unknown>(
  path: string,
  method: string = "POST",
): UseMutationResult<T> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (body?: unknown): Promise<T | null> => {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 204) {
          return null;
        }

        if (!res.ok) {
          const err = await res.json().catch(() => null);
          const msg = err?.error?.message || err?.message || `Error ${res.status}`;
          setError(msg);
          return null;
        }

        const json = await res.json();
        return json as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [path, method],
  );

  return { mutate, loading, error };
}

interface UsePagedApiResult<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  page: number;
  totalPages: number;
  goToPage: (page: number) => void;
}

export function usePagedApi<T = unknown>(
  path: string | null,
  options?: { query?: Record<string, string | undefined>; limit?: number },
): UsePagedApiResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const cursorsRef = useRef<(string | null)[]>([null]);
  const fetchId = useRef(0);
  const limit = options?.limit || 20;

  const fetchPage = useCallback(
    async (pageIndex: number) => {
      if (!path) return;
      const id = ++fetchId.current;
      setLoading(true);
      setError(null);

      try {
        const url = new URL(`/api/${path}`, window.location.origin);
        url.searchParams.set("limit", String(limit));
        const cursor = cursorsRef.current[pageIndex];
        if (cursor) url.searchParams.set("cursor", cursor);
        if (options?.query) {
          for (const [k, v] of Object.entries(options.query)) {
            if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
          }
        }

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
        if (id !== fetchId.current) return;

        if (!res.ok) {
          const err = await res.json().catch(() => null);
          setError(err?.error?.message || `Error ${res.status}`);
          return;
        }

        const json = await res.json();
        const items = (json.data || []) as T[];
        setData(items);
        setPage(pageIndex);

        if (typeof json.total === "number") {
          setTotalPages(Math.max(1, Math.ceil(json.total / limit)));
        }

        const nextCursor = json.next_cursor || null;
        if (json.has_more && nextCursor) {
          cursorsRef.current[pageIndex + 1] = nextCursor;
        }
      } catch {
        if (id !== fetchId.current) return;
        setError("Network connection lost.");
      } finally {
        if (id === fetchId.current) setLoading(false);
      }
    },
    [path, limit, JSON.stringify(options?.query)],
  );

  useEffect(() => {
    cursorsRef.current = [null];
    setPage(0);
    fetchPage(0);
  }, [fetchPage]);

  const goToPage = useCallback(
    (target: number) => {
      if (target >= 0 && target < totalPages && target !== page) {
        // Can only go to pages we have cursors for (sequential navigation)
        if (cursorsRef.current[target] !== undefined) {
          fetchPage(target);
        }
      }
    },
    [totalPages, page, fetchPage],
  );

  return { data, loading, error, page, totalPages, goToPage };
}

interface UsePaginatedApiResult<T> {
  data: T[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refetch: () => void;
  setData: React.Dispatch<React.SetStateAction<T[]>>;
}

export function usePaginatedApi<T = unknown>(
  path: string | null,
  options?: { query?: Record<string, string | undefined>; limit?: number },
): UsePaginatedApiResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(!!path);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const fetchId = useRef(0);
  const limit = options?.limit || 20;

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!path) return;
      const id = append ? fetchId.current : ++fetchId.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        const url = new URL(`/api/${path}`, window.location.origin);
        url.searchParams.set("limit", String(limit));
        if (cursor) url.searchParams.set("cursor", cursor);
        if (options?.query) {
          for (const [k, v] of Object.entries(options.query)) {
            if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
          }
        }

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
        if (!append && id !== fetchId.current) return;

        if (!res.ok) {
          const err = await res.json().catch(() => null);
          const code = err?.error?.code;
          if (code === "FREE_LIMIT_REACHED") {
            setError("You\u2019ve reached your free plan limit. Upgrade to Pro to continue.");
          } else {
            setError(err?.error?.message || err?.message || `Error ${res.status}`);
          }
          return;
        }

        const json = await res.json();
        const items = (json.data || []) as T[];
        setData((prev) => (append ? [...prev, ...items] : items));
        cursorRef.current = json.next_cursor || null;
        setHasMore(!!json.has_more);
      } catch {
        if (!append && id !== fetchId.current) return;
        setError("Network connection lost.");
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [path, limit, JSON.stringify(options?.query)],
  );

  useEffect(() => {
    cursorRef.current = null;
    fetchPage(null, false);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore && cursorRef.current) {
      fetchPage(cursorRef.current, true);
    }
  }, [loadingMore, hasMore, fetchPage]);

  const refetch = useCallback(() => {
    cursorRef.current = null;
    fetchPage(null, false);
  }, [fetchPage]);

  return { data, loading, loadingMore, error, hasMore, loadMore, refetch, setData };
}
