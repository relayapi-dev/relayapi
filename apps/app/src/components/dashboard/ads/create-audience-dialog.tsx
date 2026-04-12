import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMutation } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import { AdAccountCombobox } from "./ad-account-combobox";

interface AudienceItem {
  id: string;
  name: string;
}

interface CreateAudienceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingAudiences: AudienceItem[];
  onCreated: () => void;
}

type AudienceType = "customer_list" | "website" | "lookalike";

const inputClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function CreateAudienceDialog({
  open,
  onOpenChange,
  existingAudiences,
  onCreated,
}: CreateAudienceDialogProps) {
  const [type, setType] = useState<AudienceType>("customer_list");
  const [adAccountId, setAdAccountId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [customerFileSource, setCustomerFileSource] = useState("");
  const [pixelId, setPixelId] = useState("");
  const [retentionDays, setRetentionDays] = useState(30);
  const [rule, setRule] = useState("");
  const [sourceAudienceId, setSourceAudienceId] = useState("");
  const [country, setCountry] = useState("");
  const [ratio, setRatio] = useState(0.1);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation<{ id: string }>("ads/audiences", "POST");

  useEffect(() => {
    if (!open) {
      setType("customer_list");
      setAdAccountId("");
      setName("");
      setDescription("");
      setCustomerFileSource("");
      setPixelId("");
      setRetentionDays(30);
      setRule("");
      setSourceAudienceId("");
      setCountry("");
      setRatio(0.1);
      setError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    setError(null);
    if (!adAccountId || !name.trim()) {
      setError("Ad account and name are required.");
      return;
    }

    let body: Record<string, unknown> = {
      ad_account_id: adAccountId,
      type,
      name: name.trim(),
    };

    if (type === "customer_list") {
      if (description.trim()) body.description = description.trim();
      if (customerFileSource.trim()) body.customer_file_source = customerFileSource.trim();
    } else if (type === "website") {
      if (!pixelId.trim()) {
        setError("Pixel ID is required for website audiences.");
        return;
      }
      if (description.trim()) body.description = description.trim();
      body.pixel_id = pixelId.trim();
      body.retention_days = retentionDays;
      if (rule.trim()) body.rule = rule.trim();
    } else {
      if (!sourceAudienceId) {
        setError("Source audience is required for lookalike audiences.");
        return;
      }
      if (!country.trim() || country.trim().length !== 2) {
        setError("Country must be a 2-character code.");
        return;
      }
      body.source_audience_id = sourceAudienceId;
      body.country = country.trim().toUpperCase();
      body.ratio = ratio;
    }

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
          <DialogTitle className="text-base">Create Audience</DialogTitle>
          <DialogDescription className="text-xs">
            Define a custom audience for ad targeting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Type selector */}
          <div className="flex gap-1">
            {(["customer_list", "website", "lookalike"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cn(
                  "px-3 py-1.5 text-xs rounded-md transition-colors",
                  type === t
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t === "customer_list" ? "Customer List" : t === "website" ? "Website" : "Lookalike"}
              </button>
            ))}
          </div>

          {/* Ad Account */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Ad Account</label>
            <div className="mt-1">
              <AdAccountCombobox value={adAccountId} onSelect={setAdAccountId} />
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <input type="text" placeholder="Audience name" value={name} onChange={(e) => setName(e.target.value)} className={cn(inputClass, "mt-1")} />
          </div>

          {/* Customer List fields */}
          {type === "customer_list" && (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <input type="text" placeholder="Optional description" value={description} onChange={(e) => setDescription(e.target.value)} className={cn(inputClass, "mt-1")} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Customer File Source</label>
                <input type="text" placeholder="Optional source" value={customerFileSource} onChange={(e) => setCustomerFileSource(e.target.value)} className={cn(inputClass, "mt-1")} />
              </div>
            </>
          )}

          {/* Website fields */}
          {type === "website" && (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <input type="text" placeholder="Optional description" value={description} onChange={(e) => setDescription(e.target.value)} className={cn(inputClass, "mt-1")} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Pixel ID *</label>
                <input type="text" placeholder="Pixel ID" value={pixelId} onChange={(e) => setPixelId(e.target.value)} className={cn(inputClass, "mt-1")} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Retention Days</label>
                <input type="number" min={1} max={180} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} className={cn(inputClass, "mt-1")} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Rule</label>
                <input type="text" placeholder="Optional rule" value={rule} onChange={(e) => setRule(e.target.value)} className={cn(inputClass, "mt-1")} />
              </div>
            </>
          )}

          {/* Lookalike fields */}
          {type === "lookalike" && (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Source Audience</label>
                <select value={sourceAudienceId} onChange={(e) => setSourceAudienceId(e.target.value)} className={cn(inputClass, "mt-1")}>
                  <option value="">Select source audience</option>
                  {existingAudiences.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Country (2-char code)</label>
                <input type="text" maxLength={2} placeholder="US" value={country} onChange={(e) => setCountry(e.target.value)} className={cn(inputClass, "mt-1")} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Ratio</label>
                <input type="number" min={0.01} max={0.2} step={0.01} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} className={cn(inputClass, "mt-1")} />
              </div>
            </>
          )}

          {/* Error */}
          {(error || createMutation.error) && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error || createMutation.error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={createMutation.loading}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSubmit} disabled={createMutation.loading || !adAccountId || !name.trim()}>
            {createMutation.loading ? <Loader2 className="size-3.5 animate-spin" /> : "Create Audience"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
