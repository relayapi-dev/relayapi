import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CalendarPostCard } from "./calendar-post-card";
import type { CalendarPost } from "./use-calendar-posts";

interface DraftsSidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drafts: CalendarPost[];
}

export function DraftsSidePanel({ open, onOpenChange, drafts }: DraftsSidePanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:max-w-80 p-0 gap-0">
        <SheetHeader className="px-4 py-3 border-b border-border">
          <SheetTitle className="text-sm font-medium">
            Drafts ({drafts.length})
          </SheetTitle>
          <SheetDescription className="text-xs">
            Drag drafts onto calendar dates to schedule them
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="p-3 space-y-1.5">
            {drafts.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-12">
                No unscheduled drafts
              </p>
            ) : (
              drafts.map((draft) => (
                <CalendarPostCard key={draft.id} post={draft} />
              ))
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
