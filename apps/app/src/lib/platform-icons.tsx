import type { ReactNode } from "react";
import {
  siX,
  siInstagram,
  siFacebook,
  siYoutube,
  siTiktok,
  siPinterest,
  siReddit,
  siThreads,
  siSnapchat,
  siMastodon,
  siBluesky,
  siTelegram,
  siDiscord,
  siWhatsapp,
} from "simple-icons";

function SiIcon({ icon }: { icon: { path: string } }) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="size-4">
      <path d={icon.path} />
    </svg>
  );
}

function Svg({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
      <path d={d} />
    </svg>
  );
}

export const platformIcons: Record<string, ReactNode> = {
  twitter: <SiIcon icon={siX} />,
  instagram: <SiIcon icon={siInstagram} />,
  facebook: <SiIcon icon={siFacebook} />,
  linkedin: (
    <Svg d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  ),
  youtube: <SiIcon icon={siYoutube} />,
  tiktok: <SiIcon icon={siTiktok} />,
  pinterest: <SiIcon icon={siPinterest} />,
  reddit: <SiIcon icon={siReddit} />,
  threads: <SiIcon icon={siThreads} />,
  snapchat: <SiIcon icon={siSnapchat} />,
  googlebusiness: (
    <Svg d="M3.273 1.636c-.736 0-1.363.492-1.568 1.16L0 9.272c0 1.664 1.336 3 3 3a3 3 0 003-3c0 1.664 1.336 3 3 3a3 3 0 003-3c0 1.65 1.35 3 3 3 1.664 0 3-1.336 3-3 0 1.664 1.336 3 3 3s3-1.336 3-3l-1.705-6.476a1.646 1.646 0 00-1.568-1.16zm8.729 9.326c-.604 1.063-1.703 1.81-3.002 1.81-1.304 0-2.398-.747-3-1.806-.604 1.06-1.702 1.806-3 1.806-.484 0-.944-.1-1.363-.277v8.232c0 .9.736 1.637 1.636 1.637h17.454c.9 0 1.636-.737 1.636-1.637v-8.232a3.48 3.48 0 01-1.363.277c-1.304 0-2.398-.746-3-1.804-.602 1.058-1.696 1.804-3 1.804-1.299 0-2.394-.75-2.998-1.81zm5.725 3.765c.808 0 1.488.298 2.007.782l-.859.859a1.623 1.623 0 00-1.148-.447c-.98 0-1.772.827-1.772 1.806 0 .98.792 1.807 1.772 1.807.882 0 1.485-.501 1.615-1.191h-1.615v-1.16h2.826c.035.196.054.4.054.613 0 1.714-1.147 2.931-2.88 2.931a3 3 0 010-6z" />
  ),
  mastodon: <SiIcon icon={siMastodon} />,
  bluesky: <SiIcon icon={siBluesky} />,
  telegram: <SiIcon icon={siTelegram} />,
  discord: <SiIcon icon={siDiscord} />,
  whatsapp: <SiIcon icon={siWhatsapp} />,
  sms: (
    <Svg d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12zM7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z" />
  ),
};
