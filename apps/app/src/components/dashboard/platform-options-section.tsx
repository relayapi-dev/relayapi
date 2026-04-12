import { motion, AnimatePresence } from "motion/react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { platformColors, platformLabels, platformAvatars } from "@/lib/platform-maps";

interface PlatformOptionsSectionProps {
  platform: string;
  expanded: boolean;
  onToggle: () => void;
  hasRequired?: boolean;
  children: React.ReactNode;
}

export function PlatformOptionsSection({
  platform,
  expanded,
  onToggle,
  hasRequired,
  children,
}: PlatformOptionsSectionProps) {
  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-2 text-xs hover:bg-accent/30 transition-colors"
      >
        <div
          className={cn(
            "flex size-5 items-center justify-center rounded text-[8px] font-bold text-white shrink-0",
            platformColors[platform] || "bg-neutral-700",
          )}
        >
          {platformAvatars[platform] || platform.slice(0, 2).toUpperCase()}
        </div>
        <span className="font-medium text-foreground flex-1 text-left">
          {platformLabels[platform] || platform}
        </span>
        {hasRequired && (
          <span className="size-1.5 rounded-full bg-destructive shrink-0" />
        )}
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground transition-transform duration-150",
            expanded && "rotate-180",
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-2.5 px-4 pb-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
