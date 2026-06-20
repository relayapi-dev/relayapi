import { Avatar, Style } from "@dicebear/core";
import botttsNeutral from "@dicebear/styles/bottts-neutral.json";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

// A single DiceBear `bottts-neutral` style instance, built once. The neutral
// variant is transparent, so the robot sits on the caller-provided background.
const style = new Style(botttsNeutral);

/**
 * User avatar with an uploaded-image-first fallback chain:
 *   1. `image` (the user's uploaded photo) when present
 *   2. otherwise a deterministic `bottts-neutral` robot seeded by `seed`
 *      (pass the user id so the robot is stable across pages and renames)
 *
 * `className` controls size/rounding (e.g. "size-9"); `fallbackBgClassName`
 * is the circle backdrop shown behind the robot's transparent edges.
 */
export function UserAvatar({
	image,
	name,
	seed,
	className,
	fallbackBgClassName = "bg-secondary",
	alt,
}: {
	image?: string | null;
	name?: string | null;
	seed?: string | null;
	className?: string;
	fallbackBgClassName?: string;
	alt?: string;
}) {
	const robot = useMemo(
		() =>
			image
				? null
				: new Avatar(style, {
						seed: seed || name || "?",
						size: 64,
					}).toDataUri(),
		[image, seed, name],
	);

	if (image) {
		return (
			<img
				src={image}
				alt={alt ?? name ?? ""}
				className={cn("rounded-full object-cover", className)}
			/>
		);
	}

	return (
		<div className={cn("overflow-hidden rounded-full", fallbackBgClassName, className)}>
			<img src={robot ?? undefined} alt={alt ?? name ?? ""} className="size-full" />
		</div>
	);
}
