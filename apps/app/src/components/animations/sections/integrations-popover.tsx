import { Search } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Icons } from "../../icons";

const integrations = [
    { name: "Twitter/X", icon: Icons.figma, installed: true, visible: true },
    { name: "Instagram", icon: Icons.shadcn, installed: true, visible: true },
    { name: "LinkedIn", icon: Icons.nextjs, installed: true, visible: true },
    { name: "TikTok", icon: Icons.tailwind, installed: false, visible: true },
];

export function IntegrationsPopover({ open, position = "bottom" }: { open: boolean; position?: "top" | "bottom" }) {
    const positionClasses = position === "top"
        ? "bottom-full mb-2"
        : "top-full mt-2";

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0, y: position === "top" ? 10 : -10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: position === "top" ? 10 : -10, scale: 0.95 }}
                    transition={{ duration: 0.2 }}
                    className={`absolute ${positionClasses} left-1/2 -translate-x-1/2 md:left-4 md:translate-x-0 overflow-hidden rounded-3xl w-[280px] md:w-[350px] bg-linear-to-b from-[#27272A] to-[#27272A]/40 text-secondary-foreground text-sm font-medium backdrop-blur-xl backdrop-saturate-150 shadow-badge z-50`}
                >
                    <div className="flex flex-col divide-y divide-white/10">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                            <input
                                type="text"
                                placeholder="Search platforms"
                                className="w-full pl-10 pr-4 py-2.5 bg-transparent border-none text-sm text-foreground placeholder:text-muted-foreground pointer-events-none h-14"
                            />
                        </div>
                        {integrations.map((integration) => {
                            const Icon = integration.icon;
                            return (
                                <div
                                    key={integration.name}
                                    className={`flex items-center gap-3 px-3 py-2.5 hover:bg-white/10 transition-colors cursor-pointer last:border-b-0 ${!integration.visible ? "hidden md:flex" : ""}`}
                                >
                                    <div
                                        className="size-8 flex items-center justify-center shrink-0"
                                    >
                                        <Icon
                                            className="size-6"
                                        />
                                    </div>
                                    <span className="text-sm font-medium text-foreground flex-1">
                                        {integration.name}
                                    </span>
                                    {integration.installed && (
                                        <span className="text-xs text-primary font-medium bg-primary/10 rounded-lg px-2 py-1">
                                            Connected
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

