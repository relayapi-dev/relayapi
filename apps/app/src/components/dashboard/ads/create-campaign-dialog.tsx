import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useMutation } from "@/hooks/use-api";
import { AdAccountCombobox } from "./ad-account-combobox";

interface AdAccount {
  id: string;
  platform: string;
  name: string | null;
  currency: string | null;
}

interface CreateCampaignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adAccounts: AdAccount[];
  onCreated: () => void;
}

const OBJECTIVES = [
  { value: "awareness", label: "Awareness" },
  { value: "traffic", label: "Traffic" },
  { value: "engagement", label: "Engagement" },
  { value: "leads", label: "Leads" },
  { value: "conversions", label: "Conversions" },
  { value: "video_views", label: "Video Views" },
] as const;

const inputClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function CreateCampaignDialog({ open, onOpenChange, adAccounts, onCreated }: CreateCampaignDialogProps) {
  const [adAccountId, setAdAccountId] = useState("");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("awareness");
  const [dailyBudget, setDailyBudget] = useState("");
  const [lifetimeBudget, setLifetimeBudget] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation<{ id: string }>("ads/campaigns", "POST");

  useEffect(() => {
    if (!open) {
      setAdAccountId("");
      setName("");
      setObjective("awareness");
      setDailyBudget("");
      setLifetimeBudget("");
      setCurrency("USD");
      setStartDate("");
      setEndDate("");
      setError(null);
    }
  }, [open]);

  // Auto-fill currency when ad account is selected
  useEffect(() => {
    const account = adAccounts.find((a) => a.id === adAccountId);
    if (account?.currency) setCurrency(account.currency);
  }, [adAccountId, adAccounts]);

  const dollarsToCents = (value: string): number | undefined => {
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed) || parsed < 0) return undefined;
    return Math.round(parsed * 100);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!adAccountId || !name.trim()) {
      setError("Ad account and campaign name are required.");
      return;
    }

    const body: Record<string, unknown> = {
      ad_account_id: adAccountId,
      name: name.trim(),
      objective,
      currency,
    };

    if (dailyBudget) {
      const cents = dollarsToCents(dailyBudget);
      if (cents === undefined) { setError("Invalid daily budget."); return; }
      body.daily_budget_cents = cents;
    }
    if (lifetimeBudget) {
      const cents = dollarsToCents(lifetimeBudget);
      if (cents === undefined) { setError("Invalid lifetime budget."); return; }
      body.lifetime_budget_cents = cents;
    }
    if (startDate) body.start_date = startDate;
    if (endDate) body.end_date = endDate;

    const result = await createMutation.mutate(body);
    if (result) {
      onCreated();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Create Campaign</DialogTitle>
          <DialogDescription className="text-xs">
            Set up a new ad campaign across your connected ad accounts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Ad Account */}
          <div>
            <label htmlFor="campaign-account" className="text-xs font-medium text-muted-foreground">Ad Account</label>
            <div className="mt-1">
              <AdAccountCombobox value={adAccountId} onSelect={setAdAccountId} />
            </div>
          </div>

          {/* Name */}
          <div>
            <label htmlFor="campaign-name" className="text-xs font-medium text-muted-foreground">Campaign Name</label>
            <input id="campaign-name" type="text" placeholder="e.g. Spring Sale 2026" value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 ${inputClass}`} />
          </div>

          {/* Objective */}
          <div>
            <label htmlFor="campaign-objective" className="text-xs font-medium text-muted-foreground">Objective</label>
            <select id="campaign-objective" value={objective} onChange={(e) => setObjective(e.target.value)} className={`mt-1 ${inputClass}`}>
              {OBJECTIVES.map((obj) => (
                <option key={obj.value} value={obj.value}>{obj.label}</option>
              ))}
            </select>
          </div>

          {/* Budgets */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="campaign-daily-budget" className="text-xs font-medium text-muted-foreground">Daily Budget ($)</label>
              <input id="campaign-daily-budget" type="number" min="0" step="0.01" placeholder="50.00" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} className={`mt-1 ${inputClass}`} />
            </div>
            <div>
              <label htmlFor="campaign-lifetime-budget" className="text-xs font-medium text-muted-foreground">Lifetime Budget ($)</label>
              <input id="campaign-lifetime-budget" type="number" min="0" step="0.01" placeholder="500.00" value={lifetimeBudget} onChange={(e) => setLifetimeBudget(e.target.value)} className={`mt-1 ${inputClass}`} />
            </div>
          </div>

          {/* Currency */}
          <div>
            <label htmlFor="campaign-currency" className="text-xs font-medium text-muted-foreground">Currency</label>
            <input id="campaign-currency" type="text" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className={`mt-1 ${inputClass}`} />
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="campaign-start" className="text-xs font-medium text-muted-foreground">Start Date</label>
              <input id="campaign-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`mt-1 ${inputClass}`} />
            </div>
            <div>
              <label htmlFor="campaign-end" className="text-xs font-medium text-muted-foreground">End Date</label>
              <input id="campaign-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={`mt-1 ${inputClass}`} />
            </div>
          </div>

          {/* Error */}
          {(error || createMutation.error) && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error || createMutation.error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={createMutation.loading}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSubmit} disabled={createMutation.loading || !adAccountId || !name.trim()}>
            {createMutation.loading ? <Loader2 className="size-3.5 animate-spin" /> : "Create Campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
