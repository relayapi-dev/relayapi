import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { fetchDashboardBootstrap } from "@/lib/dashboard-bootstrap";
import { scheduleAfterPaint, scheduleIdleTask } from "@/lib/idle";

export interface StreakData {
  active: boolean;
  current_streak_days: number;
  streak_started_at: string | null;
  last_post_at: string | null;
  best_streak_days: number;
  total_streaks_broken: number;
  hours_remaining: number | null;
}

interface StreakContextValue {
  streak: StreakData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const StreakContext = createContext<StreakContextValue>({
  streak: null,
  loading: true,
  error: null,
  refetch: () => {},
});

const STREAK_CACHE_KEY = "relayapi:streak:v1";
const STREAK_CACHE_TTL_MS = 60_000;

function readStreakCache(): StreakData | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(STREAK_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { timestamp: number; data: StreakData };
    if (!parsed?.timestamp || Date.now() - parsed.timestamp > STREAK_CACHE_TTL_MS) {
      window.sessionStorage.removeItem(STREAK_CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeStreakCache(data: StreakData) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      STREAK_CACHE_KEY,
      JSON.stringify({ timestamp: Date.now(), data }),
    );
  } catch {
    // Ignore storage failures.
  }
}

export function StreakProvider({ children }: { children: React.ReactNode }) {
  const [streak, setStreak] = useState<StreakData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchStreak = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch("/api/streak", {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const data = await res.json();
        setStreak(data);
        writeStreakCache(data);
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
      const cached = readStreakCache();
      if (cached) {
        setStreak(cached);
        setLoading(false);
        return scheduleIdleTask(() => {
          void fetchStreak({ background: true });
        }, 2000);
      }

      return scheduleAfterPaint(() => {
        void fetchDashboardBootstrap().then((data) => {
          if (data?.streak) {
            setStreak(data.streak);
            writeStreakCache(data.streak);
            setLoading(false);
          } else {
            void fetchStreak();
          }
        });
      }, 250);
    }
  }, [fetchStreak]);

  return (
    <StreakContext.Provider value={{ streak, loading, error, refetch: fetchStreak }}>
      {children}
    </StreakContext.Provider>
  );
}

export function useStreak() {
  return useContext(StreakContext);
}
