import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useFilter } from "./filter-context";
import { WorkspaceSearchCombobox } from "./workspace-search-combobox";

interface WorkspaceGuardProps {
  children: React.ReactNode;
  /** Number of workspaces above which workspace selection is required. Default: 20 */
  threshold?: number;
}

/**
 * Guards data-heavy pages for large organizations.
 * If the org has more workspaces than the threshold and none is selected,
 * shows a prompt to select one instead of rendering the page content.
 */
export function WorkspaceGuard({ children, threshold = 20 }: WorkspaceGuardProps) {
  const { workspaceId, setWorkspaceId } = useFilter();
  const [exceedsThreshold, setExceedsThreshold] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (workspaceId) return; // Already selected, skip check

    let cancelled = false;
    const url = new URL("/api/workspaces", window.location.origin);
    url.searchParams.set("limit", String(threshold + 1));

    fetch(url.toString(), { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) {
          setExceedsThreshold((json.data?.length ?? 0) > threshold);
        }
      })
      .catch(() => {
        if (!cancelled) setExceedsThreshold(false);
      });

    return () => { cancelled = true; };
  }, [workspaceId, threshold]);

  // Workspace is selected — render content
  if (workspaceId) return <>{children}</>;

  // Still checking — render content (don't flash)
  if (exceedsThreshold === null) return <>{children}</>;

  // Small org — render content
  if (!exceedsThreshold) return <>{children}</>;

  // Large org, guard dismissed — render content
  if (dismissed) return <>{children}</>;

  // Large org, no workspace selected — show prompt
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      <FolderOpen className="size-10 text-muted-foreground/40 mb-4" />
      <h3 className="text-sm font-medium mb-1">Select a workspace</h3>
      <p className="text-xs text-muted-foreground max-w-sm mb-5">
        Your organization has many workspaces. Select one to load this view.
      </p>
      <WorkspaceSearchCombobox
        value={null}
        onSelect={setWorkspaceId}
        placeholder="Choose a workspace..."
        className="w-64"
      />
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="mt-4 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        Show all anyway
      </button>
    </div>
  );
}
