import { useState } from "react";
import { Loader2, Check, X, AlertTriangle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface SubredditResponse {
  exists: boolean;
  name?: string | null;
  title?: string | null;
  subscribers?: number | null;
  nsfw?: boolean | null;
  post_types?: {
    self: boolean;
    link: boolean;
    image: boolean;
    video?: boolean;
  };
}

interface SubredditInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SubredditInfoDialog({ open, onOpenChange }: SubredditInfoDialogProps) {
  const [name, setName] = useState("");
  const [result, setResult] = useState<SubredditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheck = async () => {
    const cleaned = name.trim().replace(/^r\//, "");
    if (!cleaned) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/tools/subreddit?name=${encodeURIComponent(cleaned)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Error ${res.status}`);
      } else {
        const data = await res.json();
        setResult(data as SubredditResponse);
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      setName("");
      setResult(null);
      setError(null);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Subreddit Info</DialogTitle>
          <DialogDescription>
            Look up subreddit rules and posting guidelines
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 pt-1 pl-1 pr-6">
          <div className="space-y-1.5">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="programming"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) handleCheck();
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Enter a subreddit name without the r/ prefix
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {result && !result.exists && (
            <div className="rounded-md border border-border bg-accent/20 px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">Subreddit not found</p>
            </div>
          )}

          {result && result.exists && (
            <div className="rounded-md border border-border divide-y divide-border">
              {/* Header */}
              <div className="px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">r/{result.name}</span>
                  {result.nsfw && (
                    <span className="rounded-full bg-destructive/10 border border-destructive/20 px-2 py-0.5 text-[10px] font-medium text-destructive">
                      NSFW
                    </span>
                  )}
                </div>
                {result.title && (
                  <p className="text-xs text-muted-foreground mt-0.5">{result.title}</p>
                )}
              </div>

              {/* Subscribers */}
              {result.subscribers != null && (
                <div className="px-3 py-2 flex items-center gap-2 text-xs">
                  <Users className="size-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Subscribers</span>
                  <span className="ml-auto tabular-nums font-medium">
                    {result.subscribers.toLocaleString()}
                  </span>
                </div>
              )}

              {/* Post types */}
              {result.post_types && (
                <div className="px-3 py-2.5 space-y-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                    Allowed post types
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    {(
                      [
                        ["self", "Text posts"],
                        ["link", "Link posts"],
                        ["image", "Image posts"],
                        ["video", "Video posts"],
                      ] as const
                    ).map(([key, label]) => {
                      const allowed = result.post_types?.[key];
                      if (allowed === undefined) return null;
                      return (
                        <div key={key} className="flex items-center gap-1.5">
                          {allowed ? (
                            <Check className="size-3 text-emerald-500" />
                          ) : (
                            <X className="size-3 text-destructive" />
                          )}
                          <span className={allowed ? "" : "text-muted-foreground"}>{label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => handleClose(false)}
          >
            Close
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={handleCheck}
            disabled={!name.trim() || loading}
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : "Look Up"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
