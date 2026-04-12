"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";

const PLATFORMS = [
    { name: "Twitter/X", icon: "𝕏" },
    { name: "Instagram", icon: "◻" },
    { name: "LinkedIn", icon: "in" },
    { name: "TikTok", icon: "♪" },
    { name: "Facebook", icon: "f" },
    { name: "YouTube", icon: "▶" },
    { name: "Reddit", icon: "r" },
    { name: "Pinterest", icon: "P" },
    { name: "Bluesky", icon: "🦋" },
    { name: "Threads", icon: "@" },
    { name: "Telegram", icon: "✈" },
    { name: "Snapchat", icon: "👻" },
];

const PROMPT_TEXT = "Announce our new unified API — post to every social platform in one call. Make it exciting!";

export function PromptSection() {
    const [displayedText, setDisplayedText] = useState("");
    const [phase, setPhase] = useState<"idle" | "typing" | "sending" | "results">("idle");
    const [cursorVisible, setCursorVisible] = useState(true);
    const hasStarted = useRef(false);
    const sectionRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const id = setInterval(() => setCursorVisible((v) => !v), 530);
        return () => clearInterval(id);
    }, []);

    const startAnimation = useCallback(() => {
        setPhase("typing");
        let i = 0;
        const typeInterval = setInterval(() => {
            if (i < PROMPT_TEXT.length) {
                setDisplayedText(PROMPT_TEXT.slice(0, i + 1));
                i++;
            } else {
                clearInterval(typeInterval);
                setTimeout(() => setPhase("sending"), 500);
                setTimeout(() => setPhase("results"), 1600);
            }
        }, 25);
    }, []);

    useEffect(() => {
        const el = sectionRef.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (entry?.isIntersecting && !hasStarted.current) {
                    hasStarted.current = true;
                    startAnimation();
                }
            },
            { threshold: 0.5 }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [startAnimation]);

    return (
        <div ref={sectionRef} className="relative w-full px-4 pt-10 pb-16 md:pb-24">
            <div className="relative z-10 max-w-2xl mx-auto">
                {/* Prompt input */}
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm overflow-hidden shadow-2xl shadow-sky-500/5">
                    {/* Input area */}
                    <div className="p-4 min-h-[60px]">
                        <p className="text-sm text-foreground/80 leading-relaxed">
                            {phase === "idle" && (
                                <span className="text-muted-foreground/50">What would you like to publish?</span>
                            )}
                            {phase !== "idle" && displayedText}
                            <span
                                className={`inline-block w-[2px] h-4 bg-sky-400 ml-0.5 align-middle transition-opacity ${
                                    cursorVisible && (phase === "typing" || phase === "idle")
                                        ? "opacity-100"
                                        : "opacity-0"
                                }`}
                            />
                        </p>
                    </div>

                    {/* Bottom bar */}
                    <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.06]">
                        <div className="flex items-center gap-1 overflow-hidden">
                            {PLATFORMS.map((p, i) => (
                                <motion.div
                                    key={p.name}
                                    initial={{ opacity: 0, scale: 0 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{ delay: 0.3 + i * 0.04, type: "spring", stiffness: 300, damping: 20 }}
                                    title={p.name}
                                    className="size-6 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0"
                                >
                                    <span className="text-[9px] leading-none">{p.icon}</span>
                                </motion.div>
                            ))}
                        </div>
                        <motion.div
                            animate={
                                phase === "sending"
                                    ? { scale: [1, 0.95, 1], opacity: [1, 0.7, 1] }
                                    : {}
                            }
                            transition={phase === "sending" ? { repeat: Infinity, duration: 0.8 } : {}}
                            className={`ml-3 shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                phase === "results"
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : phase === "sending"
                                    ? "bg-sky-500/30 text-sky-300"
                                    : "bg-sky-500/20 text-sky-400"
                            }`}
                        >
                            {phase === "results" ? "Sent ✓" : phase === "sending" ? "Publishing..." : "Publish all"}
                        </motion.div>
                    </div>
                </div>

                {/* Fan-out animation */}
                <AnimatePresence>
                    {phase === "results" && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.4 }}
                            className="mt-6"
                        >
                            <div className="flex flex-wrap justify-center gap-2">
                                {PLATFORMS.map((p, i) => (
                                    <motion.div
                                        key={p.name}
                                        initial={{ opacity: 0, y: 20, scale: 0.8 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        transition={{
                                            delay: i * 0.08,
                                            type: "spring",
                                            stiffness: 260,
                                            damping: 20,
                                        }}
                                        className="flex items-center gap-1.5 rounded-full bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm px-3 py-1.5"
                                    >
                                        <span className="text-xs">{p.icon}</span>
                                        <span className="text-xs text-foreground/60">{p.name}</span>
                                        <motion.span
                                            initial={{ opacity: 0, scale: 0 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            transition={{ delay: i * 0.08 + 0.3, type: "spring" }}
                                            className="text-emerald-400 text-[10px]"
                                        >
                                            ✓
                                        </motion.span>
                                    </motion.div>
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}
