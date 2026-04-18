import { RootProvider } from "fumadocs-ui/provider/next";
import { Inter } from "next/font/google";
import "./global.css";
import type { ReactNode } from "react";
import { FeedbackWidget } from "@/components/feedback-widget";

const inter = Inter({ subsets: ["latin"] });
const metadataBase = new URL(
  process.env.NEXT_PUBLIC_SITE_URL || "https://docs.relayapi.dev",
);

export const metadata = {
  title: "RelayAPI Docs",
  description: "Documentation for the RelayAPI unified social media API",
  metadataBase,
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "RelayAPI Docs",
    description: "Documentation for the RelayAPI unified social media API",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image" as const,
    title: "RelayAPI Docs",
    description: "Documentation for the RelayAPI unified social media API",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body>
        <RootProvider
          theme={{
            defaultTheme: "dark",
          }}
        >
          {children}
          <FeedbackWidget />
        </RootProvider>
      </body>
    </html>
  );
}
