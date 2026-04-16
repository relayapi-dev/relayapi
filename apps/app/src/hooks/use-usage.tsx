import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { fetchDashboardBootstrap } from "@/lib/dashboard-bootstrap";
import { dashboardPerfFetch } from "@/lib/dashboard-perf";
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

const USAGE_CACHE_KEY = "relayapi:usage:v1";
const USAGE_CACHE_TTL_MS = 60_000;

function readUsageCache(): UsageData | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(USAGE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { timestamp: number; data: UsageData };
    if (!parsed?.timestamp || Date.now() - parsed.timestamp > USAGE_CACHE_TTL_MS) {
      window.sessionStorage.removeItem(USAGE_CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeUsageCache(data: UsageData) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      USAGE_CACHE_KEY,
      JSON.stringify({ timestamp: Date.now(), data }),
    );
  } catch {
    // Ignore storage failures.
  }
}

export function UsageProvider({ children }: { children: React.ReactNode }) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchUsage = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await dashboardPerfFetch(
        "/api/usage",
        { signal: AbortSignal.timeout(15_000) },
        {
          hook: "useUsage",
          background,
        },
      );
      if (res.ok) {
        const data = await res.json();
        setUsage(data);
        writeUsageCache(data);
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
  }, []);

  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      const cached = readUsageCache();
      if (cached) {
        setUsage(cached);
        setLoading(false);
        return scheduleIdleTask(() => {
          void fetchUsage({ background: true });
        }, 1500);
      }

      return scheduleAfterPaint(() => {
        void fetchDashboardBootstrap().then((data) => {
          if (data?.usage) {
            setUsage(data.usage);
            writeUsageCache(data.usage);
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
  }, [fetchUsage]);

  return (
    <UsageContext.Provider value={{ usage, loading, error, refetch: fetchUsage }}>
      {children}
    </UsageContext.Provider>
  );
}

export function useUsage() {
  return useContext(UsageContext);
}
