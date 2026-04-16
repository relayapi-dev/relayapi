import { useState } from "react";
import { motion } from "motion/react";
import { Plus, Pencil, Trash2, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePaginatedApi } from "@/hooks/use-api";
import { useFilterQuery } from "@/components/dashboard/filter-context";

const fadeUp = {
	hidden: { opacity: 0, y: 6 },
	visible: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
	},
};

const PRESET_COLORS = [
	"#6366f1", "#ec4899", "#f97316", "#22c55e",
	"#3b82f6", "#a855f7", "#ef4444", "#eab308",
];

interface Tag {
	id: string;
	name: string;
	color: string;
	workspace_id: string | null;
	created_at: string;
}

export function TagsSettings() {
	const filterQuery = useFilterQuery();
	const { data: tags, loading, refetch } = usePaginatedApi<Tag>("tags", { query: filterQuery });

	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newColor, setNewColor] = useState(PRESET_COLORS[0]!);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [editColor, setEditColor] = useState("");
	const [saving, setSaving] = useState(false);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

	const handleCreate = async () => {
		if (!newName.trim()) return;
		setSaving(true);
		const res = await fetch("/api/tags", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: newName.trim(), color: newColor, ...filterQuery }),
		});
		if (res.ok) {
			setNewName("");
			setCreating(false);
			refetch();
		}
		setSaving(false);
	};

	const handleUpdate = async (id: string) => {
		if (!editName.trim()) return;
		setSaving(true);
		await fetch(`/api/tags/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: editName.trim(), color: editColor }),
		});
		setEditingId(null);
		refetch();
		setSaving(false);
	};

	const handleDelete = async (id: string) => {
		await fetch(`/api/tags/${id}`, { method: "DELETE" });
		setDeleteConfirmId(null);
		refetch();
	};

	return (
		<motion.div variants={fadeUp}>
			<div className="rounded-md border border-border overflow-hidden">
				<div className="px-4 py-3 border-b border-border bg-accent/10 flex items-center justify-between">
					<div>
						<h2 className="text-sm font-medium">Tags</h2>
						<p className="text-xs text-muted-foreground mt-0.5">
							Tags are shared across ideas and posts.
						</p>
					</div>
					{!creating && (
						<Button size="sm" className="h-7 text-xs gap-1" onClick={() => setCreating(true)}>
							<Plus className="size-3.5" />
							New Tag
						</Button>
					)}
				</div>

				<div className="divide-y divide-border">
					{creating && (
						<div className="px-4 py-3 flex items-center gap-3">
							<div className="flex gap-1">
								{PRESET_COLORS.map((c) => (
									<button
										key={c}
										className={`size-5 rounded-full border-2 transition-colors ${newColor === c ? "border-foreground" : "border-transparent"}`}
										style={{ backgroundColor: c }}
										onClick={() => setNewColor(c)}
									/>
								))}
							</div>
							<input
								className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
								placeholder="Tag name"
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreate();
									if (e.key === "Escape") setCreating(false);
								}}
								autoFocus
							/>
							<Button size="sm" className="h-7 text-xs" onClick={handleCreate} disabled={saving}>
								{saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3.5" />}
							</Button>
							<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCreating(false)}>
								<X className="size-3.5" />
							</Button>
						</div>
					)}

					{loading && (
						<div className="px-4 py-8 text-center">
							<Loader2 className="size-4 animate-spin text-muted-foreground mx-auto" />
						</div>
					)}

					{!loading && tags.length === 0 && !creating && (
						<div className="px-4 py-8 text-center">
							<p className="text-sm text-muted-foreground">No tags yet</p>
							<p className="text-xs text-muted-foreground mt-1">Create your first tag to organize ideas and posts.</p>
						</div>
					)}

					{tags.map((tag) => (
						<div key={tag.id} className="px-4 py-2.5 flex items-center gap-3">
							{editingId === tag.id ? (
								<>
									<div className="flex gap-1">
										{PRESET_COLORS.map((c) => (
											<button
												key={c}
												className={`size-5 rounded-full border-2 transition-colors ${editColor === c ? "border-foreground" : "border-transparent"}`}
												style={{ backgroundColor: c }}
												onClick={() => setEditColor(c)}
											/>
										))}
									</div>
									<input
										className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
										value={editName}
										onChange={(e) => setEditName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleUpdate(tag.id);
											if (e.key === "Escape") setEditingId(null);
										}}
										autoFocus
									/>
									<Button size="sm" className="h-7 text-xs" onClick={() => handleUpdate(tag.id)} disabled={saving}>
										{saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3.5" />}
									</Button>
									<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>
										<X className="size-3.5" />
									</Button>
								</>
							) : (
								<>
									<span className="size-3 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
									<span className="text-sm flex-1">{tag.name}</span>
									{deleteConfirmId === tag.id ? (
										<>
											<span className="text-xs text-destructive">Delete?</span>
											<Button size="sm" variant="destructive" className="h-6 text-xs px-2" onClick={() => handleDelete(tag.id)}>Yes</Button>
											<Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => setDeleteConfirmId(null)}>No</Button>
										</>
									) : (
										<>
											<button className="rounded p-1 hover:bg-accent transition-colors" onClick={() => { setEditingId(tag.id); setEditName(tag.name); setEditColor(tag.color); }}>
												<Pencil className="size-3.5 text-muted-foreground" />
											</button>
											<button className="rounded p-1 hover:bg-red-500/10 transition-colors" onClick={() => setDeleteConfirmId(tag.id)}>
												<Trash2 className="size-3.5 text-muted-foreground hover:text-red-400" />
											</button>
										</>
									)}
								</>
							)}
						</div>
					))}
				</div>
			</div>
		</motion.div>
	);
}
