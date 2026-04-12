import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, CheckCircle2, Copy, ExternalLink, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { platformColors, platformAvatars } from "@/lib/platform-maps";

interface TelegramDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

interface TelegramInitData {
  code: string;
  bot_username: string;
  instructions: string[];
  expires_at: string;
  expires_in: number;
}

type TelegramStep =
  | { type: "loading" }
  | { type: "code"; data: TelegramInitData }
  | { type: "success" }
  | { type: "expired" }
  | { type: "error"; message: string };

export function TelegramDialog({ open, onOpenChange, onConnected }: TelegramDialogProps) {
  const [step, setStep] = useState<TelegramStep>({ type: "loading" });
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const initiate = useCallback(async () => {
    setStep({ type: "loading" });
    stopPolling();

    try {
      const res = await fetch("/api/connect/telegram");
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setStep({ type: "error", message: err?.error?.message || "Failed to initiate connection" });
        return;
      }
      const data: TelegramInitData = await res.json();
      setStep({ type: "code", data });

      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/connect/telegram?code=${data.code}`);
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();

          if (pollData.status === "connected") {
            stopPolling();
            setStep({ type: "success" });
            onConnected();
          } else if (pollData.status === "expired") {
            stopPolling();
            setStep({ type: "expired" });
          }
        } catch {
          // keep polling on transient errors
        }
      }, 3000);
    } catch (err) {
      setStep({ type: "error", message: err instanceof Error ? err.message : "Failed to initiate connection" });
    }
  }, [onConnected, stopPolling]);

  useEffect(() => {
    if (open) {
      initiate();
    } else {
      stopPolling();
      setStep({ type: "loading" });
      setCopied(false);
    }
    return stopPolling;
  }, [open, initiate, stopPolling]);

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = (open: boolean) => {
    if (!open) stopPolling();
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={cn("flex size-9 items-center justify-center rounded-md text-xs font-bold text-white", platformColors.telegram)}>
              {platformAvatars.telegram}
            </div>
            <div>
              <DialogTitle className="text-base">Connect Telegram</DialogTitle>
              <DialogDescription className="text-xs">Connect via the RelayAPI bot</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {step.type === "loading" && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {step.type === "code" && (
          <div className="space-y-4 py-2">
            <div className="rounded-md border border-border bg-muted/30 p-4 text-center">
              <p className="text-xs text-muted-foreground mb-2">Your connection code</p>
              <div className="flex items-center justify-center gap-2">
                <code className="text-2xl font-mono font-bold tracking-widest">{step.data.code}</code>
                <button
                  onClick={() => handleCopy(step.data.code)}
                  className="rounded-md p-1.5 hover:bg-accent/50 transition-colors"
                  title="Copy code"
                >
                  {copied ? (
                    <CheckCircle2 className="size-4 text-emerald-500" />
                  ) : (
                    <Copy className="size-4 text-muted-foreground" />
                  )}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Instructions</p>
              <ol className="space-y-1.5 text-xs text-muted-foreground">
                {step.data.instructions.map((instruction, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-medium text-foreground shrink-0">{i + 1}.</span>
                    <span>{instruction}</span>
                  </li>
                ))}
              </ol>
            </div>

            <a
              href={`https://t.me/${step.data.bot_username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-accent/20 transition-colors"
            >
              Open @{step.data.bot_username} in Telegram
              <ExternalLink className="size-3" />
            </a>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Waiting for connection...
            </div>
          </div>
        )}

        {step.type === "success" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="size-8 text-emerald-500" />
            <p className="text-sm font-medium">Telegram connected!</p>
          </div>
        )}

        {step.type === "expired" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm text-muted-foreground">Code expired. Generate a new one to try again.</p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={initiate}>
              <RefreshCw className="size-3.5" />
              Generate New Code
            </Button>
          </div>
        )}

        {step.type === "error" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {step.message}
            </div>
            <Button variant="outline" size="sm" onClick={initiate}>
              Try Again
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleClose(false)}>
            {step.type === "success" ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
