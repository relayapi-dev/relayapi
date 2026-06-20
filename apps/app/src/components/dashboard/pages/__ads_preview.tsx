import { FilterProvider } from "@/components/dashboard/filter-context";
import { AdsPage } from "@/components/dashboard/pages/ads-page";

// TEMP preview wrapper for mobile-layout verification. Safe to delete.
export function AdsPreview({ tab }: { tab?: "ads" | "campaigns" | "audiences" | "accounts" }) {
  return (
    <FilterProvider>
      <AdsPage initialTab={tab} />
    </FilterProvider>
  );
}
