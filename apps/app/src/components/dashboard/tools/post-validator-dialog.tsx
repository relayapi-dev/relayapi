import { useState } from "react";
import { Loader2, Check, X, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useMutation } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ValidationError {
  target: string;
  code: string;
  message: string;
}

interface ValidatePostResponse {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

const PLATFORMS = [
  { id: "twitter", label: "Twitter / X" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
  { id: "pinterest", label: "Pinterest" },
  { id: "reddit", label: "Reddit" },
  { id: "bluesky", label: "Bluesky" },
  { id: "threads", label: "Threads" },
  { id: "telegram", label: "Telegram" },
  { id: "snapchat", label: "Snapchat" },
  { id: "googlebusiness", label: "Google Business" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "mastodon", label: "Mastodon" },
  { id: "discord", label: "Discord" },
  { id: "sms", label: "SMS" },
] as const;

interface PostValidatorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PostValidatorDialog({ open, onOpenChange }: PostValidatorDialogProps) {
  const [content, setContent] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [result, setResult] = useState<ValidatePostResponse | null>(null);
  const { mutate, loading, error } = useMutation<ValidatePostResponse>("tools/validate-post");

  const togglePlatform = (id: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  };

  const selectAll = () => {
    if (selectedPlatforms.length === PLATFORMS.length) {
      setSelectedPlatforms([]);
    } else {
      setSelectedPlatforms(PLATFORMS.map((p) => p.id));
    }
  };

  const handleValidate = async () => {
    const data = await mutate({
      content,
      targets: selectedPlatforms,
      scheduled_at: "now",
    });
    if (data) setResult(data);
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      setContent("");
      setSelectedPlatforms([]);
      setResult(null);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Post Validator</DialogTitle>
          <DialogDescription>
            Check if your post content meets platform requirements
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 pt-1 pl-1 pr-6">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Type or paste your post content..."
            rows={3}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-none"
          />

          {/* Platform selection */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Target platforms</label>
              <button
                type="button"
                onClick={selectAll}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {selectedPlatforms.length === PLATFORMS.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {PLATFORMS.map((p) => {
                const selected = selectedPlatforms.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => togglePlatform(p.id)}
                    className={cn(
                      "rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors text-left",
                      selected
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-accent/30",
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-2">
              {/* Status banner */}
              <div
                className={cn(
                  "rounded-md border px-3 py-2 flex items-center gap-2 text-sm font-medium",
                  result.valid
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600"
                    : "border-destructive/20 bg-destructive/10 text-destructive",
                )}
              >
                {result.valid ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <XCircle className="size-4" />
                )}
                {result.valid ? "Post is valid for all selected platforms" : "Post has validation issues"}
              </div>

              {/* Errors */}
              {result.errors.length > 0 && (
                <div className="space-y-1">
                  {result.errors.map((err, i) => (
                    <div
                      key={`err-${i}`}
                      className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs"
                    >
                      <X className="size-3 text-destructive shrink-0 mt-0.5" />
                      <div>
                        <span className="font-medium text-destructive">{err.target}</span>
                        <span className="text-muted-foreground"> — {err.message}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Warnings */}
              {result.warnings.length > 0 && (
                <div className="space-y-1">
                  {result.warnings.map((warn, i) => (
                    <div
                      key={`warn-${i}`}
                      className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs"
                    >
                      <AlertTriangle className="size-3 text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-medium text-amber-600">{warn.target}</span>
                        <span className="text-muted-foreground"> — {warn.message}</span>
                      </div>
                    </div>
                  ))}
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
            onClick={handleValidate}
            disabled={!content.trim() || selectedPlatforms.length === 0 || loading}
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : "Validate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
