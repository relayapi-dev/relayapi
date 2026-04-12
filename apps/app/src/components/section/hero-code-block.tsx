import { useState } from "react";

const INSTALL_TABS = [
    { id: "openclaw", label: "OpenClaw Skill", command: "openclaw skills install relayapi" },
    { id: "claude", label: "Claude Plugin", command: "/plugin install relayapi" },
] as const;

export function HeroCodeBlock() {
    const [activeTab, setActiveTab] = useState<string>("openclaw");
    const [copied, setCopied] = useState(false);

    const activeCommand = INSTALL_TABS.find((t) => t.id === activeTab)!.command;

    const handleCopy = () => {
        navigator.clipboard.writeText(activeCommand);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="relative w-full px-4 pt-8 pb-16 md:pb-24">
            <div className="relative z-10 max-w-xl mx-auto">
                <div className="rounded-2xl overflow-hidden shadow-xl shadow-black/10 border border-zinc-800/50">
                    {/* macOS window chrome with tabs */}
                    <div className="flex items-center justify-between px-4 py-3 bg-[#1a1a2e] border-b border-zinc-700/50">
                        <div className="flex items-center gap-2">
                            <div className="size-3 rounded-full bg-[#ff5f57]" />
                            <div className="size-3 rounded-full bg-[#febc2e]" />
                            <div className="size-3 rounded-full bg-[#28c840]" />
                        </div>
                        <div className="flex items-center gap-1">
                            {INSTALL_TABS.map((tab) => (
                                <button
                                    key={tab.id}
                                    onClick={() => {
                                        setActiveTab(tab.id);
                                        setCopied(false);
                                    }}
                                    className={`px-3 py-1 rounded-md text-[11px] sm:text-xs font-medium transition-colors ${
                                        activeTab === tab.id
                                            ? "text-zinc-200 bg-white/10"
                                            : "text-zinc-500 hover:text-zinc-300"
                                    }`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Command area */}
                    <div className="bg-[#1a1a2e] px-3 sm:px-5 py-4 flex items-center gap-2">
                        <span className="text-teal-400 font-mono select-none">$</span>
                        <code className="text-zinc-200 font-mono text-sm sm:text-base flex-1">
                            {activeCommand}
                        </code>
                        <button
                            onClick={handleCopy}
                            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors shrink-0"
                            aria-label="Copy command"
                        >
                            {copied ? (
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="size-4 text-emerald-400"
                                >
                                    <path d="M20 6 9 17l-5-5" />
                                </svg>
                            ) : (
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="size-4"
                                >
                                    <rect width="14" height="14" x="8" y="8" rx="2" />
                                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                                </svg>
                            )}
                        </button>
                    </div>
                </div>
                <p className="text-center text-zinc-500 text-xs mt-3">
                    Also available for Cursor and Codex
                </p>
            </div>
        </div>
    );
}
