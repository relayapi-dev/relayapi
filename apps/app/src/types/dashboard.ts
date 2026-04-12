import {
	AlertTriangle,
	BarChart3,
	CalendarDays,
	CheckCircle,
	CreditCard,
	Mail,
	Megaphone,
	Unplug,
} from "lucide-react";

export interface AppUser {
	id: string;
	name: string;
	email: string;
	image?: string | null;
	role?: string | null;
}

export interface AppOrganization {
	id: string;
	name: string;
	slug: string;
	logo?: string | null;
}

export interface NotificationItem {
	id: string;
	type: string;
	title: string;
	body: string;
	data: Record<string, unknown> | null;
	read: boolean;
	createdAt: string;
}

export const NOTIF_TYPE_ICON: Record<string, typeof AlertTriangle> = {
	post_failed: AlertTriangle,
	post_published: CheckCircle,
	account_disconnected: Unplug,
	payment_failed: CreditCard,
	usage_warning: BarChart3,
	weekly_digest: CalendarDays,
	marketing: Megaphone,
};

export const NOTIF_TYPE_COLOR: Record<string, string> = {
	post_failed: "text-rose-500",
	post_published: "text-emerald-500",
	account_disconnected: "text-amber-500",
	payment_failed: "text-rose-500",
	usage_warning: "text-amber-500",
	weekly_digest: "text-indigo-500",
	marketing: "text-indigo-500",
};

export const ORG_COLORS = [
	"bg-indigo-600",
	"bg-emerald-600",
	"bg-amber-600",
	"bg-rose-600",
	"bg-cyan-600",
	"bg-violet-600",
	"bg-orange-600",
	"bg-teal-600",
];

export function getOrgColor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) | 0;
	}
	return ORG_COLORS[Math.abs(hash) % ORG_COLORS.length]!;
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function timeAgo(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime();
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}
