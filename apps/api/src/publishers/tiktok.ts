import {
	ensureResponseContentLength,
	fetchPublicUrl,
	getChunkedResponseBody,
	parseContentLength,
	readResponseBytes,
	readResponseJson,
} from "../lib/fetch-public-url";
import { matchesTikTokVerifiedUrlPrefix } from "../lib/tiktok-verified-url";
import { TikTokTargetOptions } from "../schemas/publisher-options";
import {
	classifyPublishError,
	getSucceededProviderEffect,
	mergeProviderEffects,
	type ProviderEffect,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	type ReconcileRequest,
	recordProviderEffect,
} from "./types";

const TIKTOK_API = "https://open.tiktokapis.com/v2";
const TIKTOK_JSON_MAX_BYTES = 64 * 1024;
const TIKTOK_VIDEO_MAX_BYTES = 4_000_000_000;
const TIKTOK_UPLOAD_CHUNK_BYTES = 10_000_000;
const TIKTOK_UPLOAD_RETRY_DELAYS_MS = [0, 250, 500] as const;
const TIKTOK_VIDEO_MIME_TYPES = new Set([
	"video/mp4",
	"video/quicktime",
	"video/webm",
]);
type TikTokPublishMode = "direct" | "inbox";

async function tiktokFetch(
	url: string,
	accessToken: string,
	options: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json; charset=UTF-8",
			...(options.headers ?? {}),
		},
	});
	if (res.status === 401)
		throw new PublishError(
			"TOKEN_EXPIRED: TikTok access token invalid or expired",
			{
				statusCode: res.status,
				detail: `HTTP ${res.status} ${res.statusText}`,
			},
		);
	if (res.status === 429)
		throw new PublishError("RATE_LIMITED: TikTok rate limit exceeded", {
			statusCode: res.status,
			detail: `HTTP ${res.status} ${res.statusText}`,
		});
	return res;
}

interface TikTokPublishResponse {
	data?: {
		publish_id?: string;
		upload_url?: string;
	};
	error?: {
		code?: string;
		message?: string;
	};
}

interface TikTokCreatorInfoResponse {
	data?: {
		creator_username?: string;
		creator_nickname?: string;
		privacy_level_options?: string[];
		comment_disabled?: boolean;
		duet_disabled?: boolean;
		stitch_disabled?: boolean;
		max_video_post_duration_sec?: number;
	};
	error?: {
		code?: string;
		message?: string;
	};
}

function readTikTokText(response: Response): Promise<string> {
	return readResponseBytes(response, TIKTOK_JSON_MAX_BYTES).then((bytes) =>
		new TextDecoder().decode(bytes),
	);
}

async function readTikTokError(response: Response): Promise<unknown> {
	return readResponseJson(response, TIKTOK_JSON_MAX_BYTES).catch(() => ({}));
}

async function queryTikTokCreatorInfo(
	accessToken: string,
): Promise<NonNullable<TikTokCreatorInfoResponse["data"]>> {
	// Official TikTok Content Posting API — Query Creator Info
	// https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
	// Section "HTTP URL": POST /v2/post/publish/creator_info/query/
	// The latest privacy and interaction capabilities must be used before Direct Post.
	const response = await tiktokFetch(
		`${TIKTOK_API}/post/publish/creator_info/query/`,
		accessToken,
		{ method: "POST" },
	);
	if (!response.ok) {
		const error = await readTikTokError(response);
		throw new PublishError("TikTok creator information could not be loaded", {
			statusCode: response.status,
			detail: `HTTP ${response.status}\n${JSON.stringify(error)}`,
		});
	}

	const result = await readResponseJson<TikTokCreatorInfoResponse>(
		response,
		TIKTOK_JSON_MAX_BYTES,
	);
	if (result.error?.code && result.error.code !== "ok") {
		const message =
			result.error.message ?? "TikTok creator information is unavailable";
		if (result.error.code === "rate_limit_exceeded") {
			throw new PublishError(`RATE_LIMITED: ${message}`, { statusCode: 429 });
		}
		if (
			result.error.code === "access_token_invalid" ||
			result.error.code === "scope_not_authorized"
		) {
			throw new PublishError(`TOKEN_EXPIRED: ${message}`, { statusCode: 401 });
		}
		throw new PublishError(message, { code: result.error.code });
	}
	if (!result.data || !Array.isArray(result.data.privacy_level_options)) {
		throw new PublishError(
			"TikTok creator information omitted privacy_level_options",
			{ code: "TIKTOK_CREATOR_INFO_INVALID" },
		);
	}
	return result.data;
}

interface TikTokStatusResponse {
	data?: {
		status?: string;
		publicaly_available_post_id?: string[];
		fail_reason?: string;
	};
	error?: {
		code?: string;
		message?: string;
	};
}

export function parseTikTokStatusResponse(raw: string): TikTokStatusResponse {
	const status = JSON.parse(raw) as TikTokStatusResponse;
	// Official docs: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
	// Section "Nested data struct" defines publicaly_available_post_id as
	// list<int64>. JSON.parse converts an unquoted 19-digit id to an imprecise
	// Number, so recover the original decimal tokens from the bounded JSON body.
	const idList = /"publicaly_available_post_id"\s*:\s*\[([^\]]*)\]/u.exec(
		raw,
	)?.[1];
	if (idList !== undefined && status.data) {
		status.data.publicaly_available_post_id = Array.from(
			idList.matchAll(/"(\d+)"|(\d+)/gu),
			(match) => match[1] ?? match[2] ?? "",
		).filter((id) => id.length > 0);
	}
	return status;
}

async function pollPublishStatus(
	accessToken: string,
	publishId: string,
	maxAttempts = 1,
	intervalMs = 5000,
): Promise<TikTokStatusResponse> {
	let httpFailures = 0;
	let lastStatus: TikTokStatusResponse | null = null;
	for (let i = 0; i < maxAttempts; i++) {
		if (i > 0) {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}

		// TikTok Content Posting API — Fetch publish status
		// https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
		const res = await fetch(`${TIKTOK_API}/post/publish/status/fetch/`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({ publish_id: publishId }),
		});
		if (res.status === 401) {
			void res.body?.cancel().catch(() => {});
			throw new PublishError(
				"TikTok access token expired after the publish job was accepted; its outcome must be reconciled instead of replayed",
				{
					code: "PUBLISH_OUTCOME_UNKNOWN",
					statusCode: res.status,
					detail: `HTTP ${res.status} ${res.statusText}`,
				},
			);
		}
		if (res.status === 429) {
			void res.body?.cancel().catch(() => {});
			throw new PublishError("RATE_LIMITED: TikTok rate limit exceeded", {
				statusCode: res.status,
				detail: `HTTP ${res.status} ${res.statusText}`,
			});
		}

		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			httpFailures++;
			if (httpFailures >= 5) {
				throw new PublishError(
					`TikTok publish status polling failed after ${httpFailures} consecutive HTTP errors (last status: ${res.status}).`,
					{
						statusCode: res.status,
						detail: `HTTP ${res.status} ${res.statusText}`,
					},
				);
			}
			continue;
		}

		httpFailures = 0;

		// Status responses are small provider JSON documents. Read the bounded body
		// as text so documented int64 post ids can be preserved exactly.
		const status = parseTikTokStatusResponse(await readTikTokText(res));
		lastStatus = status;

		if (status.error?.code && status.error.code !== "ok") {
			throw new PublishError(
				status.error.message ??
					`TikTok publish status could not be determined (${status.error.code})`,
				{
					code: "PUBLISH_OUTCOME_UNKNOWN",
					detail: `TikTok status API error: ${status.error.code}`,
				},
			);
		}

		const publishStatus = status.data?.status;

		if (publishStatus === "PUBLISH_COMPLETE") {
			return status;
		}

		// SEND_TO_USER_INBOX means the content was sent to the user's inbox for further editing
		if (publishStatus === "SEND_TO_USER_INBOX") {
			return status;
		}

		if (publishStatus === "FAILED") {
			return status;
		}

		// PROCESSING_UPLOAD or PROCESSING_DOWNLOAD — keep polling
	}

	if (lastStatus?.data?.status) return lastStatus;
	throw new PublishError("TikTok publish status could not be observed", {
		code: "PUBLISH_OUTCOME_UNKNOWN",
	});
}

function tiktokStatusResult(
	publishId: string,
	status: TikTokStatusResponse,
	effects: ProviderEffect[] = [],
): PublishResult {
	if (status.error?.code && status.error.code !== "ok") {
		return {
			success: false,
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_operation_id: publishId,
				provider_state: status.error.code,
				effects,
			},
			error: {
				code: status.error.code,
				message:
					status.error.message ?? "TikTok publish status is unavailable.",
			},
		};
	}

	const providerState = status.data?.status;
	if (providerState === "FAILED") {
		return {
			success: false,
			provider_outcome: {
				disposition: "failed",
				provider_operation_id: publishId,
				provider_state: providerState,
				effects,
			},
			error: {
				code: "TIKTOK_PUBLISH_FAILED",
				message: status.data?.fail_reason ?? "TikTok publish failed.",
			},
		};
	}
	if (providerState === "SEND_TO_USER_INBOX") {
		return {
			success: true,
			provider_outcome: {
				disposition: "awaiting_user_action",
				provider_operation_id: publishId,
				provider_state: providerState,
				effects,
			},
		};
	}
	if (providerState === "PUBLISH_COMPLETE") {
		const postId = status.data?.publicaly_available_post_id?.[0];
		if (!postId) {
			return {
				success: true,
				provider_outcome: {
					disposition: "published",
					provider_operation_id: publishId,
					provider_state: providerState,
					// TikTok documents that this list is populated only for public,
					// moderation-approved posts. PUBLISH_COMPLETE itself is terminal.
					resource_id_unavailable: true,
					effects,
				},
			};
		}
		return {
			success: true,
			platform_post_id: postId,
			provider_outcome: {
				disposition: "published",
				provider_operation_id: publishId,
				provider_state: providerState,
				platform_post_id: postId,
				effects,
			},
		};
	}
	if (
		providerState === "PROCESSING_UPLOAD" ||
		providerState === "PROCESSING_DOWNLOAD"
	) {
		return {
			success: true,
			provider_outcome: {
				disposition: "processing",
				provider_operation_id: publishId,
				provider_state: providerState,
				effects,
			},
		};
	}
	return {
		success: false,
		provider_outcome: {
			disposition: "outcome_unknown",
			provider_operation_id: publishId,
			provider_state: providerState ?? "MISSING_STATUS",
			effects,
		},
		error: {
			code: "PUBLISH_OUTCOME_UNKNOWN",
			message: "TikTok returned an undocumented or missing publish status.",
		},
	};
}

function optionBoolean(
	options: Record<string, unknown>,
	key: string,
): boolean | undefined {
	return typeof options[key] === "boolean"
		? (options[key] as boolean)
		: undefined;
}

function tikTokValidationError(code: string, message: string): PublishResult {
	return { success: false, error: { code, message } };
}

function validateCreatorSelections(
	creator: NonNullable<TikTokCreatorInfoResponse["data"]>,
	opts: Record<string, unknown>,
	privacyLevel: string,
	isVideo: boolean,
	durationMs?: number,
): PublishResult | null {
	if (!creator.privacy_level_options?.includes(privacyLevel)) {
		return tikTokValidationError(
			"PRIVACY_LEVEL_UNAVAILABLE",
			"The selected TikTok privacy_level is not currently available for this creator.",
		);
	}

	const allowComment = optionBoolean(opts, "allow_comment");
	if (allowComment === undefined) {
		return tikTokValidationError(
			"ALLOW_COMMENT_REQUIRED",
			"TikTok requires an explicit allow_comment choice; RelayAPI does not apply a default.",
		);
	}
	if (creator.comment_disabled === true && allowComment) {
		return tikTokValidationError(
			"COMMENTS_DISABLED_BY_CREATOR",
			"Comments are disabled in this creator's TikTok privacy settings.",
		);
	}

	if (isVideo) {
		const allowDuet = optionBoolean(opts, "allow_duet");
		const allowStitch = optionBoolean(opts, "allow_stitch");
		if (allowDuet === undefined || allowStitch === undefined) {
			return tikTokValidationError(
				"VIDEO_INTERACTIONS_REQUIRED",
				"TikTok video posts require explicit allow_duet and allow_stitch choices; RelayAPI does not apply defaults.",
			);
		}
		if (creator.duet_disabled === true && allowDuet) {
			return tikTokValidationError(
				"DUET_DISABLED_BY_CREATOR",
				"Duets are disabled for this TikTok creator.",
			);
		}
		if (creator.stitch_disabled === true && allowStitch) {
			return tikTokValidationError(
				"STITCH_DISABLED_BY_CREATOR",
				"Stitches are disabled for this TikTok creator.",
			);
		}
		if (
			typeof durationMs === "number" &&
			typeof creator.max_video_post_duration_sec === "number" &&
			durationMs > creator.max_video_post_duration_sec * 1000
		) {
			return tikTokValidationError(
				"VIDEO_TOO_LONG_FOR_CREATOR",
				`This creator can post videos up to ${creator.max_video_post_duration_sec} seconds.`,
			);
		}
	}

	if (
		optionBoolean(opts, "brand_content_toggle") === undefined ||
		optionBoolean(opts, "brand_organic_toggle") === undefined
	) {
		return tikTokValidationError(
			"COMMERCIAL_DISCLOSURE_REQUIRED",
			"TikTok requires explicit brand_content_toggle and brand_organic_toggle choices.",
		);
	}
	if (opts.brand_content_toggle === true && privacyLevel === "SELF_ONLY") {
		return tikTokValidationError(
			"BRANDED_CONTENT_PRIVACY_INVALID",
			"TikTok branded content cannot use SELF_ONLY visibility.",
		);
	}
	if (
		opts.content_preview_confirmed !== true ||
		opts.express_consent_given !== true
	) {
		return tikTokValidationError(
			"TIKTOK_CONSENT_REQUIRED",
			"Confirm content_preview_confirmed and express_consent_given only after the creator previews the post and accepts TikTok's Music Usage Confirmation.",
		);
	}
	return null;
}

function getTikTokVerifiedUrlPrefixes(
	metadata: Record<string, unknown> | null | undefined,
): string[] {
	const raw = metadata?.tiktok_verified_url_prefixes;
	if (!Array.isArray(raw)) return [];
	return raw.filter((value): value is string => typeof value === "string");
}

export const tiktokPublisher: Publisher = {
	platform: "tiktok",
	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		if (!request.provider_operation_id) {
			return {
				success: false,
				provider_outcome: { disposition: "outcome_unknown" },
				error: {
					code: "MISSING_PROVIDER_OPERATION_ID",
					message: "TikTok reconciliation requires the original publish_id.",
				},
			};
		}
		try {
			const status = await pollPublishStatus(
				request.account.access_token,
				request.provider_operation_id,
				1,
			);
			return tiktokStatusResult(
				request.provider_operation_id,
				status,
				request.effects,
			);
		} catch (error) {
			const result = classifyPublishError(error);
			return {
				...result,
				provider_outcome: {
					disposition: "outcome_unknown",
					provider_operation_id: request.provider_operation_id,
					provider_state: request.provider_state ?? undefined,
					effects: request.effects,
				},
			};
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accessToken = request.account.access_token;
			let opts = request.target_options;
			const publishMode = (opts.publish_mode ?? "direct") as unknown;
			if (publishMode !== "direct" && publishMode !== "inbox") {
				return tikTokValidationError(
					"INVALID_PUBLISH_MODE",
					"TikTok publish_mode must be direct or inbox.",
				);
			}
			if (opts.draft !== undefined) {
				return tikTokValidationError(
					"UNSUPPORTED_TIKTOK_OPTION",
					"draft is not a TikTok API field; use publish_mode inbox for the official creator-inbox flow.",
				);
			}
			if (opts.commercial_content_type !== undefined) {
				return tikTokValidationError(
					"UNSUPPORTED_TIKTOK_OPTION",
					"commercial_content_type is obsolete; set both explicit TikTok brand disclosure booleans instead.",
				);
			}
			if (publishMode === "inbox") {
				const directOnly = [
					"privacy_level",
					"allow_comment",
					"allow_duet",
					"allow_stitch",
					"brand_content_toggle",
					"brand_organic_toggle",
					"content_preview_confirmed",
					"express_consent_given",
					"video_made_with_ai",
					"auto_add_music",
					"video_cover_timestamp_ms",
				].filter((key) => opts[key] !== undefined);
				if (directOnly.length > 0) {
					return tikTokValidationError(
						"DIRECT_OPTION_WITH_INBOX_MODE",
						`TikTok inbox uploads do not accept Direct Post options: ${directOnly.join(", ")}.`,
					);
				}
			}
			const previousInit = getSucceededProviderEffect(
				request,
				"tiktok_publish_init",
			);
			if (previousInit?.provider_id) {
				try {
					const status = await pollPublishStatus(
						accessToken,
						previousInit.provider_id,
						1,
					);
					return tiktokStatusResult(
						previousInit.provider_id,
						status,
						mergeProviderEffects(request.effect_recorder?.effects),
					);
				} catch (error) {
					const classified = classifyPublishError(error);
					return {
						...classified,
						provider_outcome: {
							disposition: "outcome_unknown",
							provider_operation_id: previousInit.provider_id,
							effects: mergeProviderEffects(request.effect_recorder?.effects),
						},
					};
				}
			}

			// Resolve media
			const media =
				(opts.media as PublishRequest["media"] | undefined) ?? request.media;

			// TikTok requires media — no text-only posts
			if (media.length === 0) {
				return {
					success: false,
					error: {
						code: "MEDIA_REQUIRED",
						message:
							"TikTok requires video or photo media. Text-only posts are not supported.",
					},
				};
			}

			// Determine if this is a video or photo post
			const hasVideo = media.some((m) => m.type === "video");
			const hasImages = media.some((m) => !m.type || m.type === "image");
			const hasUnsupportedMedia = media.some(
				(m) => m.type && m.type !== "image" && m.type !== "video",
			);
			if (hasUnsupportedMedia) {
				// Official docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
				// and https://developers.tiktok.com/doc/content-posting-api-reference-photo-post/
				// Direct Post accepts VIDEO or PHOTO media; documents are unsupported.
				return {
					success: false,
					error: {
						code: "UNSUPPORTED_MEDIA_TYPE",
						message: "TikTok Direct Post supports video or photo media only.",
					},
				};
			}

			// Cannot mix photos and videos
			if (hasVideo && hasImages) {
				return {
					success: false,
					error: {
						code: "MIXED_MEDIA",
						message:
							"TikTok does not allow mixing photos and videos in the same post.",
					},
				};
			}

			// Video: only 1 video allowed
			if (hasVideo && media.length > 1) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_VIDEOS",
						message: "TikTok supports a maximum of 1 video per post.",
					},
				};
			}
			if (
				hasVideo &&
				publishMode === "direct" &&
				(typeof media[0]?.duration_ms !== "number" || media[0].duration_ms <= 0)
			) {
				return tikTokValidationError(
					"VIDEO_DURATION_REQUIRED",
					"TikTok requires media[0].duration_ms so RelayAPI can enforce this creator's current duration limit before publishing.",
				);
			}
			if (hasVideo && (media[0]?.duration_ms ?? 0) > 10 * 60 * 1000) {
				return tikTokValidationError(
					"VIDEO_TOO_LONG",
					"TikTok Direct Post supports videos up to 10 minutes.",
				);
			}

			// Photos: max 35
			if (hasImages && media.length > 35) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_PHOTOS",
						message: `TikTok supports a maximum of 35 photos per carousel. Got ${media.length}.`,
					},
				};
			}

			// Required options
			const privacyLevel = opts.privacy_level as string | undefined;
			if (publishMode === "direct" && !privacyLevel) {
				return {
					success: false,
					error: {
						code: "PRIVACY_LEVEL_REQUIRED",
						message: "TikTok requires privacy_level in target_options.",
					},
				};
			}

			if (
				publishMode === "direct" &&
				optionBoolean(opts, "allow_comment") === undefined
			) {
				return tikTokValidationError(
					"ALLOW_COMMENT_REQUIRED",
					"TikTok requires an explicit allow_comment choice; RelayAPI does not apply a default.",
				);
			}
			if (
				publishMode === "direct" &&
				hasVideo &&
				(optionBoolean(opts, "allow_duet") === undefined ||
					optionBoolean(opts, "allow_stitch") === undefined)
			) {
				return tikTokValidationError(
					"VIDEO_INTERACTIONS_REQUIRED",
					"TikTok video posts require explicit allow_duet and allow_stitch choices.",
				);
			}
			if (
				publishMode === "direct" &&
				(optionBoolean(opts, "brand_content_toggle") === undefined ||
					optionBoolean(opts, "brand_organic_toggle") === undefined)
			) {
				return tikTokValidationError(
					"COMMERCIAL_DISCLOSURE_REQUIRED",
					"TikTok requires explicit brand_content_toggle and brand_organic_toggle choices.",
				);
			}
			if (
				publishMode === "direct" &&
				(opts.content_preview_confirmed !== true ||
					opts.express_consent_given !== true)
			) {
				return tikTokValidationError(
					"TIKTOK_CONSENT_REQUIRED",
					"TikTok publishing requires a confirmed preview and explicit creator consent.",
				);
			}
			const verifiedUrlPrefixes = getTikTokVerifiedUrlPrefixes(
				request.account.metadata,
			);
			if (
				hasImages &&
				media.some(
					(item) =>
						!matchesTikTokVerifiedUrlPrefix(item.url, verifiedUrlPrefixes),
				)
			) {
				return tikTokValidationError(
					"TIKTOK_VERIFIED_MEDIA_URL_REQUIRED",
					"TikTok photo posts require every HTTPS image URL to be beneath an operator-configured TikTok-verified URL prefix.",
				);
			}
			if (hasImages && opts.source_mode === "file_upload") {
				return tikTokValidationError(
					"PHOTO_FILE_UPLOAD_UNSUPPORTED",
					"TikTok's photo endpoint supports PULL_FROM_URL only.",
				);
			}
			if (
				hasVideo &&
				(opts.photo_cover_index !== undefined ||
					opts.auto_add_music !== undefined)
			) {
				return tikTokValidationError(
					"PHOTO_OPTION_REQUIRES_PHOTOS",
					"TikTok photo_cover_index and auto_add_music are supported only for photo posts.",
				);
			}
			if (
				hasImages &&
				(opts.allow_duet !== undefined ||
					opts.allow_stitch !== undefined ||
					opts.video_cover_timestamp_ms !== undefined ||
					opts.video_made_with_ai !== undefined)
			) {
				return tikTokValidationError(
					"VIDEO_OPTION_REQUIRES_VIDEO",
					"TikTok allow_duet, allow_stitch, video_cover_timestamp_ms, and video_made_with_ai are supported only for video posts.",
				);
			}
			if (
				publishMode === "inbox" &&
				hasVideo &&
				opts.description !== undefined
			) {
				return tikTokValidationError(
					"VIDEO_INBOX_DESCRIPTION_UNSUPPORTED",
					"TikTok's video inbox endpoint accepts only source_info; add the caption when completing the post in TikTok.",
				);
			}
			const parsedOptions = TikTokTargetOptions.safeParse(opts);
			if (!parsedOptions.success) {
				const issue = parsedOptions.error.issues[0];
				const path = issue?.path.length ? ` ${issue.path.join(".")}` : "";
				return tikTokValidationError(
					"INVALID_TIKTOK_TARGET_OPTIONS",
					`Invalid TikTok target option${path}: ${issue?.message ?? "validation failed"}.`,
				);
			}
			opts = parsedOptions.data;

			if (publishMode === "direct") {
				let creatorInfo: NonNullable<TikTokCreatorInfoResponse["data"]>;
				try {
					creatorInfo = await queryTikTokCreatorInfo(accessToken);
				} catch (error) {
					return classifyPublishError(error, {
						safeToRetryRateLimit: true,
						definitiveHttpRejection: true,
					});
				}
				const creatorValidation = validateCreatorSelections(
					creatorInfo,
					opts,
					privacyLevel as string,
					hasVideo,
					media[0]?.duration_ms,
				);
				if (creatorValidation) return creatorValidation;
			}

			const allowComment = optionBoolean(opts, "allow_comment") ?? false;

			// Resolve content/description
			const content = (opts.content as string) ?? request.content ?? "";

			const username = request.account.username;

			let result: PublishResult;
			if (hasVideo) {
				result = await publishVideo(
					request,
					media[0] ?? { url: "", type: "video" },
					content,
					opts,
					privacyLevel ?? "",
					allowComment,
					verifiedUrlPrefixes,
					publishMode,
				);
			} else {
				result = await publishPhotos(
					request,
					media.map((m) => m.url),
					content,
					opts,
					privacyLevel ?? "",
					allowComment,
					publishMode,
				);
			}

			// Build platform URL
			if (result.success && username) {
				if (result.platform_post_id && result.platform_url === undefined) {
					// Only construct video URL if we have a real post ID (not the publish_id)
					result.platform_url = `https://www.tiktok.com/@${username}/video/${result.platform_post_id}`;
				} else if (!result.platform_url) {
					// Fallback to profile URL when no real post ID is available
					result.platform_url = `https://www.tiktok.com/@${username}`;
				}
			}

			return result;
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};

function inferTikTokVideoMimeType(
	declaredMimeType: string | undefined,
	response: Response,
	videoUrl: string,
): string | null {
	for (const candidate of [
		declaredMimeType,
		response.headers.get("content-type") ?? undefined,
	]) {
		const normalized = candidate?.split(";", 1)[0]?.trim().toLowerCase();
		if (normalized && TIKTOK_VIDEO_MIME_TYPES.has(normalized))
			return normalized;
	}
	try {
		const pathname = new URL(videoUrl).pathname.toLowerCase();
		if (pathname.endsWith(".mp4")) return "video/mp4";
		if (pathname.endsWith(".mov")) return "video/quicktime";
		if (pathname.endsWith(".webm")) return "video/webm";
	} catch {
		return null;
	}
	return null;
}

async function prepareTikTokVideoSource(
	media: PublishRequest["media"][number],
): Promise<{ response: Response; contentLength: number; mimeType: string }> {
	const fetchSource = () =>
		fetchPublicUrl(media.url, {
			method: "GET",
			timeout: 60_000,
		});
	let response = await fetchSource();
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new PublishError(
			`TikTok video source returned HTTP ${response.status}`,
			{ code: "MEDIA_FETCH_FAILED", statusCode: response.status },
		);
	}
	response = await ensureResponseContentLength(
		response,
		TIKTOK_VIDEO_MAX_BYTES,
		fetchSource,
	);
	const contentLength = parseContentLength(response.headers);
	if (!contentLength || contentLength > TIKTOK_VIDEO_MAX_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw new PublishError("TikTok video has an invalid or unsupported size", {
			code: "INVALID_VIDEO_SIZE",
		});
	}
	const mimeType = inferTikTokVideoMimeType(
		media.mime_type,
		response,
		media.url,
	);
	if (!mimeType) {
		await response.body?.cancel().catch(() => undefined);
		throw new PublishError(
			"TikTok videos must be MP4, MOV, or WebM with a matching media MIME type.",
			{ code: "UNSUPPORTED_VIDEO_FORMAT" },
		);
	}
	return { response, contentLength, mimeType };
}

function tikTokUploadPartSizes(contentLength: number): number[] {
	if (contentLength < 5_000_000) return [contentLength];
	const chunkSize = Math.min(TIKTOK_UPLOAD_CHUNK_BYTES, contentLength);
	const chunkCount = Math.max(1, Math.floor(contentLength / chunkSize));
	return Array.from({ length: chunkCount }, (_, index) =>
		index === chunkCount - 1
			? contentLength - chunkSize * (chunkCount - 1)
			: chunkSize,
	);
}

function validateTikTokUploadUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PublishError("TikTok returned an invalid upload_url", {
			code: "INVALID_UPLOAD_URL",
		});
	}
	const hostname = url.hostname.toLowerCase();
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		(url.port && url.port !== "443") ||
		url.hash ||
		!(hostname === "tiktokapis.com" || hostname.endsWith(".tiktokapis.com"))
	) {
		throw new PublishError("TikTok returned an untrusted upload_url", {
			code: "INVALID_UPLOAD_URL",
		});
	}
	return url.toString();
}

async function sendTikTokVideoChunks(
	uploadUrl: string,
	prepared: { response: Response; contentLength: number; mimeType: string },
): Promise<void> {
	const partSizes = tikTokUploadPartSizes(prepared.contentLength);
	const source = getChunkedResponseBody(
		prepared.response,
		TIKTOK_VIDEO_MAX_BYTES,
		partSizes,
	);
	let start = 0;
	let index = 0;
	for await (const chunk of source.chunks) {
		const end = start + chunk.byteLength - 1;
		let response: Response | null = null;
		let lastError: unknown;
		for (const delayMs of TIKTOK_UPLOAD_RETRY_DELAYS_MS) {
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
			try {
				response = await fetch(uploadUrl, {
					method: "PUT",
					headers: {
						"Content-Type": prepared.mimeType,
						"Content-Length": String(chunk.byteLength),
						"Content-Range": `bytes ${start}-${end}/${prepared.contentLength}`,
					},
					body: chunk,
				});
				if (response.status < 500) break;
				lastError = new PublishError(
					`TikTok upload returned HTTP ${response.status}`,
					{ statusCode: response.status },
				);
				await response.body?.cancel().catch(() => undefined);
				response = null;
			} catch (error) {
				// A transport failure may have occurred after TikTok accepted the range.
				// Do not replay an ambiguous binary mutation automatically.
				lastError = error;
				break;
			}
		}

		if (!response) throw lastError ?? new Error("TikTok upload failed");
		const isFinal = index === partSizes.length - 1;
		const expectedStatus = isFinal ? 201 : 206;
		if (response.status !== expectedStatus) {
			const detail = await readTikTokText(response).catch(() => "");
			throw new PublishError(
				`TikTok rejected video chunk ${index + 1} with HTTP ${response.status}`,
				{
					statusCode: response.status,
					detail: detail
						? `HTTP ${response.status}\n${detail}`
						: `HTTP ${response.status}`,
				},
			);
		}
		await response.body?.cancel().catch(() => undefined);
		start = end + 1;
		index++;
	}
}

async function publishVideo(
	request: PublishRequest,
	media: PublishRequest["media"][number],
	content: string,
	opts: Record<string, unknown>,
	privacyLevel: string,
	allowComment: boolean,
	verifiedUrlPrefixes: readonly string[],
	publishMode: TikTokPublishMode,
): Promise<PublishResult> {
	const accessToken = request.account.access_token;
	// Validate video caption length
	const caption = (opts.description as string | undefined) ?? content;
	if (publishMode === "direct" && caption.length > 2200) {
		return {
			success: false,
			error: {
				code: "CONTENT_TOO_LONG",
				message: `Video caption is ${caption.length} characters. TikTok limit is 2,200.`,
			},
		};
	}

	const postInfo: Record<string, unknown> = {};
	if (publishMode === "direct") {
		postInfo.title = caption;
		postInfo.privacy_level = privacyLevel;
		postInfo.disable_comment = !allowComment;
	}

	// Optional video settings
	if (publishMode === "direct" && opts.allow_duet !== undefined) {
		postInfo.disable_duet = !(opts.allow_duet as boolean);
	}
	if (publishMode === "direct" && opts.allow_stitch !== undefined) {
		postInfo.disable_stitch = !(opts.allow_stitch as boolean);
	}
	if (publishMode === "direct" && opts.video_cover_timestamp_ms !== undefined) {
		postInfo.video_cover_timestamp_ms = opts.video_cover_timestamp_ms as number;
	}
	if (publishMode === "direct" && opts.video_made_with_ai !== undefined) {
		postInfo.is_aigc = opts.video_made_with_ai as boolean;
	}
	if (publishMode === "direct" && opts.brand_content_toggle !== undefined) {
		postInfo.brand_content_toggle = opts.brand_content_toggle as boolean;
	}
	if (publishMode === "direct" && opts.brand_organic_toggle !== undefined) {
		postInfo.brand_organic_toggle = opts.brand_organic_toggle as boolean;
	}

	const requestedSourceMode = opts.source_mode;
	if (
		requestedSourceMode !== undefined &&
		requestedSourceMode !== "file_upload" &&
		requestedSourceMode !== "pull_from_url"
	) {
		return tikTokValidationError(
			"INVALID_SOURCE_MODE",
			"TikTok source_mode must be file_upload or pull_from_url.",
		);
	}
	const urlIsVerified = matchesTikTokVerifiedUrlPrefix(
		media.url,
		verifiedUrlPrefixes,
	);
	if (requestedSourceMode === "pull_from_url" && !urlIsVerified) {
		return tikTokValidationError(
			"TIKTOK_VERIFIED_MEDIA_URL_REQUIRED",
			"PULL_FROM_URL requires a URL beneath a TikTok-verified URL prefix configured by the RelayAPI operator.",
		);
	}
	const usePullFromUrl =
		requestedSourceMode === "pull_from_url" ||
		(requestedSourceMode === undefined && urlIsVerified);
	const prepared = usePullFromUrl
		? null
		: await prepareTikTokVideoSource(media);
	const partSizes = prepared
		? tikTokUploadPartSizes(prepared.contentLength)
		: null;

	const sourceInfo = usePullFromUrl
		? { source: "PULL_FROM_URL", video_url: media.url }
		: {
				source: "FILE_UPLOAD",
				video_size: prepared?.contentLength,
				chunk_size:
					partSizes && partSizes.length > 1
						? TIKTOK_UPLOAD_CHUNK_BYTES
						: prepared?.contentLength,
				total_chunk_count: partSizes?.length,
			};
	const body =
		publishMode === "direct"
			? { post_info: postInfo, source_info: sourceInfo }
			: { source_info: sourceInfo };

	// Official TikTok Content Posting API endpoints:
	// Direct Post: POST /v2/post/publish/video/init/
	// https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
	// Inbox upload: POST /v2/post/publish/inbox/video/init/ with source_info only
	// https://developers.tiktok.com/doc/content-posting-api-reference-upload-video/
	const initEndpoint =
		publishMode === "direct"
			? `${TIKTOK_API}/post/publish/video/init/`
			: `${TIKTOK_API}/post/publish/inbox/video/init/`;
	let res: Response;
	try {
		res = await tiktokFetch(initEndpoint, accessToken, {
			method: "POST",
			body: JSON.stringify(body),
		});
	} catch (error) {
		await prepared?.response.body?.cancel().catch(() => undefined);
		const result = classifyPublishError(error, {
			safeToRetryRateLimit: true,
		});
		if (result.error?.code === "RATE_LIMITED") return result;
		throw error;
	}

	if (!res.ok) {
		await prepared?.response.body?.cancel().catch(() => undefined);
		const err = await readTikTokError(res);
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			res.statusText;
		throw new PublishError(
			`TikTok video ${publishMode} init failed: ${detail}`,
			{
				statusCode: res.status,
				detail: raw,
			},
		);
	}

	let initResult: TikTokPublishResponse;
	try {
		initResult = await readResponseJson<TikTokPublishResponse>(
			res,
			TIKTOK_JSON_MAX_BYTES,
		);
	} catch (error) {
		await prepared?.response.body?.cancel().catch(() => undefined);
		throw error;
	}

	if (initResult.error?.code && initResult.error.code !== "ok") {
		await prepared?.response.body?.cancel().catch(() => undefined);
		// Classify TikTok-specific error codes
		const errCode = initResult.error.code;
		if (errCode === "access_token_invalid" || errCode === "token_expired") {
			throw new Error(
				`TOKEN_EXPIRED: ${initResult.error.message ?? "TikTok token invalid"}`,
			);
		}
		if (errCode === "rate_limit_exceeded") {
			return {
				success: false,
				retry: { disposition: "safe_to_retry" },
				error: {
					code: "RATE_LIMITED",
					message: initResult.error.message ?? "TikTok rate limit exceeded",
				},
			};
		}
		if (errCode === "spam_risk_too_many_posts") {
			return {
				success: false,
				error: {
					code: errCode,
					message:
						initResult.error.message ?? "TikTok rejected the posting frequency",
				},
			};
		}
		return {
			success: false,
			error: {
				code: errCode,
				message: initResult.error.message ?? "TikTok video init failed.",
			},
		};
	}

	const publishId = initResult.data?.publish_id;
	if (!publishId) {
		await prepared?.response.body?.cancel().catch(() => undefined);
		return {
			success: false,
			error: {
				code: "MISSING_PUBLISH_ID",
				message: "TikTok did not return a publish_id.",
			},
		};
	}
	const initEffect: ProviderEffect = {
		name: "tiktok_publish_init",
		status: "succeeded",
		provider_id: publishId,
	};
	try {
		await recordProviderEffect(request, initEffect);
	} catch (error) {
		await prepared?.response.body?.cancel().catch(() => undefined);
		return {
			...classifyPublishError(error),
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_operation_id: publishId,
				provider_state: "INIT_CONFIRMED_EFFECT_JOURNAL_FAILED",
				effects: mergeProviderEffects(request.effect_recorder?.effects, [
					initEffect,
				]),
			},
		};
	}
	const effects = mergeProviderEffects(request.effect_recorder?.effects, [
		initEffect,
	]);

	if (prepared) {
		const uploadUrl = initResult.data?.upload_url;
		if (!uploadUrl) {
			await prepared.response.body?.cancel().catch(() => undefined);
			return {
				success: false,
				provider_outcome: {
					disposition: "partial",
					provider_operation_id: publishId,
					provider_state: "MISSING_UPLOAD_URL",
					effects,
				},
				error: {
					code: "MISSING_UPLOAD_URL",
					message: "TikTok accepted the publish job but omitted upload_url.",
				},
			};
		}
		try {
			await sendTikTokVideoChunks(validateTikTokUploadUrl(uploadUrl), prepared);
			const uploadEffect: ProviderEffect = {
				name: "tiktok_video_upload",
				status: "succeeded",
				provider_id: publishId,
			};
			await recordProviderEffect(request, uploadEffect);
			effects.push(uploadEffect);
		} catch (error) {
			const classified = classifyPublishError(error);
			return {
				...classified,
				provider_outcome: {
					disposition: "partial",
					provider_operation_id: publishId,
					provider_state: "UPLOAD_INCOMPLETE",
					effects,
				},
			};
		}
	}

	// Poll for completion
	let status: TikTokStatusResponse;
	try {
		status = await pollPublishStatus(accessToken, publishId);
	} catch (error) {
		return {
			...classifyPublishError(error),
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_operation_id: publishId,
				provider_state: "STATUS_UNAVAILABLE",
				effects,
			},
		};
	}

	return tiktokStatusResult(publishId, status, effects);
}

async function publishPhotos(
	request: PublishRequest,
	photoUrls: string[],
	content: string,
	opts: Record<string, unknown>,
	privacyLevel: string,
	allowComment: boolean,
	publishMode: TikTokPublishMode,
): Promise<PublishResult> {
	const accessToken = request.account.access_token;
	// Photo size limit: 20MB per image (validated server-side for PULL_FROM_URL)
	// Docs: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
	const coverIndex = (opts.photo_cover_index as number | undefined) ?? 0;
	if (
		!Number.isInteger(coverIndex) ||
		coverIndex < 0 ||
		coverIndex >= photoUrls.length
	) {
		return tikTokValidationError(
			"INVALID_PHOTO_COVER_INDEX",
			"photo_cover_index must identify an image in the TikTok carousel.",
		);
	}

	// Photo title: max 90 characters. Slice Unicode code points so a supplementary
	// character is never split into an invalid lone surrogate.
	const title = Array.from(content).slice(0, 90).join("");

	// Description for photo carousels
	const description = (opts.description as string | undefined) ?? content;
	if (description.length > 4000) {
		return {
			success: false,
			error: {
				code: "CONTENT_TOO_LONG",
				message: `Photo description is ${description.length} characters. TikTok limit is 4,000.`,
			},
		};
	}

	const postInfo: Record<string, unknown> = { title, description };
	if (publishMode === "direct") {
		postInfo.privacy_level = privacyLevel;
		postInfo.disable_comment = !allowComment;
	}

	if (publishMode === "direct" && opts.auto_add_music !== undefined) {
		postInfo.auto_add_music = opts.auto_add_music as boolean;
	}
	// TikTok requires both disclosure booleans for DIRECT_POST photo posts.
	// Docs: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
	if (publishMode === "direct") {
		postInfo.brand_content_toggle = opts.brand_content_toggle as boolean;
		postInfo.brand_organic_toggle = opts.brand_organic_toggle as boolean;
	}

	// photo_cover_index belongs in source_info, not post_info
	const sourceInfo: Record<string, unknown> = {
		source: "PULL_FROM_URL",
		photo_images: photoUrls,
		photo_cover_index: coverIndex,
	};

	const body = {
		post_info: postInfo,
		source_info: sourceInfo,
		post_mode: publishMode === "direct" ? "DIRECT_POST" : "MEDIA_UPLOAD",
		media_type: "PHOTO",
	};

	// TikTok Content Posting API — Initialize direct photo publishing or the
	// official creator-inbox MEDIA_UPLOAD flow on the same endpoint.
	// https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
	let res: Response;
	try {
		res = await tiktokFetch(
			`${TIKTOK_API}/post/publish/content/init/`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		);
	} catch (error) {
		const result = classifyPublishError(error, {
			safeToRetryRateLimit: true,
		});
		if (result.error?.code === "RATE_LIMITED") return result;
		throw error;
	}

	if (!res.ok) {
		const err = await readTikTokError(res);
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			res.statusText;
		throw new PublishError(`TikTok photo init failed: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}

	const initResult = await readResponseJson<TikTokPublishResponse>(
		res,
		TIKTOK_JSON_MAX_BYTES,
	);

	if (initResult.error?.code && initResult.error.code !== "ok") {
		if (initResult.error.code === "rate_limit_exceeded") {
			return {
				success: false,
				retry: { disposition: "safe_to_retry" },
				error: {
					code: "RATE_LIMITED",
					message: initResult.error.message ?? "TikTok rate limit exceeded",
				},
			};
		}
		if (initResult.error.code === "spam_risk_too_many_posts") {
			return {
				success: false,
				error: {
					code: initResult.error.code,
					message:
						initResult.error.message ?? "TikTok rejected the posting frequency",
				},
			};
		}
		return {
			success: false,
			error: {
				code: initResult.error.code,
				message: initResult.error.message ?? "TikTok photo init failed.",
			},
		};
	}

	const publishId = initResult.data?.publish_id;
	if (!publishId) {
		return {
			success: false,
			error: {
				code: "MISSING_PUBLISH_ID",
				message: "TikTok did not return a publish_id.",
			},
		};
	}
	const initEffect: ProviderEffect = {
		name: "tiktok_publish_init",
		status: "succeeded",
		provider_id: publishId,
	};
	try {
		await recordProviderEffect(request, initEffect);
	} catch (error) {
		return {
			...classifyPublishError(error),
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_operation_id: publishId,
				provider_state: "INIT_CONFIRMED_EFFECT_JOURNAL_FAILED",
				effects: mergeProviderEffects(request.effect_recorder?.effects, [
					initEffect,
				]),
			},
		};
	}
	const effects = mergeProviderEffects(request.effect_recorder?.effects, [
		initEffect,
	]);

	// Poll for completion
	let status: TikTokStatusResponse;
	try {
		status = await pollPublishStatus(accessToken, publishId);
	} catch (error) {
		return {
			...classifyPublishError(error),
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_operation_id: publishId,
				provider_state: "STATUS_UNAVAILABLE",
				effects,
			},
		};
	}

	return tiktokStatusResult(publishId, status, effects);
}
