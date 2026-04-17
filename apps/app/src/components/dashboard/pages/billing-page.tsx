import { useState, useEffect, useCallback } from "react";
import { motion } from "motion/react";
import {
  Zap,
  Check,
  CreditCard,
  Receipt,
  ArrowRight,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUsage } from "@/hooks/use-usage";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
  },
};

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    features: [
      "200 API calls/month",
      "All 21 platforms",
      "Unlimited profiles",
      "Media uploads",
      "Webhook notifications",
      "100 req/min rate limit",
    ],
  },
  {
    name: "Pro",
    price: "$5",
    period: "/month",
    features: [
      "10,000 API calls included",
      "$1 per 1,000 extra calls",
      "All 21 platforms",
      "Unlimited profiles",
      "Comments API included",
      "Analytics API included",
      "1,000 req/min rate limit",
    ],
  },
];

interface BillingStatus {
  subscription: {
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    hasStripeCustomer: boolean;
    hasStripeSubscription: boolean;
  } | null;
  invoices: Array<{
    id: string;
    status: string;
    periodStart: string;
    periodEnd: string;
    totalCents: number;
    stripeHostedUrl: string | null;
    paidAt: string | null;
    finalizedAt: string | null;
    createdAt: string;
  }>;
}

export function BillingPage() {
  const { usage, loading, error, refetch: refetchUsage } = useUsage();
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  const fetchBillingStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/billing/status");
      if (res.ok) {
        setBillingStatus(await res.json());
      }
    } catch {
      // Silently fail — usage data is the primary source
    } finally {
      setBillingLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBillingStatus();
  }, [fetchBillingStatus]);

  // Reset loading states when returning from Stripe via bfcache (back button)
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        setCheckoutLoading(false);
        setPortalLoading(false);
        refetchUsage();
        fetchBillingStatus();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [fetchBillingStatus, refetchUsage]);

  // After successful Stripe Checkout: sync subscription to DB + KV, then refresh
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("success") === "true") {
      window.history.replaceState({}, "", window.location.pathname);
      (async () => {
        await fetch("/api/billing/sync", { method: "POST", headers: { "Content-Type": "application/json" } });
        refetchUsage();
        fetchBillingStatus();
      })();
    }
  }, [fetchBillingStatus, refetchUsage]);

  const isCancelled = billingStatus?.subscription?.status === "cancelled";
  // If Stripe says cancelled, override KV-cached plan to free
  const currentPlan = isCancelled ? "free" : (usage?.plan || "free");
  const apiUsed = usage?.api_calls?.used || 0;
  const apiIncluded = isCancelled ? 200 : (usage?.api_calls?.included || 200);
  const periodEnd = usage?.period_end
    ? new Date(usage.period_end).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

  const isPastDue = billingStatus?.subscription?.status === "past_due";
  const isCancelling = billingStatus?.subscription?.cancelAtPeriodEnd && !isCancelled;
  if (loading || billingLoading) {
    return (
      <div className="space-y-6">
        <div className="h-6 w-20 rounded bg-accent/40 animate-pulse" />
        <div className="rounded-md border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-accent/10">
            <div className="h-4 w-28 rounded bg-accent/40 animate-pulse" />
          </div>
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <div className="h-4 w-24 rounded bg-accent/40 animate-pulse" />
                <div className="h-3 w-48 rounded bg-accent/40 animate-pulse" />
              </div>
              <div className="h-6 w-16 rounded-full bg-accent/40 animate-pulse" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <div className="h-3 w-16 rounded bg-accent/40 animate-pulse" />
                <div className="h-3 w-24 rounded bg-accent/40 animate-pulse" />
              </div>
              <div className="h-1.5 rounded-full bg-accent/40" />
            </div>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-md border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-accent/10 space-y-2">
                <div className="h-4 w-12 rounded bg-accent/40 animate-pulse" />
                <div className="h-6 w-20 rounded bg-accent/40 animate-pulse" />
              </div>
              <div className="p-4 space-y-2.5">
                {[0, 1, 2, 3].map((j) => (
                  <div key={j} className="h-4 w-40 rounded bg-accent/40 animate-pulse" />
                ))}
                <div className="pt-2">
                  <div className="h-8 w-full rounded bg-accent/40 animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const apiPct = apiIncluded > 0 ? Math.round((apiUsed / apiIncluded) * 100) : 0;

  async function handleCheckout() {
    setCheckoutLoading(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setCheckoutLoading(false);
    } catch {
      setCheckoutLoading(false);
    }
  }

  async function handlePortal() {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        console.error("[billing/portal] Response not ok:", res.status);
        setPortalLoading(false);
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      console.error("[billing/portal] No url in response:", data);
      setPortalLoading(false);
    } catch (err) {
      console.error("[billing/portal] Fetch error:", err);
      setPortalLoading(false);
    }
  }

  return (
    <>
    {error && (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-6">
        {error}
      </div>
    )}

    {/* Past Due Banner */}
    {isPastDue && (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 mb-6 flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" />
        <span>Your payment failed. Please update your payment method to avoid losing Pro access.</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 text-xs shrink-0"
          onClick={handlePortal}
          disabled={portalLoading}
        >
          {portalLoading ? <Loader2 className="size-3 animate-spin" /> : "Update Payment"}
        </Button>
      </div>
    )}

    {/* Cancelling Banner */}
    {isCancelling && !isPastDue && (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 mb-6 flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" />
        <span>
          Your Pro plan will end on{" "}
          {billingStatus?.subscription?.currentPeriodEnd
            ? new Date(billingStatus.subscription.currentPeriodEnd).toLocaleDateString("en-US", {
                month: "short", day: "numeric", year: "numeric",
              })
            : "the end of your billing period"
          }. You can resume anytime before then.
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 text-xs shrink-0"
          onClick={handlePortal}
          disabled={portalLoading}
        >
          {portalLoading ? <Loader2 className="size-3 animate-spin" /> : "Resume Plan"}
        </Button>
      </div>
    )}

    <motion.div
      className="space-y-6"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={fadeUp}>
        <h1 className="text-lg font-medium">Billing</h1>
      </motion.div>

      {/* Current Plan & Usage */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Zap className="size-3.5" />
            Current Plan
          </h2>
        </div>
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[13px] font-medium capitalize">
                {currentPlan} Plan
              </p>
              {isCancelling && billingStatus?.subscription?.currentPeriodEnd ? (
                <p className="text-[12px] text-amber-500 font-medium mt-0.5">
                  Pro access ends{" "}
                  {new Date(billingStatus.subscription.currentPeriodEnd).toLocaleDateString("en-US", {
                    month: "long", day: "numeric", year: "numeric",
                  })}
                </p>
              ) : periodEnd ? (
                <p className="text-[11px] text-muted-foreground">
                  Your current billing period ends on {periodEnd}
                </p>
              ) : null}
            </div>
            <span className={cn(
              "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium",
              isPastDue || isCancelling || isCancelled
                ? "text-amber-500 bg-amber-500/10"
                : "text-emerald-400 bg-emerald-400/10"
            )}>
              {isPastDue ? "Past Due" : isCancelled ? "Cancelled" : isCancelling ? "Cancelling" : "Active"}
            </span>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">API Calls</span>
                <span className="text-xs text-muted-foreground">
                  {apiUsed.toLocaleString()} / {apiIncluded.toLocaleString()}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-accent/40 overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    apiPct > 95
                      ? "bg-red-400"
                      : apiPct > 80
                        ? "bg-amber-400"
                        : "bg-primary"
                  )}
                  style={{ width: `${Math.min(apiPct, 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Plan Comparison */}
      <motion.div variants={fadeUp}>
        <div className="grid gap-4 sm:grid-cols-2">
          {plans.map((plan) => {
            const isCurrent = plan.name.toLowerCase() === currentPlan;
            const isPro = plan.name === "Pro";
            return (
              <div
                key={plan.name}
                className={cn(
                  "rounded-md border overflow-hidden",
                  isPro ? "border-primary/40" : "border-border"
                )}
              >
                <div
                  className={cn(
                    "px-4 py-3 border-b",
                    isPro
                      ? "border-primary/40 bg-primary/5"
                      : "border-border bg-accent/10"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-[13px] font-medium">{plan.name}</h3>
                    {isCurrent && (
                      <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                        Current plan
                      </span>
                    )}
                  </div>
                  <p className="mt-1">
                    <span className="text-xl font-semibold">{plan.price}</span>
                    <span className="text-xs text-muted-foreground">
                      {plan.period}
                    </span>
                  </p>
                </div>
                <div className="p-4 space-y-2.5">
                  {plan.features.map((feature) => (
                    <div
                      key={feature}
                      className="flex items-center gap-2 text-[13px]"
                    >
                      <Check
                        className={cn(
                          "size-3.5 shrink-0",
                          isPro ? "text-primary" : "text-muted-foreground"
                        )}
                      />
                      <span className={!isPro ? "text-muted-foreground" : ""}>
                        {feature}
                      </span>
                    </div>
                  ))}
                  <div className="pt-2">
                    {isCurrent && currentPlan === "pro" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full h-8 text-xs gap-1.5"
                        onClick={handlePortal}
                        disabled={portalLoading}
                      >
                        {portalLoading ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <>
                            <Settings className="size-3" />
                            Manage Plan
                          </>
                        )}
                      </Button>
                    ) : isCurrent && currentPlan === "free" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full h-8 text-xs"
                        disabled
                      >
                        Current Plan
                      </Button>
                    ) : plan.name === "Free" && currentPlan === "pro" ? (
                      isCancelling ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full h-8 text-xs"
                          disabled
                        >
                          Downgrade Scheduled
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full h-8 text-xs"
                          onClick={handlePortal}
                          disabled={portalLoading}
                        >
                          {portalLoading ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            "Manage Plan"
                          )}
                        </Button>
                      )
                    ) : (
                      <Button
                        size="sm"
                        className="w-full h-8 text-xs gap-1.5"
                        onClick={handleCheckout}
                        disabled={checkoutLoading}
                      >
                        {checkoutLoading ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <>
                            Upgrade to Pro
                            <ArrowRight className="size-3" />
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>

      {/* Payment Method / Subscription Management */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <CreditCard className="size-3.5" />
            Payment Method
          </h2>
        </div>
        <div className="p-6 text-center">
          {currentPlan === "pro" ? (
            <>
              <p className="text-[13px] text-muted-foreground mb-3">
                Manage your payment method, update your card, or cancel your subscription via Stripe.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                onClick={handlePortal}
                disabled={portalLoading}
              >
                {portalLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <>
                    <ExternalLink className="size-3" />
                    Manage on Stripe
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <CreditCard className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-[13px] text-muted-foreground">
                No payment method on file
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5 mb-3">
                Upgrade to Pro to add a payment method
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                onClick={handleCheckout}
                disabled={checkoutLoading}
              >
                {checkoutLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <>
                    Upgrade to Pro
                    <ArrowRight className="size-3" />
                  </>
                )}
              </Button>
            </>
          )}
        </div>
      </motion.div>

      {/* Billing History */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border bg-accent/10">
          <h2 className="text-[13px] font-medium flex items-center gap-2">
            <Receipt className="size-3.5" />
            Billing History
          </h2>
        </div>
        {billingStatus?.invoices && billingStatus.invoices.length > 0 ? (
          <div className="divide-y divide-border">
            {billingStatus.invoices.map((invoice) => (
              <div
                key={invoice.id}
                className="px-4 py-3 flex items-center justify-between"
              >
                <div>
                  <p className="text-[13px]">
                    {new Date(invoice.periodStart).toLocaleDateString("en-US", {
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    ${(invoice.totalCents / 100).toFixed(2)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                      invoice.status === "paid"
                        ? "text-emerald-400 bg-emerald-400/10"
                        : invoice.status === "finalized"
                          ? "text-amber-500 bg-amber-500/10"
                          : "text-muted-foreground bg-muted"
                    )}
                  >
                    {invoice.status}
                  </span>
                  {invoice.stripeHostedUrl && (
                    <a
                      href={invoice.stripeHostedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline flex items-center gap-1"
                    >
                      View
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-6 text-center">
            <Receipt className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-[13px] text-muted-foreground">
              No invoices yet
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Your billing history will appear here after your first payment
            </p>
          </div>
        )}
      </motion.div>
    </motion.div>
    </>
  );
}
