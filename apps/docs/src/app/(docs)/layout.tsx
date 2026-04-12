import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import { SidebarFooter } from "@/components/sidebar-footer";

function RelayLogo() {
  return (
    <svg
      viewBox="0 0 150 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      width="32"
      height="32"
      style={{ minWidth: 32, minHeight: 32 }}
    >
      <path
        fillRule="evenodd"
        d="M34.82,18.54C16.52,18.54,1.49,33.56,1.49,51.87s15.02,33.33,33.33,33.33h80.69c6.95,0,12.28,5.33,12.28,12.28s-5.33,12.28-12.28,12.28H33.07c-5.77-.01-10.52,4.74-10.52,10.51s4.76,10.52,10.52,10.52h82.44c18.31,0,33.33-15.02,33.33-33.33s-15.02-33.33-33.33-33.33H34.82c-6.95,0-12.28-5.33-12.28-12.28s5.33-12.28,12.28-12.28h82.45c5.77.01,10.52-4.74,10.52-10.51s-4.76-10.52-10.52-10.52H34.82Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <div className="flex items-center gap-2">
            <RelayLogo />
            <span className="text-xl font-bold">RelayAPI</span>
          </div>
        ),
      }}
      themeSwitch={{ enabled: false }}
      sidebar={{
        footer: <SidebarFooter key="sidebar-footer" />,
      }}
    >
      {children}
    </DocsLayout>
  );
}
