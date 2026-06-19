import { Users, Building2, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { key: "admin-users", label: "Users", icon: Users },
  { key: "admin-organizations", label: "Organizations", icon: Building2 },
  { key: "admin-plans", label: "Plans", icon: CreditCard },
] as const;

export function AdminNav({ current }: { current: string }) {
  return (
    <div className="-mx-5 overflow-x-auto scrollbar-hide px-5 sm:mx-0 sm:overflow-visible sm:px-0">
    <div className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5">
      {tabs.map((tab) => {
        const active = current === tab.key;
        return (
          <a
            key={tab.key}
            href={`/app/${tab.key}`}
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3.5 py-1 text-[13px] font-medium transition-colors ease-[var(--ease-relay)] [&_svg]:size-[15px] [&_svg]:shrink-0",
              active
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <tab.icon />
            {tab.label}
          </a>
        );
      })}
    </div>
    </div>
  );
}
