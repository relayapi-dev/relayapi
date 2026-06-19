import { useFilter } from "./filter-context";
import { WorkspaceSearchCombobox } from "./workspace-search-combobox";

/**
 * Icon-button workspace filter for page toolbars. Drives the shared Filter
 * context and reuses the workspace combobox dropdown. Reference: Posts.jsx
 * FolderOpen "All workspaces" toolbar button.
 */
export function WorkspaceFilterButton({
  align = "right",
}: {
  align?: "left" | "right";
}) {
  const { workspaceId, setWorkspaceId } = useFilter();
  return (
    <WorkspaceSearchCombobox
      value={workspaceId}
      onSelect={(id) => setWorkspaceId(id)}
      variant="icon"
      showAllOption
      showUnassignedOption
      align={align}
      placeholder="All workspaces"
    />
  );
}
