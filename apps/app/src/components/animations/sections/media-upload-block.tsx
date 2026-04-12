import { useRef, useState, useEffect, memo } from "react";
import { motion, AnimatePresence, useInView } from "motion/react";
import { Check, Image, Loader2 } from "lucide-react";
import { cn } from "../../../lib/utils";

type ResizeStatus = "idle" | "uploading" | "resizing" | "done";

const PLATFORM_SPECS = [
    { name: "Twitter/X", icon: "𝕏", size: "1200×675", ratio: "16:9", delay: 0.2 },
    { name: "Instagram", icon: "◻", size: "1080×1080", ratio: "1:1", delay: 0.5 },
    { name: "LinkedIn", icon: "in", size: "1200×627", ratio: "1.91:1", delay: 0.8 },
    { name: "TikTok", icon: "♪", size: "1080×1920", ratio: "9:16", delay: 1.1 },
];

const STATUS_SEQUENCE: Array<{ status: ResizeStatus; delay: number }> = [
    { status: "uploading", delay: 400 },
    { status: "resizing", delay: 1200 },
    { status: "done", delay: 1800 },
];

const springTransition = {
    type: "spring" as const,
    stiffness: 100,
    damping: 20,
};

export function MediaUploadBlock() {
    const blockRef = useRef<HTMLDivElement>(null);
    const inView = useInView(blockRef, { amount: 0.8, margin: "40px 0px -40px 0px" });
    const [status, setStatus] = useState<ResizeStatus>("idle");
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
                {/* Upload card */}
                <UploadCard status={status} />

                {/* Platform resize results */}
                <AnimatePresence>
                    {(status === "resizing" || status === "done") && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 10 }}
                            transition={springTransition}
                            className="grid grid-cols-2 gap-2"
                        >
                            {PLATFORM_SPECS.map((spec) => (
                                <ResizeCard
                                    key={spec.name}
                                    spec={spec}
                                    done={status === "done"}
                                />
                            ))}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}

const UploadCard = memo(function UploadCard({ status }: { status: ResizeStatus }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={springTransition}
            className="w-full bg-card rounded-xl border border-border overflow-hidden"
        >
            <div className="bg-muted px-4 py-3 flex items-center justify-between border-b border-border">
                <div className="flex items-center gap-2">
                    <Image className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">Media Upload</span>
                </div>
                <AnimatePresence mode="wait">
                    <motion.div
                        key={status}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        className={cn(
                            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                            status === "done"
                                ? "bg-emerald-500/20 text-emerald-400"
                                : status !== "idle"
                                    ? "bg-sky-500/20 text-sky-400"
                                    : "hidden"
                        )}
                    >
                        {status === "done" ? (
                            <Check className="size-3" />
                        ) : (
                            <Loader2 className="size-3 animate-spin" />
                        )}
                        {status === "uploading" && "Uploading"}
                        {status === "resizing" && "Resizing"}
                        {status === "done" && "Ready"}
                    </motion.div>
                </AnimatePresence>
            </div>

            <div className="p-4 md:p-5">
                <div className="flex items-center gap-4">
                    {/* Thumbnail placeholder */}
                    <div className="w-16 h-16 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center shrink-0">
                        <Image className="size-6 text-muted-foreground/40" />
                    </div>
                    <div className="flex flex-col gap-1 min-w-0">
                        <span className="text-sm font-medium text-foreground truncate">product-launch.png</span>
                        <span className="text-xs text-muted-foreground">2.4 MB • 2400×1600 • PNG</span>

                        {/* Progress bar */}
                        <AnimatePresence>
                            {status !== "idle" && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden mt-1"
                                >
                                    <motion.div
                                        initial={{ width: "0%" }}
                                        animate={{
                                            width: status === "done" ? "100%" : status === "resizing" ? "70%" : "30%",
                                        }}
                                        transition={{ duration: 0.8, ease: "easeOut" }}
                                        className={cn(
                                            "h-full rounded-full",
                                            status === "done" ? "bg-emerald-400" : "bg-sky-400"
                                        )}
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
            </div>
        </motion.div>
    );
});

const ResizeCard = memo(function ResizeCard({
    spec,
    done,
}: {
    spec: { name: string; icon: string; size: string; ratio: string; delay: number };
    done: boolean;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ ...springTransition, delay: spec.delay * 0.4 }}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-card border border-border"
        >
            <div className="size-6 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0">
                <span className="text-[9px]">{spec.icon}</span>
            </div>
            <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-foreground">{spec.name}</span>
                <span className="text-[10px] text-muted-foreground">{spec.size} • {spec.ratio}</span>
            </div>
            <AnimatePresence>
                {done && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: spec.delay * 0.3, type: "spring" }}
                        className="ml-auto"
                    >
                        <Check className="size-3.5 text-emerald-400" />
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
});
