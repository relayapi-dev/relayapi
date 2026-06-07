import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Avatar with a graceful fallback. Platform profile pictures (e.g. Instagram's
 * `profile_pic`) are temporary signed CDN URLs that expire — once they 403 the
 * browser would otherwise render a broken-image glyph. On load error we fall
 * back to the first letter of the name instead. The error state resets whenever
 * `src` changes so a fresh URL gets a clean chance to load.
 */
export function Avatar({
  src,
  name,
  className,
  fallbackClassName,
}: {
  src?: string | null;
  name: string;
  /** Size/shape classes applied to both the image and the letter fallback (e.g. "size-10"). */
  className?: string;
  /** Extra classes for the letter fallback only (e.g. "text-sm", "bg-white"). */
  fallbackClassName?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    const letter = (name.trim().charAt(0) || "?").toUpperCase();
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-full border border-[#e5e7eb] bg-[#f4f6fa] font-semibold text-slate-500",
          className,
          fallbackClassName,
        )}
      >
        {letter}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      onError={() => setFailed(true)}
      className={cn(
        "rounded-full border border-[#e5e7eb] object-cover",
        className,
      )}
    />
  );
}
