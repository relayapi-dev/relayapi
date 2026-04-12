import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";

interface UsageData {
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

export function UsageProvider({ children }: { children: React.ReactNode }) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/usage", { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const data = await res.json();
        setUsage(data);
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
      fetchUsage();
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
