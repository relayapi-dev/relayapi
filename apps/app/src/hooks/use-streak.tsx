import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { useRealtimeUpdates } from "./use-post-updates";

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

export function StreakProvider({ children }: { children: React.ReactNode }) {
  const [streak, setStreak] = useState<StreakData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchStreak = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/streak", { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const data = await res.json();
        setStreak(data);
      } else {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Error ${res.status}`);
      }
    } catch {
      setError("Network connection lost.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchStreak();
    }
  }, [fetchStreak]);

  // Listen for real-time streak events and refetch
  useRealtimeUpdates(
    useCallback(
      (event) => {
        if (
          event.type === "streak.updated" ||
          event.type === "streak.milestone" ||
          event.type === "streak.broken"
        ) {
          fetchStreak();
        }
      },
      [fetchStreak],
    ),
  );

  return (
    <StreakContext.Provider value={{ streak, loading, error, refetch: fetchStreak }}>
      {children}
    </StreakContext.Provider>
  );
}

export function useStreak() {
  return useContext(StreakContext);
}
