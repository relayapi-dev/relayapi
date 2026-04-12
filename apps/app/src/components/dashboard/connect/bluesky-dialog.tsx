import { useState } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
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

interface BlueskyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

export function BlueskyDialog({ open, onOpenChange, onConnected }: BlueskyDialogProps) {
  const [handle, setHandle] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim() || !appPassword.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/connect/bluesky", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: handle.trim(), app_password: appPassword.trim() }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Connection failed (${res.status})`);
        return;
      }

      setSuccess(true);
      onConnected();
      setTimeout(() => {
        onOpenChange(false);
        setSuccess(false);
        setHandle("");
        setAppPassword("");
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
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
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={cn("flex size-9 items-center justify-center rounded-md text-xs font-bold text-white", platformColors.bluesky)}>
              {platformAvatars.bluesky}
            </div>
            <div>
              <DialogTitle className="text-base">Connect Bluesky</DialogTitle>
              <DialogDescription className="text-xs">Enter your handle and app password</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {success ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="size-8 text-emerald-500" />
            <p className="text-sm font-medium">Bluesky connected!</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="space-y-3 py-2">
              <div>
                <label htmlFor="bs-handle" className="text-xs font-medium text-muted-foreground">
                  Handle
                </label>
                <input
                  id="bs-handle"
                  type="text"
                  placeholder="user.bsky.social"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  autoComplete="off"
                  disabled={loading}
                />
              </div>
              <div>
                <label htmlFor="bs-password" className="text-xs font-medium text-muted-foreground">
                  App Password
                </label>
                <input
                  id="bs-password"
                  type="password"
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  autoComplete="off"
                  disabled={loading}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Create an app password at bsky.app &rarr; Settings &rarr; App Passwords
                </p>
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
              <Button type="submit" size="sm" disabled={loading || !handle.trim() || !appPassword.trim()}>
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : "Connect"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
