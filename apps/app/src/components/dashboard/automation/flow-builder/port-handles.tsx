// Port-driven React Flow handles (Plan 2 — Unit B2, Task L1).
//
// Renders one `<Handle>` per port on an `AutomationNode`. Input ports attach
// to the left edge, output ports to the right edge. The handle's `id` is the
// port key, which matches the `from_port` / `to_port` values persisted on
// edges — so React Flow's `sourceHandle` / `targetHandle` bindings line up
// with the port model without any translation layer.
//
// Handles are monochrome: a single neutral dot/chip treatment for every role.
// The chip *label* (e.g. "True", "False", "Error") carries the meaning, so the
// canvas stays calm and readable without a rainbow of port colours.
//
// A small chip sits next to the handle showing `port.label` (falling back to
// the key). Clicking the chip is intentionally a no-op — port editing happens
// in the message composer / property panel, not on the canvas.

import { Handle, Position } from "reactflow";
import type { AutomationPort } from "./graph-types";
import { cn } from "@/lib/utils";

export interface PortHandlesProps {
	ports: AutomationPort[];
	isConnectable?: boolean;
}

interface PortStyle {
	dot: string;
	chip: string;
}

/**
 * Port style. Monochrome by design: every role shares one neutral treatment
 * and the chip *label* (e.g. "True", "False", "Error") carries the meaning
 * instead of colour. Exported for symmetry with the renderer; kept as a
 * function so a future variant could reintroduce per-role cues in one place.
 */
export function stylesForPort(_port: AutomationPort): PortStyle {
	return {
		dot: "!border-[#98a6bd] !bg-white",
		chip: "bg-[#f4f5f8] text-[#4f5765] border-[#e5e8ee]",
	};
}

function labelFor(port: AutomationPort): string {
	if (port.label?.trim()) return port.label;
	return port.key;
}

function shouldShowChip(port: AutomationPort): boolean {
	const label = labelFor(port).trim().toLowerCase();
	return label !== "next" && label !== "next step";
}

/**
 * Even vertical distribution for N ports. Extracted so PortHandles and node
 * rendering code (e.g. computing padding for connected-port labels) stay in
 * agreement.
 */
export function portHandleTop(index: number, total: number): string {
	if (total <= 1) return "50%";
	const start = 18; // top inset (%) so the first handle isn't on the card edge
	const end = 82; // bottom inset
	const step = (end - start) / (total - 1);
	return `${start + step * index}%`;
}

export function PortHandles({ ports, isConnectable = true }: PortHandlesProps) {
	const inputs = ports.filter((p) => p.direction === "input");
	const outputs = ports.filter((p) => p.direction === "output");

	return (
		<>
			{inputs.map((port, index) => {
				const style = stylesForPort(port);
				return (
					<Handle
						key={`in-${port.key}`}
						type="target"
						id={port.key}
						position={Position.Left}
						isConnectable={isConnectable}
						data-port-role={port.role ?? "default"}
						data-port-direction="input"
						className={cn(
							"!size-[12px] !border-[2px] !shadow-[0_1px_3px_rgba(34,44,66,0.12)]",
							style.dot,
						)}
						style={{
							left: -7,
							top: portHandleTop(index, inputs.length),
						}}
					/>
				);
			})}

			{outputs.map((port, index) => {
				const style = stylesForPort(port);
				const top = portHandleTop(index, outputs.length);
				const showChip = shouldShowChip(port);
				return (
					<div
						key={`out-${port.key}`}
						className="pointer-events-none absolute"
						style={{ right: -7, top, transform: "translateY(-50%)" }}
					>
						<Handle
							type="source"
							id={port.key}
							position={Position.Right}
							isConnectable={isConnectable}
							data-port-role={port.role ?? "default"}
							data-port-direction="output"
							className={cn(
								"!pointer-events-auto !relative !left-0 !top-0 !size-[12px] !translate-x-0 !translate-y-0 !border-[2px] !shadow-[0_1px_3px_rgba(34,44,66,0.12)] before:absolute before:-left-2 before:top-1/2 before:h-7 before:w-[74px] before:-translate-y-1/2 before:bg-transparent before:content-['']",
								style.dot,
							)}
						/>
						{showChip ? (
							<span
								className={cn(
									"pointer-events-none absolute top-1/2 -translate-y-1/2 translate-x-2 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium",
									style.chip,
								)}
								style={{ left: "100%" }}
								data-testid={`port-chip-${port.key}`}
							>
								{labelFor(port)}
							</span>
						) : null}
					</div>
				);
			})}
		</>
	);
}
