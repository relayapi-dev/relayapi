import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  platformColors,
  platformLabels,
  platformDescriptions,
  platformConnectionType,
} from "@/lib/platform-maps";
import { platformIcons } from "@/lib/platform-icons";
import { useUser } from "@/components/dashboard/user-context";
import { BlueskyDialog } from "./bluesky-dialog";
import { TelegramDialog } from "./telegram-dialog";
import { InstagramDialog } from "./instagram-dialog";
import { OnDemandDialog } from "./on-demand-dialog";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.02 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.1, ease: [0.32, 0.72, 0, 1] as const } },
};

const PLATFORMS = [
  "instagram", "facebook", "linkedin",
  "youtube", "tiktok", "pinterest", "reddit",
  "threads", "snapchat", "googlebusiness", "mastodon",
  "bluesky", "telegram",
  "discord", "whatsapp", "sms", "twitter",
];

interface PlatformGridProps {
  onConnected: () => void;
}

export function PlatformGrid({ onConnected }: PlatformGridProps) {
  const user = useUser();
  const [blueskyOpen, setBlueskyOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [instagramOpen, setInstagramOpen] = useState(false);
  const [onDemandOpen, setOnDemandOpen] = useState(false);
  const [onDemandPlatform, setOnDemandPlatform] = useState("");

  const handleClick = (platform: string) => {
    const type = platformConnectionType[platform];
    if (type === "coming_soon") {
      setOnDemandPlatform(platform);
      setOnDemandOpen(true);
      return;
    }
    if (type === "dialog" && platform === "instagram") {
      setInstagramOpen(true);
      return;
    }
    if (type === "credentials" && platform === "bluesky") {
      setBlueskyOpen(true);
      return;
    }
    if (type === "bot" && platform === "telegram") {
      setTelegramOpen(true);
      return;
    }
  };

  return (
    <>
      <motion.div
        className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
        variants={stagger}
        initial="hidden"
        animate="visible"
      >
        {PLATFORMS.map((platform) => {
          const type = platformConnectionType[platform];
          const isComingSoon = type === "coming_soon";
          const isOAuth = type === "oauth";
          const label = platformLabels[platform] || platform;
          const description = platformDescriptions[platform] || "";
          const icon = platformIcons[platform];
          const color = platformColors[platform] || "bg-neutral-700";

          const card = (
            <motion.div
              key={platform}
              variants={fadeUp}
              className={cn(
                "group relative rounded-md border border-border p-4 transition-colors",
                isComingSoon
                  ? "opacity-50 hover:opacity-70 cursor-pointer"
                  : "hover:bg-accent/20 cursor-pointer",
              )}
              onClick={!isOAuth ? () => handleClick(platform) : undefined}
            >
              <div className="flex items-start justify-between">
                <div className={cn("flex size-9 items-center justify-center rounded-md text-white", color)}>
                  {icon}
                </div>
                {isComingSoon ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    On demand
                  </span>
                ) : (
                  <ArrowRight className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                )}
              </div>
              <div className="mt-3">
                <h3 className="text-sm font-medium">{label}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
              </div>
            </motion.div>
          );

          if (isOAuth) {
            return (
              <a key={platform} href={`/app/connect/start/${platform}`} className="no-underline text-inherit">
                {card}
              </a>
            );
          }

          return card;
        })}
      </motion.div>

      <InstagramDialog
        open={instagramOpen}
        onOpenChange={setInstagramOpen}
      />
      <BlueskyDialog
        open={blueskyOpen}
        onOpenChange={setBlueskyOpen}
        onConnected={onConnected}
      />
      <TelegramDialog
        open={telegramOpen}
        onOpenChange={setTelegramOpen}
        onConnected={onConnected}
      />
      <OnDemandDialog
        open={onDemandOpen}
        onOpenChange={setOnDemandOpen}
        platform={onDemandPlatform}
        userName={user?.name}
        userEmail={user?.email}
      />
    </>
  );
}
