import { useState } from "react";
import { Loader2 } from "lucide-react";
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

interface HashtagResult {
  hashtag: string;
  status: "safe" | "restricted" | "banned";
}

interface HashtagCheckResponse {
  results: HashtagResult[];
}

const STATUS_STYLES: Record<string, string> = {
  safe: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  restricted: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  banned: "bg-destructive/10 text-destructive border-destructive/20",
};

interface HashtagSafetyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HashtagSafetyDialog({ open, onOpenChange }: HashtagSafetyDialogProps) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<HashtagCheckResponse | null>(null);
  const { mutate, loading, error } = useMutation<HashtagCheckResponse>("tools/instagram-hashtag");

  const handleCheck = async () => {
    const hashtags = input
      .split(",")
      .map((h) => h.trim().replace(/^#/, ""))
      .filter(Boolean);
    if (hashtags.length === 0) return;
    const data = await mutate({ hashtags });
    if (data) setResult(data);
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      setInput("");
      setResult(null);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Hashtag Safety</DialogTitle>
          <DialogDescription>
            Check Instagram hashtag safety and reach
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 pt-1 pl-1 pr-6">
          <div className="space-y-1.5">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="travel, photography, instalike"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim()) handleCheck();
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Separate hashtags with commas. The # prefix is optional.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-1.5">
              {result.results.map((item) => (
                <div
                  key={item.hashtag}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <span className="text-sm font-medium">#{item.hashtag}</span>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize",
                      STATUS_STYLES[item.status],
                    )}
                  >
                    {item.status}
                  </span>
                </div>
              ))}
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
            disabled={!input.trim() || loading}
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : "Check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
