// Port-driven React Flow handles (Plan 2 — Unit B2, Task L1).
//
// Renders one `<Handle>` per port on an `AutomationNode`. Input ports attach
// to the left edge, output ports to the right edge. The handle's `id` is the
// port key, which matches the `from_port` / `to_port` values persisted on
// edges — so React Flow's `sourceHandle` / `targetHandle` bindings line up
// with the port model without any translation layer.
//
// Colour cues come from `port.role` plus sub-role detection on branch ports:
//   - branch / key "true"   -> green
//   - branch / key "false"  -> red
//   - branch (other)        -> purple
//   - error / invalid       -> red
//   - success               -> green
//   - interactive           -> blue
//   - timeout               -> amber
//   - skip                  -> grey-subtle
//   - default               -> neutral grey
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
 * Role → handle colours. Exported so tests can assert on the mapping without
 * re-deriving it.
 */
export function stylesForPort(port: AutomationPort): PortStyle {
	const role = port.role ?? "default";
	if (role === "branch") {
		if (port.key === "true") {
			return {
				dot: "!border-[#1fa971] !bg-[#d9f5e5]",
				chip: "bg-[#e7f7ee] text-[#196a47] border-[#b7e6c9]",
			};
		}
		if (port.key === "false") {
			return {
				dot: "!border-[#d64545] !bg-[#fde2e2]",
				chip: "bg-[#fde7e7] text-[#8a2323] border-[#f4b3b3]",
			};
		}
		return {
			dot: "!border-[#7c4dff] !bg-[#e8e0ff]",
			chip: "bg-[#efe9ff] text-[#503399] border-[#d0c1ff]",
		};
	}
	if (role === "error" || role === "invalid") {
		return {
			dot: "!border-[#d64545] !bg-[#fde2e2]",
			chip: "bg-[#fde7e7] text-[#8a2323] border-[#f4b3b3]",
		};
	}
	if (role === "success") {
		return {
			dot: "!border-[#1fa971] !bg-[#d9f5e5]",
			chip: "bg-[#e7f7ee] text-[#196a47] border-[#b7e6c9]",
		};
	}
	if (role === "interactive") {
		return {
			dot: "!border-[#2f6bff] !bg-[#dceaff]",
			chip: "bg-[#e4eeff] text-[#1b3e9e] border-[#c0d4ff]",
		};
	}
	if (role === "timeout") {
		return {
			dot: "!border-[#c78028] !bg-[#ffe8c7]",
			chip: "bg-[#fff0d6] text-[#7a4a0a] border-[#f2cf8a]",
		};
	}
	if (role === "skip") {
		return {
			dot: "!border-[#b7bdc9] !bg-[#eef0f4]",
			chip: "bg-[#eef0f4] text-[#6f7786] border-[#d6dae2]",
		};
	}
	// default / anything we don't know
	return {
		dot: "!border-[#98a6bd] !bg-white",
		chip: "bg-[#f4f5f8] text-[#4f5765] border-[#e5e8ee]",
	};
}

function labelFor(port: AutomationPort): string {
	if (port.label && port.label.trim()) return port.label;
	return port.key;
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
				return (
					<div
						key={`out-${port.key}`}
						className="pointer-events-auto absolute"
						style={{ right: -12, top, transform: "translateY(-50%)" }}
					>
						<Handle
							type="source"
							id={port.key}
							position={Position.Right}
							isConnectable={isConnectable}
							data-port-role={port.role ?? "default"}
							data-port-direction="output"
							className={cn(
								"!relative !left-0 !top-0 !h-7 !w-[74px] !translate-x-0 !translate-y-0 !border-0 !bg-transparent !shadow-none",
							)}
						/>
						<span
							aria-hidden="true"
							className={cn(
								"pointer-events-none absolute left-[5px] top-1/2 size-[12px] -translate-y-1/2 rounded-full border-[2px] shadow-[0_1px_3px_rgba(34,44,66,0.12)]",
								style.dot,
							)}
						/>
						<span
							className={cn(
								"pointer-events-none absolute left-[22px] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium",
								style.chip,
							)}
							data-testid={`port-chip-${port.key}`}
						>
							{labelFor(port)}
						</span>
					</div>
				);
			})}
		</>
	);
}
