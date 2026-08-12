type ResolvedTemplateTarget = {
	accounts: Array<{
		id: string;
		username: string | null;
		display_name: string | null;
	}>;
};

export type TemplateRenderResult =
	| { ok: true; content: string }
	| {
			ok: false;
			code: "TEMPLATE_VARIABLE_UNRESOLVED";
			variable: "account_name";
	  };

export type TemplateOverrideRenderResult =
	| { ok: true; overrides: Record<string, string> }
	| {
			ok: false;
			code: "TEMPLATE_VARIABLE_UNRESOLVED";
			variable: "account_name";
			platform: string;
	  };

/**
 * Resolve the built-in account_name value only when every selected account has
 * the same non-empty display label. A multi-account post must not silently use
 * whichever account happened to resolve first.
 */
export function resolveTemplateAccountName(
	resolved: ResolvedTemplateTarget[],
): string | null {
	const accounts = resolved.flatMap((target) => target.accounts);
	if (accounts.length === 0) return null;

	const labels = accounts.map((account) =>
		(account.display_name || account.username || "").trim(),
	);
	if (labels.some((label) => label.length === 0)) return null;

	const uniqueLabels = new Set(labels);
	return uniqueLabels.size === 1 ? (labels[0] ?? null) : null;
}

/** Render built-in and caller-provided content-template variables safely. */
export function renderPostTemplate(
	template: string,
	variables: Record<string, string> | undefined,
	resolvedAccountName: string | null,
	now: Date = new Date(),
): TemplateRenderResult {
	let rendered = template.replace(
		/\{\{date\}\}/g,
		now.toISOString().split("T")[0] ?? "",
	);

	if (rendered.includes("{{account_name}}")) {
		const explicitAccountName = variables?.account_name?.trim();
		const accountName = explicitAccountName || resolvedAccountName;
		if (!accountName) {
			return {
				ok: false,
				code: "TEMPLATE_VARIABLE_UNRESOLVED",
				variable: "account_name",
			};
		}
		rendered = rendered.replace(/\{\{account_name\}\}/g, () => accountName);
	}

	for (const [key, value] of Object.entries(variables ?? {})) {
		// Built-ins are resolved above so their semantics cannot be accidentally
		// changed by iteration order.
		if (key === "date" || key === "account_name") continue;
		const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		rendered = rendered.replace(
			new RegExp(`\\{\\{${escapedKey}\\}\\}`, "g"),
			() => value,
		);
	}

	return { ok: true, content: rendered };
}

/**
 * `platforms` restricts rendering to the platforms the post actually targets.
 * An override for an untargeted platform is never applied, so an unresolvable
 * variable inside it must not fail the request.
 */
export function renderPostTemplateOverrides(
	overrides: Record<string, string> | null | undefined,
	variables: Record<string, string> | undefined,
	resolvedAccountName: string | null,
	now: Date = new Date(),
	platforms?: ReadonlySet<string>,
): TemplateOverrideRenderResult {
	const renderedOverrides: Record<string, string> = {};
	for (const [platform, content] of Object.entries(overrides ?? {})) {
		if (platforms && !platforms.has(platform)) continue;
		const rendered = renderPostTemplate(
			content,
			variables,
			resolvedAccountName,
			now,
		);
		if (!rendered.ok) return { ...rendered, platform };
		renderedOverrides[platform] = rendered.content;
	}
	return { ok: true, overrides: renderedOverrides };
}

export function mergePostTargetOptions(
	templateOptions: Record<string, Record<string, unknown>>,
	requestOptions: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
	const merged: Record<string, Record<string, unknown>> = {};
	for (const key of new Set([
		...Object.keys(templateOptions),
		...Object.keys(requestOptions ?? {}),
	])) {
		merged[key] = {
			...(templateOptions[key] ?? {}),
			...(requestOptions?.[key] ?? {}),
		};
	}
	return merged;
}

/** Platform defaults apply to account/workspace selectors; selector options win. */
export function resolvePostTargetOptions(
	options: Record<string, Record<string, unknown>> | null,
	platform: string,
	selector: string,
): Record<string, unknown> {
	return {
		...(options?.[platform] ?? {}),
		...(options?.[selector] ?? {}),
	};
}

export function injectPostSignature(
	content: string,
	signature: { content: string; position: string },
): string {
	return signature.position === "prepend"
		? `${signature.content}\n\n${content}`
		: `${content}\n\n${signature.content}`;
}

export function injectSignatureIntoTargetOptions(
	targetOptions: Record<string, Record<string, unknown>>,
	signature: { content: string; position: string },
): Record<string, Record<string, unknown>> {
	return Object.fromEntries(
		Object.entries(targetOptions).map(([key, options]) => [
			key,
			{
				...options,
				...(typeof options.content === "string" && options.content.trim()
					? { content: injectPostSignature(options.content, signature) }
					: {}),
			},
		]),
	);
}

/**
 * Per-target option keys a publisher can publish from on their own, without
 * shared text or shared media. `target_options` is an untyped record, so this
 * list has to be explicit — config-only keys (reply_to, subreddit,
 * privacy_level, visibility, …) must never appear here or they would let an
 * otherwise empty post through.
 */
const CONTENT_BEARING_TARGET_OPTION_KEYS = [
	// Per-target media fully replaces shared media in every publisher.
	"media",
	// Twitter/Bluesky/Threads publish a thread without touching shared content.
	"thread",
	// A Discord webhook message may carry only embeds.
	"embeds",
	// Newsletter publishers build the body from content_html.
	"content_html",
	// WhatsApp message shapes that return before content is read.
	"template_name",
	"interactive",
	"location",
	"reaction",
	"contacts",
	// A Reddit link post has a url and title but no body.
	"url",
] as const;

function hasContentBearingTargetOption(
	options: Record<string, unknown>,
): boolean {
	if (typeof options.content === "string" && options.content.trim().length > 0)
		return true;
	return CONTENT_BEARING_TARGET_OPTION_KEYS.some((key) => {
		const value = options[key];
		if (value == null) return false;
		if (typeof value === "string") return value.trim().length > 0;
		if (Array.isArray(value)) return value.length > 0;
		if (typeof value === "object") return Object.keys(value).length > 0;
		return true;
	});
}

/**
 * A post needs shared text, at least one media item, or a per-target payload a
 * publisher can actually send. This guard runs after template/idea resolution
 * and before persistence.
 */
export function hasEffectivePostPayload(
	content: string | null,
	media: unknown[] | undefined,
	targetOptions: Record<string, Record<string, unknown>> | undefined,
): boolean {
	if (content?.trim()) return true;
	if (media && media.length > 0) return true;
	return Object.values(targetOptions ?? {}).some(hasContentBearingTargetOption);
}
