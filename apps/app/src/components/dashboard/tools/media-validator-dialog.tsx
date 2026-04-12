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

interface PlatformLimit {
  within_limit: boolean;
  max_size: number;
  mime_type_supported?: boolean;
}

interface ValidateMediaResponse {
  accessible: boolean;
  content_type: string | null;
  size: number | null;
  platform_limits: Record<string, PlatformLimit>;
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

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

interface MediaValidatorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MediaValidatorDialog({ open, onOpenChange }: MediaValidatorDialogProps) {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ValidateMediaResponse | null>(null);
  const { mutate, loading, error } = useMutation<ValidateMediaResponse>("tools/validate-media");

  const handleCheck = async () => {
    const data = await mutate({ url });
    if (data) setResult(data);
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      setUrl("");
      setResult(null);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Media Validator</DialogTitle>
          <DialogDescription>
            Verify a media file URL meets platform specifications
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 pt-1 pl-1 pr-6">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/image.jpg"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && url.trim()) handleCheck();
            }}
          />

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-3">
              {/* File info */}
              <div className="rounded-md border border-border bg-accent/20 px-3 py-2.5 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Accessible</span>
                  <span className={result.accessible ? "text-emerald-500" : "text-destructive"}>
                    {result.accessible ? "Yes" : "No"}
                  </span>
                </div>
                {result.content_type && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Type</span>
                    <span>{result.content_type}</span>
                  </div>
                )}
                {result.size != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Size</span>
                    <span>{formatSize(result.size)}</span>
                  </div>
                )}
              </div>

              {/* Platform limits */}
              <ScrollArea className="max-h-[260px] rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-accent/30">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Platform</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Max Size</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">Size</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(result.platform_limits).map(([platform, info]) => (
                      <tr
                        key={platform}
                        className={`border-b border-border last:border-0 ${
                          !info.within_limit || info.mime_type_supported === false
                            ? "bg-destructive/5"
                            : ""
                        }`}
                      >
                        <td className="px-3 py-1.5 font-medium">
                          {PLATFORM_LABELS[platform] || platform}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {formatSize(info.max_size)}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {info.within_limit ? (
                            <Check className="size-3.5 text-emerald-500 mx-auto" />
                          ) : (
                            <X className="size-3.5 text-destructive mx-auto" />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {info.mime_type_supported == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : info.mime_type_supported ? (
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
            disabled={!url.trim() || loading}
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : "Validate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
