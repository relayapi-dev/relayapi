import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

interface FilterState {
  workspaceId: string | null;
  accountId: string | null;
  setWorkspaceId: (id: string | null) => void;
  setAccountId: (id: string | null) => void;
}

const FilterContext = createContext<FilterState>({
  workspaceId: null,
  accountId: null,
  setWorkspaceId: () => {},
  setAccountId: () => {},
});

export function useFilter() {
  return useContext(FilterContext);
}

/** Returns query params to pass to usePaginatedApi based on current filter */
export function useFilterQuery(): Record<string, string | undefined> {
  const { workspaceId, accountId } = useFilter();
  const query: Record<string, string | undefined> = {};
  if (accountId) {
    query.account_id = accountId;
  } else if (workspaceId) {
    query.workspace_id = workspaceId;
  }
  return query;
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("workspace") || null;
  });

  const [accountId, setAccountIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("account") || null;
  });

  // Sync to URL params
  const syncUrl = useCallback((wId: string | null, aId: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (wId) url.searchParams.set("workspace", wId);
    else url.searchParams.delete("workspace");
    if (aId) url.searchParams.set("account", aId);
    else url.searchParams.delete("account");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const setWorkspaceId = useCallback((id: string | null) => {
    setWorkspaceIdState(id);
    setAccountIdState(null); // reset account when workspace changes
    syncUrl(id, null);
  }, [syncUrl]);

  const setAccountId = useCallback((id: string | null) => {
    setAccountIdState(id);
    syncUrl(workspaceId, id);
  }, [workspaceId, syncUrl]);

  return (
    <FilterContext.Provider value={{ workspaceId, accountId, setWorkspaceId, setAccountId }}>
      {children}
    </FilterContext.Provider>
  );
}
