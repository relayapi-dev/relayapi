import { Users, Building2, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { key: "admin-users", label: "Users", icon: Users },
  { key: "admin-organizations", label: "Organizations", icon: Building2 },
  { key: "admin-plans", label: "Plans", icon: CreditCard },
] as const;

export function AdminNav({ current }: { current: string }) {
  return (
    <div className="flex items-center gap-1 border-b border-border mb-6">
      {tabs.map((tab) => (
        <a
          key={tab.key}
          href={`/app/${tab.key}`}
          className={cn(
            "flex items-center gap-2 px-3 py-2 text-[13px] border-b-2 -mb-px transition-colors",
            current === tab.key
              ? "border-foreground text-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <tab.icon className="size-3.5" />
          {tab.label}
        </a>
      ))}
    </div>
  );
}
