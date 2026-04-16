import { useState } from "react";
import { MoreHorizontal, Pencil, Trash2, Plus } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface IdeaColumnProps {
	id: string;
	name: string;
	color: string | null;
	isDefault: boolean;
	count: number;
	children: React.ReactNode;
	dragHandleProps?: Record<string, unknown>;
	onRename: (name: string) => void;
	onDelete: () => void;
	onNewIdea: () => void;
}

export function IdeaColumn({
	name,
	color,
	isDefault,
	count,
	children,
	dragHandleProps,
	onRename,
	onDelete,
	onNewIdea,
}: IdeaColumnProps) {
	const [editing, setEditing] = useState(false);
	const [editName, setEditName] = useState(name);

	const handleRenameSubmit = () => {
		const trimmed = editName.trim();
		if (trimmed && trimmed !== name) {
			onRename(trimmed);
		}
		setEditing(false);
	};

	return (
		<div className="shrink-0 w-72 rounded-md border border-border bg-accent/10 flex flex-col max-h-[calc(100vh-180px)]">
			<div
				className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0 cursor-grab active:cursor-grabbing"
				{...(dragHandleProps as React.HTMLAttributes<HTMLDivElement>)}
			>
				{color && (
					<span
						className="size-2.5 rounded-full shrink-0"
						style={{ backgroundColor: color }}
					/>
				)}
				{editing ? (
					<input
						className="text-sm font-medium bg-transparent border-b border-foreground outline-none flex-1 min-w-0"
						value={editName}
						onChange={(e) => setEditName(e.target.value)}
						onBlur={handleRenameSubmit}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleRenameSubmit();
							if (e.key === "Escape") {
								setEditName(name);
								setEditing(false);
							}
						}}
						autoFocus
						onClick={(e) => e.stopPropagation()}
					/>
				) : (
					<span className="text-sm font-medium truncate flex-1">{name}</span>
				)}
				<span className="text-xs text-muted-foreground">{count}</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							className="rounded p-0.5 hover:bg-accent transition-colors"
							onClick={(e) => e.stopPropagation()}
						>
							<MoreHorizontal className="size-3.5 text-muted-foreground" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-40">
						<DropdownMenuItem
							onClick={() => {
								setEditName(name);
								setEditing(true);
							}}
						>
							<Pencil className="size-3.5 mr-2" />
							Rename
						</DropdownMenuItem>
						{!isDefault && (
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={onDelete}
							>
								<Trash2 className="size-3.5 mr-2" />
								Delete Group
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="p-2 space-y-2 flex-1 overflow-y-auto min-h-[100px]">
				{children}
				<button
					className="w-full rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground hover:bg-accent/20 transition-colors"
					onClick={onNewIdea}
				>
					<Plus className="size-3 inline mr-1" />
					New Idea
				</button>
			</div>
		</div>
	);
}
