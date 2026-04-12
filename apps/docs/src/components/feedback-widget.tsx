"use client";

import { useState, useRef, useEffect } from "react";

const GITHUB_REPO = "relayapi-dev/relayapi";

const labels = ["bug", "enhancement", "question"];

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState<"bug" | "enhancement" | "question">("bug");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const handleSubmit = () => {
    if (!title.trim()) return;

    const params = new URLSearchParams({
      title: title.trim(),
      body: body.trim(),
      labels: type,
    });

    window.open(
      `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`,
      "_blank",
    );

    setTitle("");
    setBody("");
    setType("bug");
    setOpen(false);
  };

  return (
    <div className="fixed bottom-4 right-7 z-50" ref={panelRef}>
      {/* Popup panel */}
      <div
        className={`absolute bottom-14 right-0 w-[calc(100vw-2rem)] sm:w-[360px] max-w-[360px] rounded-xl border border-fd-border bg-fd-card shadow-xl transition-all duration-150 origin-bottom-right ${
          open
            ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
            : "opacity-0 scale-95 translate-y-2 pointer-events-none"
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-fd-border px-4 py-3">
          <svg
            className="size-5"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
          <span className="text-sm font-semibold">Submit an Issue</span>
          <button
            onClick={() => setOpen(false)}
            className="ml-auto text-fd-muted-foreground hover:text-fd-foreground transition-colors"
          >
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="space-y-3 p-4">
          {/* Type selector */}
          <div className="flex gap-1.5">
            {labels.map((label) => (
              <button
                key={label}
                onClick={() => setType(label as typeof type)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  type === label
                    ? "bg-fd-primary text-fd-primary-foreground"
                    : "bg-fd-muted text-fd-muted-foreground hover:text-fd-foreground"
                }`}
              >
                {label === "bug"
                  ? "Bug Report"
                  : label === "enhancement"
                    ? "Feature Request"
                    : "Question"}
              </button>
            ))}
          </div>

          {/* Title */}
          <input
            type="text"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg border border-fd-border bg-transparent px-3 py-2 text-sm placeholder:text-fd-muted-foreground focus:outline-none focus:ring-2 focus:ring-fd-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim()) handleSubmit();
            }}
          />

          {/* Description */}
          <textarea
            placeholder="Describe the issue..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-lg border border-fd-border bg-transparent px-3 py-2 text-sm placeholder:text-fd-muted-foreground focus:outline-none focus:ring-2 focus:ring-fd-ring"
          />

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!title.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            Open on GitHub
            <svg
              className="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>

          <div className="flex items-center justify-center gap-1.5 text-[11px] text-fd-muted-foreground">
            <span>Requires a GitHub account.</span>
            <a
              href={`https://github.com/${GITHUB_REPO}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-fd-foreground transition-colors"
            >
              View repo
              <svg
                className="size-2.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>
        </div>
      </div>

      {/* Floating button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex size-9 items-center justify-center rounded-full bg-black text-white shadow-lg transition-transform hover:scale-105 active:scale-95 dark:bg-white dark:text-black"
        title="Report an issue"
      >
        <svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
      </button>
    </div>
  );
}
