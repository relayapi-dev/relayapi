import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { platformColors } from "@/lib/platform-maps";
import { platformIcons } from "@/lib/platform-icons";
import { ArrowRight } from "lucide-react";

interface InstagramDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InstagramDialog({ open, onOpenChange }: InstagramDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={cn("flex size-9 items-center justify-center rounded-md text-white", platformColors.instagram)}>
              {platformIcons.instagram}
            </div>
            <div>
              <DialogTitle className="text-base">Connect Instagram</DialogTitle>
              <DialogDescription className="text-xs">Choose how to connect your account</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <a
            href="/app/connect/start/instagram?method=direct"
            className="flex items-center justify-between rounded-md border border-border p-3 transition-colors hover:bg-accent/20 no-underline text-inherit"
          >
            <div className="flex items-center gap-3">
              <div className={cn("flex size-8 items-center justify-center rounded-md text-white", platformColors.instagram)}>
                {platformIcons.instagram}
              </div>
              <div>
                <p className="text-sm font-medium">Sign in with Instagram</p>
                <p className="text-xs text-muted-foreground">Log in directly with your Instagram account</p>
              </div>
            </div>
            <ArrowRight className="size-4 text-muted-foreground" />
          </a>

          <a
            href="/app/connect/start/instagram"
            className="flex items-center justify-between rounded-md border border-border p-3 transition-colors hover:bg-accent/20 no-underline text-inherit"
          >
            <div className="flex items-center gap-3">
              <div className={cn("flex size-8 items-center justify-center rounded-md text-white", platformColors.facebook)}>
                {platformIcons.facebook}
              </div>
              <div>
                <p className="text-sm font-medium">Sign in with Facebook</p>
                <p className="text-xs text-muted-foreground">Connect via your linked Facebook account</p>
              </div>
            </div>
            <ArrowRight className="size-4 text-muted-foreground" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
