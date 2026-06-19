import { useFilter } from "./filter-context";
import { AccountSearchCombobox } from "./account-search-combobox";

/**
 * Icon-button account filter for page toolbars. Scoped to the currently
 * selected workspace. Reference: Posts.jsx User "All accounts" toolbar button.
 */
export function AccountFilterButton({ platforms }: { platforms?: string[] }) {
  const { workspaceId, accountId, setAccountId } = useFilter();
  return (
    <AccountSearchCombobox
      value={accountId}
      onSelect={(id) => setAccountId(id)}
      workspaceId={workspaceId}
      platforms={platforms}
      variant="icon"
      placeholder="All accounts"
    />
  );
}
