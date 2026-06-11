import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { fetchDashboardBootstrap } from "@/lib/dashboard-bootstrap";
import { scheduleAfterPaint, scheduleIdleTask } from "@/lib/idle";

export interface UsageData {
  plan: "free" | "pro";
  api_calls: { used: number; included: number };
  period_start?: string;
  period_end?: string;
}

interface UsageContextValue {
  usage: UsageData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const UsageContext = createContext<UsageContextValue>({
  usage: null,
  loading: true,
  error: null,
  refetch: () => {},
});

const USAGE_CACHE_PREFIX = "relayapi:usage:v1";
const USAGE_CACHE_TTL_MS = 60_000;

// Cache is scoped per active org so switching orgs never reads another org's
// usage. Returns null when there is no active org (skip caching entirely).
function usageCacheKey(orgId: string | null | undefined): string | null {
  return orgId ? `${USAGE_CACHE_PREFIX}:${orgId}` : null;
}

function readUsageCache(key: string | null): UsageData | null {
  if (!key || typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { timestamp: number; data: UsageData };
    if (!parsed?.timestamp || Date.now() - parsed.timestamp > USAGE_CACHE_TTL_MS) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeUsageCache(key: string | null, data: UsageData) {
  if (!key || typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ timestamp: Date.now(), data }),
    );
  } catch {
    // Ignore storage failures.
  }
}

export function UsageProvider({
  children,
  orgId,
}: {
  children: React.ReactNode;
  orgId?: string | null;
}) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);
  const cacheKey = usageCacheKey(orgId);

  const fetchUsage = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch("/api/usage", {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const data = await res.json();
        setUsage(data);
        writeUsageCache(cacheKey, data);
      } else {
        const err = await res.json().catch(() => null);
        if (!background) {
          setError(err?.error?.message || `Error ${res.status}`);
        }
      }
    } catch {
      if (!background) {
        setError("Network connection lost.");
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, [cacheKey]);

  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      const cached = readUsageCache(cacheKey);
      if (cached) {
        setUsage(cached);
        setLoading(false);
        // Warm-cache refresh via the shared dashboard bootstrap so the sidebar's
        // single bootstrap call serves usage too (org-keyed for cache reuse).
        return scheduleIdleTask(() => {
          void fetchDashboardBootstrap({ orgId }).then((data) => {
            if (data?.usage) {
              setUsage(data.usage);
              writeUsageCache(cacheKey, data.usage);
            }
          });
        }, 1500);
      }

      return scheduleAfterPaint(() => {
        void fetchDashboardBootstrap({ orgId }).then((data) => {
          if (data?.usage) {
            setUsage(data.usage);
            writeUsageCache(cacheKey, data.usage);
            setLoading(false);
          } else if (data) {
            // Bootstrap succeeded but usage is null — fall back to individual fetch
            void fetchUsage();
          } else {
            // Bootstrap failed entirely — fall back
            void fetchUsage();
          }
        });
      });
    }
  }, [fetchUsage, cacheKey]);

  return (
    <UsageContext.Provider value={{ usage, loading, error, refetch: fetchUsage }}>
      {children}
    </UsageContext.Provider>
  );
}

export function useUsage() {
  return useContext(UsageContext);
}
