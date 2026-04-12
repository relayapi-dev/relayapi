import { useRef, useState, useEffect, memo } from "react";
import { motion, AnimatePresence, useInView } from "motion/react";
import { Check, Bell, ArrowRight } from "lucide-react";
import { cn } from "../../../lib/utils";

type WebhookEvent = {
    id: string;
    platform: string;
    icon: string;
    event: string;
    status: "delivered" | "engagement";
    detail: string;
    delay: number;
};

const WEBHOOK_EVENTS: WebhookEvent[] = [
    {
        id: "1",
        platform: "Twitter/X",
        icon: "𝕏",
        event: "post.published",
        status: "delivered",
        detail: "post_7kx • 200 OK",
        delay: 0.3,
    },
    {
        id: "2",
        platform: "LinkedIn",
        icon: "in",
        event: "post.published",
        status: "delivered",
        detail: "post_7kx • 200 OK",
        delay: 0.8,
    },
    {
        id: "3",
        platform: "Instagram",
        icon: "◻",
        event: "post.published",
        status: "delivered",
        detail: "post_7kx • 200 OK",
        delay: 1.3,
    },
    {
        id: "4",
        platform: "Twitter/X",
        icon: "𝕏",
        event: "post.engagement",
        status: "engagement",
        detail: "12 likes • 3 retweets",
        delay: 2.0,
    },
    {
        id: "5",
        platform: "LinkedIn",
        icon: "in",
        event: "post.engagement",
        status: "engagement",
        detail: "8 reactions • 2 comments",
        delay: 2.5,
    },
];

const springTransition = {
    type: "spring" as const,
    stiffness: 100,
    damping: 20,
};

export function WebhookStreamBlock() {
    const blockRef = useRef<HTMLDivElement>(null);
    const inView = useInView(blockRef, { amount: 0.8, margin: "20px 0px -10px 0px" });
    const [visibleEvents, setVisibleEvents] = useState(0);
    const timerRef = useRef<NodeJS.Timeout[]>([]);

    useEffect(() => {
        timerRef.current.forEach(clearTimeout);
        timerRef.current = [];

        if (!inView) {
            const timer = setTimeout(() => setVisibleEvents(0), 0);
            timerRef.current.push(timer);
            return;
        }

        WEBHOOK_EVENTS.forEach((event, index) => {
            const timer = setTimeout(
                () => setVisibleEvents(index + 1),
                event.delay * 1000 + 400
            );
            timerRef.current.push(timer);
        });

        return () => {
            timerRef.current.forEach(clearTimeout);
            timerRef.current = [];
        };
    }, [inView]);

    return (
        <div
            ref={blockRef}
            className="relative min-h-[400px] md:min-h-[500px] flex p-6 md:p-12 overflow-visible"
        >
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={springTransition}
                className="w-full max-w-lg mx-auto bg-card rounded-xl border border-border overflow-hidden"
            >
                {/* Header */}
                <div className="bg-muted px-4 py-3 flex items-center justify-between border-b border-border">
                    <div className="flex items-center gap-2">
                        <Bell className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium text-foreground">Webhook Events</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <div className={cn(
                            "size-2 rounded-full",
                            visibleEvents > 0 ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/30"
                        )} />
                        <span className="text-xs text-muted-foreground">
                            {visibleEvents > 0 ? "Live" : "Waiting"}
                        </span>
                    </div>
                </div>

                {/* Event stream */}
                <div className="divide-y divide-border max-h-[350px] overflow-hidden">
                    <AnimatePresence>
                        {WEBHOOK_EVENTS.slice(0, visibleEvents).map((event) => (
                            <WebhookEventRow key={event.id} event={event} />
                        ))}
                    </AnimatePresence>

                    {visibleEvents === 0 && (
                        <div className="px-4 py-8 text-center">
                            <p className="text-sm text-muted-foreground/50">Waiting for events...</p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <AnimatePresence>
                    {visibleEvents >= WEBHOOK_EVENTS.length && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 0.3 }}
                            className="border-t border-border px-4 py-2.5 flex items-center justify-between"
                        >
                            <span className="text-xs text-muted-foreground">{visibleEvents} events received</span>
                            <div className="flex items-center gap-1 text-xs text-primary font-medium">
                                <span>View all</span>
                                <ArrowRight className="size-3" />
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    );
}

const WebhookEventRow = memo(function WebhookEventRow({ event }: { event: WebhookEvent }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: -10, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="flex items-center justify-between px-4 py-3"
        >
            <div className="flex items-center gap-3 min-w-0">
                <div className="size-7 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0">
                    <span className="text-[10px]">{event.icon}</span>
                </div>
                <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-foreground">{event.event}</span>
                        <span className={cn(
                            "text-[10px] font-medium px-1.5 py-0.5 rounded",
                            event.status === "delivered"
                                ? "bg-emerald-500/10 text-emerald-400"
                                : "bg-amber-500/10 text-amber-400"
                        )}>
                            {event.status === "delivered" ? "200" : "event"}
                        </span>
                    </div>
                    <span className="text-[11px] text-muted-foreground">{event.detail}</span>
                </div>
            </div>

            <motion.div
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.2, type: "spring" }}
            >
                <Check className="size-3.5 text-emerald-400 shrink-0" />
            </motion.div>
        </motion.div>
    );
});
