import { MessageCircle, Paperclip, Check } from "lucide-react";

interface IdeaTag {
	id: string;
	name: string;
	color: string;
}

interface IdeaCardProps {
	title: string | null;
	content: string | null;
	tags: IdeaTag[];
	mediaCount: number;
	commentCount: number;
	assignedTo: string | null;
	convertedToPostId: string | null;
	onClick: () => void;
}

export function IdeaCard({
	title,
	content,
	tags,
	mediaCount,
	commentCount,
	assignedTo,
	convertedToPostId,
	onClick,
}: IdeaCardProps) {
	const displayTitle = title || content?.slice(0, 80) || "Untitled";
	const showContent = title && content;
	const visibleTags = tags.slice(0, 3);
	const extraTagCount = tags.length - 3;
	const hasFooter = mediaCount > 0 || commentCount > 0 || assignedTo;

	return (
		<div
			className="rounded-md border border-border bg-background p-3 cursor-pointer hover:bg-accent/20 transition-colors relative"
			onClick={onClick}
		>
			{convertedToPostId && (
				<span
					className="absolute top-2 right-2 size-4 rounded-full bg-green-500/20 flex items-center justify-center"
					title="Converted to post"
				>
					<Check className="size-2.5 text-green-500" />
				</span>
			)}

			<p className="text-sm font-medium line-clamp-2 pr-5">{displayTitle}</p>

			{showContent && (
				<p className="text-xs text-muted-foreground mt-1 line-clamp-2">
					{content}
				</p>
			)}

			{visibleTags.length > 0 && (
				<div className="flex flex-wrap gap-1 mt-2">
					{visibleTags.map((tag) => (
						<span
							key={tag.id}
							className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground bg-accent/40"
						>
							<span
								className="size-1.5 rounded-full shrink-0"
								style={{ backgroundColor: tag.color }}
							/>
							{tag.name}
						</span>
					))}
					{extraTagCount > 0 && (
						<span className="text-[10px] text-muted-foreground px-1">
							+{extraTagCount}
						</span>
					)}
				</div>
			)}

			{hasFooter && (
				<div className="flex items-center gap-2 mt-2 text-muted-foreground">
					{mediaCount > 0 && (
						<span className="inline-flex items-center gap-0.5 text-[10px]">
							<Paperclip className="size-3" />
							{mediaCount}
						</span>
					)}
					{commentCount > 0 && (
						<span className="inline-flex items-center gap-0.5 text-[10px]">
							<MessageCircle className="size-3" />
							{commentCount}
						</span>
					)}
					{assignedTo && (
						<span
							className="ml-auto size-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-medium"
							title={assignedTo}
						>
							{assignedTo.slice(0, 2).toUpperCase()}
						</span>
					)}
				</div>
			)}
		</div>
	);
}
