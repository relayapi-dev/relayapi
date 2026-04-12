import { useRef, useState, useEffect, useMemo, memo } from "react";
import { motion, AnimatePresence, useInView } from "motion/react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "../../../lib/utils";

type RequestStatus = "idle" | "composing" | "sending" | "delivered";

const STATUS_SEQUENCE: Array<{ status: RequestStatus; delay: number }> = [
    { status: "composing", delay: 400 },
    { status: "sending", delay: 1800 },
    { status: "delivered", delay: 1200 },
] as const;

const PLATFORMS = [
    { name: "Twitter/X", char: "𝕏", delay: 0.3 },
    { name: "LinkedIn", char: "in", delay: 0.5 },
    { name: "Instagram", char: "◻", delay: 0.7 },
    { name: "TikTok", char: "♪", delay: 0.9 },
    { name: "Facebook", char: "f", delay: 1.1 },
];

const springTransition = {
    type: "spring" as const,
    stiffness: 100,
    damping: 20,
};

export function ApiRequestBlock() {
    const blockRef = useRef<HTMLDivElement>(null);
    const inView = useInView(blockRef, { amount: 0.8, margin: "40px 0px -40px 0px" });
    const [status, setStatus] = useState<RequestStatus>("idle");
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const sequenceIndexRef = useRef(0);

    useEffect(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }

        if (!inView) {
            timerRef.current = setTimeout(() => setStatus("idle"), 0);
            sequenceIndexRef.current = 0;
            return;
        }

        sequenceIndexRef.current = 0;

        const runSequence = () => {
            if (sequenceIndexRef.current >= STATUS_SEQUENCE.length) return;

            const step = STATUS_SEQUENCE[sequenceIndexRef.current];
            if (!step) return;
            sequenceIndexRef.current += 1;

            timerRef.current = setTimeout(() => {
                setStatus(step.status);
                if (sequenceIndexRef.current < STATUS_SEQUENCE.length) {
                    runSequence();
                }
            }, step.delay);
        };

        runSequence();

        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            sequenceIndexRef.current = 0;
        };
    }, [inView]);

    return (
        <div
            ref={blockRef}
            className="relative min-h-[400px] md:min-h-[500px] flex items-center justify-center p-6 md:p-12 overflow-visible"
        >
            <div className="w-full max-w-lg space-y-4">
                {/* Request card */}
                <RequestCard status={status} />

                {/* Platform delivery indicators */}
                <AnimatePresence>
                    {(status === "sending" || status === "delivered") && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 10 }}
                            transition={springTransition}
                            className="space-y-2"
                        >
                            {PLATFORMS.map((platform) => (
                                <PlatformRow
                                    key={platform.name}
                                    platform={platform}
                                    delivered={status === "delivered"}
                                />
                            ))}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}

const RequestCard = memo(function RequestCard({ status }: { status: RequestStatus }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={springTransition}
            className="w-full bg-card rounded-xl border border-border overflow-hidden"
        >
            {/* Header */}
            <div className="bg-muted px-4 py-3 flex items-center justify-between border-b border-border">
                <div className="flex items-center gap-2">
                    <div className="flex gap-2">
                        <div className="w-3 h-3 rounded-full bg-red-500" />
                        <div className="w-3 h-3 rounded-full bg-yellow-500" />
                        <div className="w-3 h-3 rounded-full bg-green-500" />
                    </div>
                    <span className="text-xs text-muted-foreground ml-2">POST /v1/posts</span>
                </div>
                <StatusBadge status={status} />
            </div>

            {/* Body */}
            <div className="bg-background p-4 md:p-6 font-mono text-xs md:text-sm">
                <div className="space-y-1 text-foreground">
                    <div className="text-muted-foreground">{"{"}</div>
                    <div className="pl-4">
                        <span className="text-primary">"text"</span>
                        <span className="text-muted-foreground">: </span>
                        <span className="text-emerald-400">"Launching our new API! 🚀"</span>
                        <span className="text-muted-foreground">,</span>
                    </div>
                    <div className="pl-4">
                        <span className="text-primary">"platforms"</span>
                        <span className="text-muted-foreground">: </span>
                        <span className="text-amber-400">["twitter", "linkedin", "instagram"]</span>
                        <span className="text-muted-foreground">,</span>
                    </div>
                    <div className="pl-4">
                        <span className="text-primary">"media"</span>
                        <span className="text-muted-foreground">: </span>
                        <span className="text-amber-400">["med_abc123"]</span>
                    </div>
                    <div className="text-muted-foreground">{"}"}</div>
                </div>
            </div>
        </motion.div>
    );
});

const StatusBadge = memo(function StatusBadge({ status }: { status: RequestStatus }) {
    if (status === "idle") return null;

    return (
        <AnimatePresence mode="wait">
            <motion.div
                key={status}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className={cn(
                    "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                    status === "delivered"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-sky-500/20 text-sky-400"
                )}
            >
                {status === "delivered" ? (
                    <Check className="size-3" />
                ) : (
                    <Loader2 className="size-3 animate-spin" />
                )}
                {status === "composing" && "Composing"}
                {status === "sending" && "Publishing..."}
                {status === "delivered" && "Delivered"}
            </motion.div>
        </AnimatePresence>
    );
});

const PlatformRow = memo(function PlatformRow({
    platform,
    delivered,
}: {
    platform: { name: string; char: string; delay: number };
    delivered: boolean;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...springTransition, delay: platform.delay * 0.4 }}
            className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-card border border-border"
        >
            <div className="flex items-center gap-3">
                <div className="size-7 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center">
                    <span className="text-[10px]">{platform.char}</span>
                </div>
                <span className="text-sm text-foreground">{platform.name}</span>
            </div>
            <AnimatePresence mode="wait">
                {delivered ? (
                    <motion.div
                        initial={{ opacity: 0, scale: 0 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: platform.delay * 0.3, type: "spring" }}
                        className="flex items-center gap-1.5 text-emerald-400"
                    >
                        <Check className="size-3.5" />
                        <span className="text-xs font-medium">Delivered</span>
                    </motion.div>
                ) : (
                    <motion.div className="flex items-center gap-1.5 text-sky-400">
                        <Loader2 className="size-3.5 animate-spin" />
                        <span className="text-xs font-medium">Sending</span>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
});
