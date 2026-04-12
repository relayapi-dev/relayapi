import { useState, useEffect } from "react";

export function NowIndicator({ timezone, startHour = 0, totalHours = 24 }: { timezone?: string; startHour?: number; totalHours?: number }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0");
  const minutes = h * 60 + m;
  const startMinute = startHour * 60;
  const totalMinutes = totalHours * 60;
  const topPercent = ((minutes - startMinute) / totalMinutes) * 100;

  // Hide if current time is outside the visible range
  if (topPercent < 0 || topPercent > 100) return null;

  return (
    <div
      className="absolute left-0 right-0 z-10 pointer-events-none"
      style={{ top: `${topPercent}%` }}
    >
      <div className="relative flex items-center">
        <div className="size-2 rounded-full bg-red-500 -ml-1 shrink-0" />
        <div className="flex-1 h-px bg-red-500" />
      </div>
    </div>
  );
}
