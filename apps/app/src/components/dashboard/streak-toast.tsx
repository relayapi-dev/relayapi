import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Flame, X } from "lucide-react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { cn } from "@/lib/utils";

interface StreakToast {
  id: number;
  message: string;
  type: "milestone" | "broken";
}

const MILESTONE_MESSAGES: Record<number, string> = {
  7: "7-day streak! You're on a roll!",
  30: "30-day streak! Incredible consistency!",
  100: "100-day streak! You're a posting machine!",
  365: "365-day streak! A full year of posting!",
};

export function StreakToastContainer() {
  const [toasts, setToasts] = useState<StreakToast[]>([]);
  const nextId = useRef(0);

  const addToast = useCallback((message: string, type: StreakToast["type"]) => {
    const id = ++nextId.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    // Auto-dismiss after 6 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useRealtimeUpdates(
    useCallback(
      (event) => {
        if (event.type === "streak.milestone") {
          const days = (event as any).current_streak_days as number;
          const msg = MILESTONE_MESSAGES[days] || `${days}-day posting streak!`;
          addToast(msg, "milestone");
        } else if (event.type === "streak.broken") {
          const days = (event as any).broken_streak_days as number;
          addToast(
            `Your ${days}-day streak ended. Start a new one today!`,
            "broken",
          );
        }
      },
      [addToast],
    ),
    { defer: 4000 },
  );

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
            className={cn(
              "flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg backdrop-blur",
              toast.type === "milestone"
                ? "border-amber-500/30 bg-amber-950/80 text-amber-100"
                : "border-border bg-background/95 text-foreground",
            )}
          >
            <Flame
              className={cn(
                "size-5 mt-0.5 shrink-0",
                toast.type === "milestone"
                  ? "text-amber-400"
                  : "text-muted-foreground",
              )}
            />
            <p className="text-sm flex-1">{toast.message}</p>
            <button
              onClick={() => dismissToast(toast.id)}
              className="shrink-0 mt-0.5 text-current opacity-50 hover:opacity-100 transition-opacity"
            >
              <X className="size-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
