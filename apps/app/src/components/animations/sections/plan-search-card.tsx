import { Plus, Globe, List, ChevronUp } from "lucide-react";
import { Button } from "../../ui/button";
import { cn } from "../../../lib/utils";
import { TypingAnimation } from "../../ui/typing-animation";
import { ConnectionStatusIndicator, type ConnectionStatus } from "./connection-status-indicator";
import { IntegrationsPopover } from "./integrations-popover";

type PlanSearchCardProps = {
    rootRef?: React.RefObject<HTMLDivElement | null> | null;
    status: ConnectionStatus;
    showDialog: boolean;
    showTyping: boolean;
    popoverPosition?: "top" | "bottom";
};

export function PlanSearchCard({ rootRef, status, showDialog, showTyping, popoverPosition = "top" }: PlanSearchCardProps) {
    return (
        <div
            ref={rootRef || undefined}
            className="w-full rounded-2xl h-36 px-6 py-6 flex flex-col justify-between border border-border relative"
        >
            <ConnectionStatusIndicator status={status} />

            {showTyping ? (
                <TypingAnimation words={["Publish announcement to all platforms", "with image and hashtags", "schedule for 9am tomorrow"]} loop className="text-sm font-medium" />
            ) : (
                <p className="text-sm font-medium">Compose, publish</p>
            )}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <button className="p-2 hover:bg-muted rounded-lg transition-colors">
                        <Plus className="size-5" />
                    </button>
                    <button className="p-2 hover:bg-muted rounded-lg transition-colors">
                        <Globe className="size-5" />
                    </button>

                    <div className="relative">
                        <IntegrationsPopover open={showDialog} position={popoverPosition} />
                        <button
                            className={cn(
                                "flex items-center gap-2 w-fit h-9 px-2 rounded-3xl border border-transparent transition-colors",
                                showDialog && "bg-muted border border-border"
                            )}
                        >
                            <List className="size-3.5" />
                            <span className="text-sm">Platforms</span>
                        </button>
                    </div>
                </div>

                <Button variant="default" size="icon" className="rounded-full">
                    <ChevronUp className="size-5" />
                </Button>
            </div>
        </div>
    );
}

