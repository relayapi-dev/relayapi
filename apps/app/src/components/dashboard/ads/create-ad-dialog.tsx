import { useState, useEffect, useRef } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AdAccountCombobox } from "./ad-account-combobox";

interface AdAccount {
  id: string;
  social_account_id: string;
  platform: string;
  name: string | null;
  currency: string | null;
}

interface CreateAdDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adAccounts: AdAccount[];
  onCreated: () => void;
  boostMode?: boolean;
}

const objectives = ["awareness", "traffic", "engagement", "leads", "conversions", "video_views"] as const;
const ctaOptions = ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BOOK_NOW", "CONTACT_US", "APPLY_NOW", "SUBSCRIBE", "DOWNLOAD"] as const;

const inputClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function CreateAdDialog({ open, onOpenChange, adAccounts, onCreated, boostMode = false }: CreateAdDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [adAccountId, setAdAccountId] = useState("");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState<string>("engagement");
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [callToAction, setCallToAction] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [dailyBudget, setDailyBudget] = useState("");
  const [lifetimeBudget, setLifetimeBudget] = useState("");
  const [durationDays, setDurationDays] = useState("7");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // Boost-specific
  const [postTargetId, setPostTargetId] = useState("");

  // Targeting
  const [ageMin, setAgeMin] = useState("18");
  const [ageMax, setAgeMax] = useState("65");
  const [genders, setGenders] = useState<string[]>([]);
  const [interestQuery, setInterestQuery] = useState("");
  const [interests, setInterests] = useState<{ id: string; name: string }[]>([]);
  const [interestResults, setInterestResults] = useState<{ id: string; name: string; audience_size?: number }[]>([]);
  const [searchingInterests, setSearchingInterests] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Set default ad account
  useEffect(() => {
    if (adAccounts.length > 0 && !adAccountId) {
      setAdAccountId(adAccounts[0]!.id);
    }
  }, [adAccounts, adAccountId]);

  // Interest autocomplete
  useEffect(() => {
    if (!interestQuery || interestQuery.length < 2) {
      setInterestResults([]);
      return;
    }
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    const selectedAccount = adAccounts.find((a) => a.id === adAccountId);
    if (!selectedAccount) return;

    searchTimeout.current = setTimeout(async () => {
      setSearchingInterests(true);
      try {
        const res = await fetch(`/api/ads/interests?q=${encodeURIComponent(interestQuery)}&social_account_id=${selectedAccount.social_account_id}`);
        if (res.ok) {
          const data = await res.json();
          setInterestResults(data.data ?? data ?? []);
        }
      } catch { /* ignore */ }
      setSearchingInterests(false);
    }, 400);

    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [interestQuery, adAccountId, adAccounts]);

  const resetForm = () => {
    setName(""); setObjective("engagement"); setHeadline(""); setBody("");
    setCallToAction(""); setLinkUrl(""); setImageUrl(""); setVideoUrl("");
    setDailyBudget(""); setLifetimeBudget(""); setDurationDays("7");
    setStartDate(""); setEndDate(""); setPostTargetId("");
    setAgeMin("18"); setAgeMax("65"); setGenders([]);
    setInterestQuery(""); setInterests([]); setInterestResults([]);
    setError(null);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);

    const targeting: Record<string, unknown> = {};
    if (ageMin !== "18") targeting.age_min = Number(ageMin);
    if (ageMax !== "65") targeting.age_max = Number(ageMax);
    if (genders.length > 0) targeting.genders = genders;
    if (interests.length > 0) targeting.interests = interests;

    try {
      const endpoint = boostMode ? "/api/ads/boost" : "/api/ads";
      const payload: Record<string, unknown> = {
        ad_account_id: adAccountId,
        name: name || (boostMode ? "Boost" : "New Ad"),
        objective,
        ...(Object.keys(targeting).length > 0 ? { targeting } : {}),
      };

      if (boostMode) {
        payload.post_target_id = postTargetId;
        payload.daily_budget_cents = Math.round(Number(dailyBudget) * 100);
        payload.duration_days = Number(durationDays);
      } else {
        if (headline) payload.headline = headline;
        if (body) payload.body = body;
        if (callToAction) payload.call_to_action = callToAction;
        if (linkUrl) payload.link_url = linkUrl;
        if (imageUrl) payload.image_url = imageUrl;
        if (videoUrl) payload.video_url = videoUrl;
        if (dailyBudget) payload.daily_budget_cents = Math.round(Number(dailyBudget) * 100);
        if (lifetimeBudget) payload.lifetime_budget_cents = Math.round(Number(lifetimeBudget) * 100);
        if (durationDays) payload.duration_days = Number(durationDays);
        if (startDate) payload.start_date = new Date(startDate).toISOString();
        if (endDate) payload.end_date = new Date(endDate).toISOString();
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || "Failed to create ad");
      }

      resetForm();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create ad");
    } finally {
      setLoading(false);
    }
  };

  const toggleGender = (g: string) => {
    setGenders((prev) => prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg max-h-[85vh] grid-rows-[auto_1fr] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{boostMode ? "Boost Post" : "Create Ad"}</DialogTitle>
          <DialogDescription>
            {boostMode ? "Promote a published post as a paid ad" : "Create a standalone paid ad"}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 -mr-6">
        <div className="space-y-4 pl-0.5 pr-6">
          {/* Ad Account */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Ad Account</label>
            <AdAccountCombobox value={adAccountId} onSelect={setAdAccountId} />
          </div>

          {/* Boost: Post Target ID */}
          {boostMode && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Post Target ID</label>
              <input className={inputClass} placeholder="pt_..." value={postTargetId} onChange={(e) => setPostTargetId(e.target.value)} />
              <p className="text-[10px] text-muted-foreground mt-1">The published post target ID to boost</p>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Name</label>
            <input className={inputClass} placeholder="Ad name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {/* Objective */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Objective</label>
            <select value={objective} onChange={(e) => setObjective(e.target.value)} className={inputClass}>
              {objectives.map((o) => (
                <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1).replace("_", " ")}</option>
              ))}
            </select>
          </div>

          {/* Creative (non-boost only) */}
          {!boostMode && (
            <>
              <div className="border-t border-border pt-4">
                <p className="text-xs font-medium text-muted-foreground mb-3">Creative</p>
                <div className="space-y-3">
                  <input className={inputClass} placeholder="Headline" value={headline} onChange={(e) => setHeadline(e.target.value)} />
                  <textarea
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                    placeholder="Ad body text"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-muted-foreground mb-1 block">Call to Action</label>
                      <select value={callToAction} onChange={(e) => setCallToAction(e.target.value)} className={inputClass}>
                        <option value="">None</option>
                        {ctaOptions.map((c) => (
                          <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground mb-1 block">Link URL</label>
                      <input className={inputClass} placeholder="https://..." value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <input className={inputClass} placeholder="Image URL" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
                    <input className={inputClass} placeholder="Video URL" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Budget */}
          <div className="border-t border-border pt-4">
            <p className="text-xs font-medium text-muted-foreground mb-3">Budget</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-muted-foreground mb-1 block">Daily ($)</label>
                <input className={inputClass} type="number" step="0.01" min="0" placeholder="0.00" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} />
              </div>
              {!boostMode && (
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">Lifetime ($)</label>
                  <input className={inputClass} type="number" step="0.01" min="0" placeholder="0.00" value={lifetimeBudget} onChange={(e) => setLifetimeBudget(e.target.value)} />
                </div>
              )}
              <div>
                <label className="text-[10px] text-muted-foreground mb-1 block">Duration (days)</label>
                <input className={inputClass} type="number" min="1" max="365" value={durationDays} onChange={(e) => setDurationDays(e.target.value)} />
              </div>
            </div>
            {!boostMode && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">Start Date</label>
                  <input className={inputClass} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">End Date</label>
                  <input className={inputClass} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </div>
              </div>
            )}
          </div>

          {/* Targeting */}
          <div className="border-t border-border pt-4">
            <p className="text-xs font-medium text-muted-foreground mb-3">Targeting</p>
            <div className="space-y-3">
              {/* Age */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">Min Age</label>
                  <input className={inputClass} type="number" min="13" max="65" value={ageMin} onChange={(e) => setAgeMin(e.target.value)} />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">Max Age</label>
                  <input className={inputClass} type="number" min="13" max="65" value={ageMax} onChange={(e) => setAgeMax(e.target.value)} />
                </div>
              </div>

              {/* Gender */}
              <div>
                <label className="text-[10px] text-muted-foreground mb-1 block">Gender</label>
                <div className="flex gap-2">
                  {["male", "female", "all"].map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => toggleGender(g)}
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-md transition-colors border",
                        genders.includes(g)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-input text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {g.charAt(0).toUpperCase() + g.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Interests */}
              <div>
                <label className="text-[10px] text-muted-foreground mb-1 block">Interests</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                  <input
                    className={cn(inputClass, "pl-8")}
                    placeholder="Search interests..."
                    value={interestQuery}
                    onChange={(e) => setInterestQuery(e.target.value)}
                  />
                  {searchingInterests && <Loader2 className="absolute right-2.5 top-2.5 size-3.5 animate-spin text-muted-foreground" />}
                </div>
                {interestResults.length > 0 && (
                  <ScrollArea className="mt-1 max-h-32 rounded-md border border-border bg-popover p-1">
                    {interestResults.map((ir) => (
                      <button
                        key={ir.id}
                        type="button"
                        className="w-full px-2 py-1.5 text-xs text-left rounded hover:bg-accent transition-colors flex justify-between"
                        onClick={() => {
                          if (!interests.find((i) => i.id === ir.id)) {
                            setInterests((prev) => [...prev, { id: ir.id, name: ir.name }]);
                          }
                          setInterestQuery("");
                          setInterestResults([]);
                        }}
                      >
                        <span>{ir.name}</span>
                        {ir.audience_size != null && (
                          <span className="text-muted-foreground">{ir.audience_size.toLocaleString()}</span>
                        )}
                      </button>
                    ))}
                  </ScrollArea>
                )}
                {interests.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {interests.map((i) => (
                      <span key={i.id} className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px]">
                        {i.name}
                        <button type="button" onClick={() => setInterests((prev) => prev.filter((x) => x.id !== i.id))} className="hover:text-destructive">
                          &times;
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button onClick={handleSubmit} disabled={loading || !adAccountId || (boostMode && !postTargetId)} className="w-full gap-1.5">
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            {loading ? "Creating..." : boostMode ? "Boost Post" : "Create Ad"}
          </Button>
        </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
