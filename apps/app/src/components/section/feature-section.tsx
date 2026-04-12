import { useState, useRef } from "react";
import { motion, AnimatePresence, useInView } from "motion/react";
import { siteConfig } from "../../lib/config";
import { SectionHeader } from "../section-header";
import { HeaderBadge } from "../header-badge";
import { cn } from "../../lib/utils";

const featureConfig = siteConfig.featureSection;

const features = [
    {
        id: "posting",
        number: "01",
        title: "Unified Posting",
        description:
            "Send a single POST request. Relay formats and delivers to every connected platform simultaneously.",
    },
    {
        id: "media",
        number: "02",
        title: "Media Management",
        description:
            "Upload once — images and videos get auto-resized and reformatted to fit each platform's specs.",
    },
    {
        id: "analytics",
        number: "03",
        title: "Analytics & Webhooks",
        description:
            "Track engagement across all platforms. Get real-time notifications when posts publish or receive interactions.",
    },
    {
        id: "scheduling",
        number: "04",
        title: "Scheduling",
        description:
            "Queue posts across time zones. Relay delivers at the right time to every platform you're connected to.",
    },
];

function PostingVisual() {
    const platforms = [
        { name: "Twitter", status: "delivered", delay: 0.2 },
        { name: "LinkedIn", status: "delivered", delay: 0.4 },
        { name: "Instagram", status: "delivered", delay: 0.6 },
    ];

    return (
        <div className="space-y-4">
            <div className="rounded-lg overflow-hidden border border-zinc-800/50 text-xs font-mono">
                <div className="flex items-center gap-2 px-3 py-2 bg-[#1a1a2e] border-b border-zinc-700/50">
                    <div className="size-2 rounded-full bg-[#ff5f57]" />
                    <div className="size-2 rounded-full bg-[#febc2e]" />
                    <div className="size-2 rounded-full bg-[#28c840]" />
                    <span className="text-[10px] text-zinc-500 ml-1">
                        POST /v1/posts
                    </span>
                </div>
                <div className="bg-[#1a1a2e] px-3 py-3 text-[11px] leading-5">
                    <span className="text-zinc-500">{"{"}</span>
                    <br />
                    <span className="text-red-300">
                        &nbsp;&nbsp;"platforms"
                    </span>
                    <span className="text-zinc-500">: </span>
                    <span className="text-emerald-400">
                        ["twitter", "linkedin", "instagram"]
                    </span>
                    <span className="text-zinc-500">,</span>
                    <br />
                    <span className="text-red-300">
                        &nbsp;&nbsp;"content"
                    </span>
                    <span className="text-zinc-500">: </span>
                    <span className="text-emerald-400">
                        "Launching our new product today!"
                    </span>
                    <br />
                    <span className="text-zinc-500">{"}"}</span>
                </div>
            </div>

            <div className="space-y-2">
                {platforms.map((p) => (
                    <motion.div
                        key={p.name}
                        initial={{ opacity: 0, x: -12 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: p.delay, type: "spring", stiffness: 120, damping: 20 }}
                        className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-2.5"
                    >
                        <span className="text-sm font-medium">{p.name}</span>
                        <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                            <span className="size-1.5 rounded-full bg-emerald-500" />
                            {p.status}
                        </span>
                    </motion.div>
                ))}
            </div>
        </div>
    );
}

function MediaVisual() {
    const sizes = [
        { platform: "Instagram", spec: "1080 x 1080", status: "resized" },
        { platform: "Twitter", spec: "1200 x 675", status: "resized" },
        { platform: "LinkedIn", spec: "1200 x 627", status: "resized" },
    ];

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center gap-3 mb-4">
                    <div className="size-10 rounded-lg bg-muted flex items-center justify-center text-xs font-mono text-muted-foreground">
                        JPG
                    </div>
                    <div>
                        <p className="text-sm font-medium">product-hero.jpg</p>
                        <p className="text-xs text-muted-foreground">
                            3840 x 2160 &middot; 2.4 MB
                        </p>
                    </div>
                </div>
                <div className="h-px bg-border mb-4" />
                <p className="text-xs text-muted-foreground mb-3">
                    Auto-generated variants
                </p>
                <div className="space-y-2">
                    {sizes.map((s, i) => (
                        <motion.div
                            key={s.platform}
                            initial={{ opacity: 0, x: -12 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: i * 0.15, type: "spring", stiffness: 120, damping: 20 }}
                            className="flex items-center justify-between text-sm"
                        >
                            <span className="text-muted-foreground">
                                {s.platform}
                            </span>
                            <span className="font-mono text-xs">
                                {s.spec}
                            </span>
                        </motion.div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function AnalyticsVisual() {
    const bars = [
        { platform: "Twitter", value: 84 },
        { platform: "LinkedIn", value: 62 },
        { platform: "Instagram", value: 91 },
        { platform: "TikTok", value: 45 },
    ];

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-medium">Engagement rate</p>
                    <span className="text-xs text-muted-foreground">
                        Last 7 days
                    </span>
                </div>
                <div className="space-y-3">
                    {bars.map((bar, i) => (
                        <div key={bar.platform} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">
                                    {bar.platform}
                                </span>
                                <span className="font-mono">{bar.value}%</span>
                            </div>
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                                <motion.div
                                    initial={{ width: 0 }}
                                    animate={{ width: `${bar.value}%` }}
                                    transition={{ delay: i * 0.12, duration: 0.6, ease: "easeOut" }}
                                    className="h-full rounded-full bg-primary"
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="rounded-lg border border-border bg-card p-4"
            >
                <div className="flex items-center gap-2 mb-1">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    <span className="text-xs font-medium">Webhook received</span>
                </div>
                <p className="text-xs text-muted-foreground font-mono pl-3.5">
                    post_7kxQ9m &middot; 12 likes, 3 comments
                </p>
            </motion.div>
        </div>
    );
}

function SchedulingVisual() {
    const slots = [
        { time: "09:00 AM", platform: "LinkedIn", tz: "EST", status: "scheduled" },
        { time: "12:30 PM", platform: "Twitter", tz: "PST", status: "scheduled" },
        { time: "06:00 PM", platform: "Instagram", tz: "CET", status: "queued" },
    ];

    return (
        <div className="space-y-2">
            {slots.map((slot, i) => (
                <motion.div
                    key={slot.platform}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.15, type: "spring", stiffness: 120, damping: 20 }}
                    className="rounded-lg border border-border bg-card p-4 flex items-center justify-between"
                >
                    <div className="flex items-center gap-3">
                        <div className="text-right">
                            <p className="text-sm font-mono font-medium">
                                {slot.time}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                                {slot.tz}
                            </p>
                        </div>
                        <div className="w-px h-8 bg-border" />
                        <span className="text-sm">{slot.platform}</span>
                    </div>
                    <span
                        className={cn(
                            "text-xs px-2 py-0.5 rounded-full",
                            slot.status === "scheduled"
                                ? "bg-primary/10 text-primary"
                                : "bg-muted text-muted-foreground",
                        )}
                    >
                        {slot.status}
                    </span>
                </motion.div>
            ))}
        </div>
    );
}

const visuals: Record<string, () => React.JSX.Element> = {
    posting: PostingVisual,
    media: MediaVisual,
    analytics: AnalyticsVisual,
    scheduling: SchedulingVisual,
};

export function FeatureSection() {
    const [active, setActive] = useState("posting");
    const ref = useRef(null);
    const inView = useInView(ref, { once: true, margin: "-100px" });
    const ActiveVisual = visuals[active] ?? PostingVisual;

    return (
        <section id="features" className="w-full relative">
            <SectionHeader>
                <HeaderBadge
                    icon={featureConfig.badge.icon}
                    text={featureConfig.badge.text}
                />
                <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
                    {featureConfig.title}
                </h2>
                <p className="text-muted-foreground text-center text-balance text-sm">
                    {featureConfig.description}
                </p>
            </SectionHeader>

            <motion.div
                ref={ref}
                initial={{ opacity: 0, y: 24 }}
                animate={inView ? { opacity: 1, y: 0 } : {}}
                transition={{ type: "spring", stiffness: 100, damping: 20 }}
                className="grid grid-cols-1 md:grid-cols-2 gap-0 md:gap-12 px-6 py-8 md:px-12 md:py-16"
            >
                {/* Left: Feature list */}
                <div className="flex flex-col">
                    {features.map((feature) => {
                        const isActive = active === feature.id;
                        return (
                            <button
                                key={feature.id}
                                type="button"
                                onClick={() => setActive(feature.id)}
                                className={cn(
                                    "text-left py-4 md:py-5 border-b border-border transition-colors duration-200 group cursor-pointer",
                                    "first:border-t",
                                )}
                            >
                                <div className="flex items-start gap-3 md:gap-4">
                                    <span
                                        className={cn(
                                            "text-xs font-mono mt-1 transition-colors duration-200",
                                            isActive
                                                ? "text-primary"
                                                : "text-muted-foreground",
                                        )}
                                    >
                                        {feature.number}
                                    </span>
                                    <div className="min-w-0">
                                        <h3
                                            className={cn(
                                                "text-base md:text-lg font-medium transition-colors duration-200",
                                                isActive
                                                    ? "text-foreground"
                                                    : "text-muted-foreground group-hover:text-foreground",
                                            )}
                                        >
                                            {feature.title}
                                        </h3>
                                        <div
                                            className={cn(
                                                "grid transition-[grid-template-rows] duration-200 ease-in-out",
                                                isActive
                                                    ? "grid-rows-[1fr]"
                                                    : "grid-rows-[0fr]",
                                            )}
                                        >
                                            <p className="text-sm text-muted-foreground mt-2 leading-relaxed overflow-hidden">
                                                {feature.description}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </button>
                        );
                    })}
                </div>

                {/* Right: Visual panel — fixed height to prevent scroll jumps */}
                <div className="mt-8 md:mt-0 relative min-h-[360px] md:min-h-[420px]">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={active}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -12 }}
                            transition={{ duration: 0.25 }}
                            className="absolute inset-x-0 top-0"
                        >
                            <ActiveVisual />
                        </motion.div>
                    </AnimatePresence>
                </div>
            </motion.div>
        </section>
    );
}
