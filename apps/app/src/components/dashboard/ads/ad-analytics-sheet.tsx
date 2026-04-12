import { useState } from "react";
import { Loader2, TrendingUp, Eye, MousePointer, DollarSign, Users, BarChart3 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useApi } from "@/hooks/use-api";
import { cn } from "@/lib/utils";

interface AnalyticsData {
  summary: {
    impressions: number;
    reach: number;
    clicks: number;
    spend_cents: number;
    conversions: number;
    ctr: number;
    cpc_cents: number;
    cpm_cents: number;
  };
  daily: Array<{
    date: string;
    impressions: number;
    reach: number;
    clicks: number;
    spend_cents: number;
    conversions: number;
  }>;
  demographics?: {
    age_gender?: Array<{ age_range: string; gender: string; percentage: number }>;
    locations?: Array<{ country: string; percentage: number }>;
  };
}

interface AdAnalyticsSheetProps {
  adId: string | null;
  adName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const numFmt = new Intl.NumberFormat("en-US");

function formatCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

export function AdAnalyticsSheet({ adId, adName, open, onOpenChange }: AdAnalyticsSheetProps) {
  const defaults = defaultDateRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);

  const { data, loading } = useApi<AnalyticsData>(
    open && adId ? `ads/${adId}/analytics` : null,
    { query: { from, to } },
  );

  const s = data?.summary;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="truncate">{adName} — Analytics</SheetTitle>
        </SheetHeader>

        <div className="mt-4 flex items-center gap-2">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          <span className="text-muted-foreground text-xs">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && !s && (
          <p className="py-16 text-center text-sm text-muted-foreground">No analytics data available</p>
        )}

        {!loading && s && (
          <div className="mt-4 space-y-6">
            {/* Summary metrics */}
            <div className="grid grid-cols-2 gap-2">
              <MetricCard icon={Eye} label="Impressions" value={numFmt.format(s.impressions)} />
              <MetricCard icon={Users} label="Reach" value={numFmt.format(s.reach)} />
              <MetricCard icon={MousePointer} label="Clicks" value={numFmt.format(s.clicks)} />
              <MetricCard icon={DollarSign} label="Spend" value={formatCents(s.spend_cents)} />
              <MetricCard icon={TrendingUp} label="CTR" value={`${s.ctr.toFixed(2)}%`} />
              <MetricCard icon={DollarSign} label="CPC" value={formatCents(s.cpc_cents)} />
              <MetricCard icon={DollarSign} label="CPM" value={formatCents(s.cpm_cents)} />
              <MetricCard icon={BarChart3} label="Conversions" value={numFmt.format(s.conversions)} />
            </div>

            {/* Daily bar chart */}
            {data.daily.length > 0 && <DailyChart daily={data.daily} />}

            {/* Demographics */}
            {data.demographics?.age_gender && data.demographics.age_gender.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-medium">Age &amp; Gender</h4>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {data.demographics.age_gender.map((d) => (
                    <li key={`${d.age_range}-${d.gender}`} className="flex justify-between">
                      <span>{d.age_range} · {d.gender}</span>
                      <span>{d.percentage.toFixed(1)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.demographics?.locations && data.demographics.locations.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-medium">Locations</h4>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {data.demographics.locations.map((l) => (
                    <li key={l.country} className="flex justify-between">
                      <span>{l.country}</span>
                      <span>{l.percentage.toFixed(1)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MetricCard({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
        <Icon className="size-3.5" /> {label}
      </div>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function DailyChart({ daily }: { daily: AnalyticsData["daily"] }) {
  const max = Math.max(...daily.map((d) => d.impressions), 1);
  const barWidth = Math.max(4, Math.floor(400 / daily.length) - 2);
  const svgWidth = daily.length * (barWidth + 2);
  const chartHeight = 80;

  return (
    <div>
      <h4 className="mb-2 text-sm font-medium">Daily Impressions</h4>
      <div className="overflow-x-auto">
        <svg width={svgWidth} height={chartHeight} className="block">
          {daily.map((d, i) => {
            const h = (d.impressions / max) * chartHeight;
            return (
              <rect
                key={d.date}
                x={i * (barWidth + 2)}
                y={chartHeight - h}
                width={barWidth}
                height={h}
                rx={1}
                fill="hsl(var(--primary))"
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
