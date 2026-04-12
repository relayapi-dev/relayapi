import { useRef, useState, useEffect, useMemo, memo } from "react";
import { motion, AnimatePresence, useInView } from "motion/react";
import { Check, Loader2, Link2 } from "lucide-react";
import { cn } from "../../../lib/utils";

type AccountStatus = "idle" | "connecting" | "connected";

type PlatformAccount = {
    name: string;
    icon: string;
    handle: string;
    delay: number;
};

const ACCOUNTS: PlatformAccount[] = [
    { name: "Twitter/X", icon: "𝕏", handle: "@relay", delay: 0.2 },
    { name: "LinkedIn", icon: "in", handle: "Relay", delay: 0.6 },
    { name: "Instagram", icon: "◻", handle: "@relay.api", delay: 1.0 },
    { name: "TikTok", icon: "♪", handle: "@relay", delay: 1.4 },
];

const springTransition = {
    type: "spring" as const,
    stiffness: 100,
    damping: 20,
};

export function PlatformConnectBlock() {
    const blockRef = useRef<HTMLDivElement>(null);
    const inView = useInView(blockRef, { amount: 0.8, margin: "40px 0px -40px 0px" });
    const [connectedCount, setConnectedCount] = useState(0);
    const timerRef = useRef<NodeJS.Timeout[]>([]);

    useEffect(() => {
        timerRef.current.forEach(clearTimeout);
        timerRef.current = [];

        if (!inView) {
            setConnectedCount(0);
            return;
        }

        ACCOUNTS.forEach((account, index) => {
            const timer = setTimeout(
                () => setConnectedCount(index + 1),
                account.delay * 1000 + 400
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
            className="relative min-h-[400px] md:min-h-[500px] flex items-center justify-center p-6 md:p-12 overflow-visible"
        >
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={springTransition}
                className="w-full max-w-lg bg-card rounded-xl border border-border overflow-hidden"
            >
                {/* Header */}
                <div className="bg-muted px-4 py-3 flex items-center justify-between border-b border-border">
                    <div className="flex items-center gap-2">
                        <Link2 className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium text-foreground">Connect Accounts</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {connectedCount}/{ACCOUNTS.length} connected
                    </span>
                </div>

                {/* Account list */}
                <div className="divide-y divide-border">
                    {ACCOUNTS.map((account, index) => {
                        const status: AccountStatus =
                            index < connectedCount
                                ? "connected"
                                : index === connectedCount && inView
                                    ? "connecting"
                                    : "idle";

                        return (
                            <AccountRow
                                key={account.name}
                                account={account}
                                status={status}
                            />
                        );
                    })}
                </div>

                {/* Footer */}
                <AnimatePresence>
                    {connectedCount === ACCOUNTS.length && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            transition={{ duration: 0.3, delay: 0.3 }}
                            className="border-t border-border px-4 py-3 bg-emerald-500/5"
                        >
                            <div className="flex items-center gap-2 text-emerald-400">
                                <Check className="size-4" />
                                <span className="text-sm font-medium">All accounts connected — ready to publish</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    );
}

const AccountRow = memo(function AccountRow({
    account,
    status,
}: {
    account: PlatformAccount;
    status: AccountStatus;
}) {
    return (
        <div className="flex items-center justify-between px-4 py-3.5">
            <div className="flex items-center gap-3">
                <div className="size-8 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0">
                    <span className="text-xs">{account.icon}</span>
                </div>
                <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">{account.name}</span>
                    <span className="text-xs text-muted-foreground">{account.handle}</span>
                </div>
            </div>

            <AnimatePresence mode="wait">
                <motion.div
                    key={status}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.2 }}
                >
                    {status === "connected" && (
                        <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1">
                            <Check className="size-3 text-emerald-400" />
                            <span className="text-xs font-medium text-emerald-400">Connected</span>
                        </div>
                    )}
                    {status === "connecting" && (
                        <div className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1">
                            <Loader2 className="size-3 text-sky-400 animate-spin" />
                            <span className="text-xs font-medium text-sky-400">Connecting</span>
                        </div>
                    )}
                    {status === "idle" && (
                        <button className={cn(
                            "rounded-full px-3 py-1 text-xs font-medium",
                            "bg-white/[0.06] border border-white/[0.08] text-muted-foreground",
                            "hover:bg-white/[0.1] transition-colors"
                        )}>
                            Connect
                        </button>
                    )}
                </motion.div>
            </AnimatePresence>
        </div>
    );
});
