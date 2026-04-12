import { useState, useEffect } from "react";
import { Loader2, CheckCircle2, Send } from "lucide-react";
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
import { platformColors, platformLabels } from "@/lib/platform-maps";
import { platformIcons } from "@/lib/platform-icons";

interface OnDemandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: string;
  userName?: string;
  userEmail?: string;
}

export function OnDemandDialog({ open, onOpenChange, platform, userName, userEmail }: OnDemandDialogProps) {
  const label = platformLabels[platform] || platform;
  const [name, setName] = useState(userName || "");
  const [email, setEmail] = useState(userEmail || "");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (open) {
      setName(userName || "");
      setEmail(userEmail || "");
      setMessage(`Hi, I'd like to enable ${platformLabels[platform] || platform} for my account.`);
      setError(null);
      setSuccess(false);
    }
  }, [open, platform, userName, userEmail]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/on-demand-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          name: name.trim(),
          email: email.trim(),
          message: message.trim(),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Request failed (${res.status})`);
        return;
      }

      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (open: boolean) => {
    if (!loading) {
      onOpenChange(open);
      if (!open) {
        setError(null);
        setSuccess(false);
        setName("");
        setEmail("");
        setMessage("");
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={cn("flex size-9 items-center justify-center rounded-md text-white", platformColors[platform] || "bg-neutral-700")}>
              {platformIcons[platform]}
            </div>
            <div>
              <DialogTitle className="text-base">Request {label}</DialogTitle>
              <DialogDescription className="text-xs">
                {label} is available on demand with adjusted pricing
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {success ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="size-8 text-emerald-500" />
            <p className="text-sm font-medium">Request sent!</p>
            <p className="text-xs text-muted-foreground text-center">
              We'll get back to you shortly with pricing details.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="space-y-3 py-2">
              <div>
                <label htmlFor="od-name" className="text-xs font-medium text-muted-foreground">
                  Name
                </label>
                <input
                  id="od-name"
                  type="text"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  autoComplete="name"
                  disabled={loading}
                />
              </div>
              <div>
                <label htmlFor="od-email" className="text-xs font-medium text-muted-foreground">
                  Email <span className="text-destructive">*</span>
                </label>
                <input
                  id="od-email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  autoComplete="email"
                  disabled={loading}
                  required
                />
              </div>
              <div>
                <label htmlFor="od-message" className="text-xs font-medium text-muted-foreground">
                  Message <span className="text-muted-foreground/60">(optional)</span>
                </label>
                <textarea
                  id="od-message"
                  placeholder="Tell us about your use case..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-none"
                  disabled={loading}
                />
              </div>

              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
            </div>

            <DialogFooter className="mt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => handleClose(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={loading || !email.trim()}>
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : <><Send className="size-3.5 mr-1.5" /> Send Request</>}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
