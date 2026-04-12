import { useState } from "react";
import { Loader2, Check, X } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";

interface PlatformResult {
  count: number;
  limit: number;
  within_limit: boolean;
}

interface PostLengthResponse {
  platforms: Record<string, PlatformResult>;
}

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "Twitter / X",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  pinterest: "Pinterest",
  reddit: "Reddit",
  bluesky: "Bluesky",
  threads: "Threads",
  telegram: "Telegram",
  snapchat: "Snapchat",
  googlebusiness: "Google Business",
  whatsapp: "WhatsApp",
  mastodon: "Mastodon",
  discord: "Discord",
  sms: "SMS",
};

interface PostLengthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PostLengthDialog({ open, onOpenChange }: PostLengthDialogProps) {
  const [content, setContent] = useState("");
  const [result, setResult] = useState<PostLengthResponse | null>(null);
  const { mutate, loading, error } = useMutation<PostLengthResponse>("tools/check-post-length");

  const handleCheck = async () => {
    const data = await mutate({ content });
    if (data) setResult(data);
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      setContent("");
      setResult(null);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Post Length Checker</DialogTitle>
          <DialogDescription>
            Check character limits across all supported platforms
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 pt-1 pl-1 pr-6">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Type or paste your post content..."
            rows={4}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-none"
          />

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {result && (
            <ScrollArea className="max-h-[300px] rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-accent/30">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Platform</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Count</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Limit</th>
                    <th className="px-3 py-2 text-center font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.platforms).map(([platform, info]) => (
                    <tr
                      key={platform}
                      className={`border-b border-border last:border-0 ${
                        info.within_limit ? "" : "bg-destructive/5"
                      }`}
                    >
                      <td className="px-3 py-1.5 font-medium">
                        {PLATFORM_LABELS[platform] || platform}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        {info.count.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        {info.limit.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {info.within_limit ? (
                          <Check className="size-3.5 text-emerald-500 mx-auto" />
                        ) : (
                          <X className="size-3.5 text-destructive mx-auto" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
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
            disabled={!content.trim() || loading}
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : "Check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
