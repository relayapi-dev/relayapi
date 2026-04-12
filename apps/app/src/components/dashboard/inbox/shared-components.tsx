import { cn } from "@/lib/utils";
import { platformColors, platformLabels } from "./shared";

export function AuthorAvatar({ avatar, name, size = "md" }: { avatar: string | null; name: string; size?: "sm" | "md" }) {
  const sizeClass = size === "sm" ? "size-6 text-[9px]" : "size-8 text-[11px]";
  const initial = (name || "?").charAt(0).toUpperCase();
  if (avatar) {
    return <img src={avatar} alt={name} className={cn(sizeClass, "rounded-full border border-border object-cover shrink-0")} />;
  }
  return (
    <div className={cn(sizeClass, "rounded-full border border-border bg-muted flex items-center justify-center font-medium text-muted-foreground shrink-0")}>
      {initial}
    </div>
  );
}

export function PlatformBadge({ platform }: { platform: string }) {
  return (
    <div
      className={cn(
        "flex size-8 items-center justify-center rounded-lg text-[10px] font-bold text-white shrink-0 mt-0.5",
        platformColors[platform] || "bg-neutral-700"
      )}
    >
      {platformLabels[platform] || platform.slice(0, 2).toUpperCase()}
    </div>
  );
}

export function ReplyProgressBar({ replied, total }: { replied: number; total: number }) {
  const ratio = total > 0 ? Math.round((replied / total) * 100) : 0;
  return (
    <div className="h-1 w-full rounded-full bg-muted overflow-hidden mt-2">
      <div
        className={cn("h-full rounded-full transition-all", ratio === 100 ? "bg-emerald-500" : "bg-amber-500")}
        style={{ width: `${ratio}%` }}
      />
    </div>
  );
}
