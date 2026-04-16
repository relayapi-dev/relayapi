import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface GroupCreateInlineProps {
	onSubmit: (name: string, color: string) => void;
}

const PRESET_COLORS = [
	"#6366f1",
	"#ec4899",
	"#f97316",
	"#22c55e",
	"#3b82f6",
	"#a855f7",
	"#ef4444",
	"#eab308",
];

export function GroupCreateInline({ onSubmit }: GroupCreateInlineProps) {
	const [active, setActive] = useState(false);
	const [name, setName] = useState("");
	const [color, setColor] = useState(PRESET_COLORS[0]!);

	const handleSubmit = () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		onSubmit(trimmed, color);
		setName("");
		setActive(false);
	};

	if (!active) {
		return (
			<div className="shrink-0 w-72">
				<button
					className="w-full rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground hover:bg-accent/20 transition-colors h-[52px] flex items-center justify-center gap-1.5"
					onClick={() => setActive(true)}
				>
					<Plus className="size-4" />
					New Group
				</button>
			</div>
		);
	}

	return (
		<div className="shrink-0 w-72 rounded-md border border-border bg-accent/10 p-3 space-y-2">
			<input
				className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
				placeholder="Group name"
				value={name}
				onChange={(e) => setName(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") handleSubmit();
					if (e.key === "Escape") setActive(false);
				}}
				autoFocus
			/>
			<div className="flex gap-1">
				{PRESET_COLORS.map((c) => (
					<button
						key={c}
						className={`size-5 rounded-full border-2 transition-colors ${color === c ? "border-foreground" : "border-transparent"}`}
						style={{ backgroundColor: c }}
						onClick={() => setColor(c)}
					/>
				))}
			</div>
			<div className="flex gap-2">
				<Button
					size="sm"
					className="h-7 text-xs flex-1"
					onClick={handleSubmit}
				>
					Create
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 text-xs"
					onClick={() => setActive(false)}
				>
					<X className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}
