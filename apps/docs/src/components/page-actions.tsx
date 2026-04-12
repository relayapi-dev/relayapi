"use client";

import { useState } from "react";
import { Copy, Check, ChevronDown } from "lucide-react";

interface PageActionsProps {
  llmUrl: string;
}

export function PageActions({ llmUrl }: PageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleCopy = async () => {
    setLoading(true);
    try {
      const response = await fetch(llmUrl);
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleCopy}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-lg border border-fd-border px-3 py-1.5 text-sm font-medium text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground transition-colors cursor-pointer disabled:opacity-50"
      >
        {copied ? (
          <Check className="size-4" />
        ) : (
          <Copy className="size-4" />
        )}
        {loading ? "Copying..." : copied ? "Copied!" : "Copy for AI"}
      </button>
      <a
        href={llmUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-lg border border-fd-border px-3 py-1.5 text-sm font-medium text-fd-foreground hover:bg-fd-accent hover:text-fd-accent-foreground transition-colors"
      >
        Open
        <ChevronDown className="size-3.5 opacity-60" />
      </a>
    </div>
  );
}
