import { useFilter } from "./filter-context";
import { WorkspaceSearchCombobox } from "./workspace-search-combobox";
import { AccountSearchCombobox } from "./account-search-combobox";

export function FilterBar() {
  const { workspaceId, accountId, setWorkspaceId, setAccountId } = useFilter();

  return (
    <div className="flex items-center gap-1 shrink-0">
      <WorkspaceSearchCombobox
        value={workspaceId}
        onSelect={setWorkspaceId}
        showAllOption
        showUnassignedOption
        placeholder="All workspaces"
        className="flex-1 sm:flex-none sm:w-auto"
      />
      <AccountSearchCombobox
        value={accountId}
        onSelect={setAccountId}
        workspaceId={workspaceId}
        placeholder="All accounts"
        className="flex-1 sm:flex-none sm:w-auto"
      />
    </div>
  );
}
