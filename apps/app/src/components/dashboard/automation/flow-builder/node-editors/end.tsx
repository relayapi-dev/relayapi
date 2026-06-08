// End node editor — terminal node, no configuration.

export function EndEditor() {
	return (
		<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
			<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Settings
			</div>
			<p className="mt-4 text-[13px] text-[#7e8695]">
				No configuration needed — this step ends the run.
			</p>
		</div>
	);
}
