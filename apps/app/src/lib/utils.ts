import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPercentage(value: number) {
  if (!Number.isFinite(value)) return "0"

  const rounded = Number(value.toFixed(1))
  const normalized = Object.is(rounded, -0) ? 0 : rounded

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(normalized)
}
