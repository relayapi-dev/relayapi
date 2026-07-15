import { describe, expect, it } from "bun:test";
import type { z } from "@hono/zod-openapi";
import { Relay } from "../../../../packages/sdk/src/client";
import type {
	PostBulkCreateResponse,
	PostBulkCreateParams,
	PostCreateParams,
	PostCreateResponse,
	PostListParams,
	PostListResponse,
	PostMetrics,
	PostReconcileTargetParams,
	PostReconcileTargetResponse,
	PostRetrieveResponse,
	PostRetryResponse,
	PostTargetPlatform,
	PostTargetStatus,
	PostUnpublishResponse,
	PostUpdateResponse,
} from "../../../../packages/sdk/src/resources/posts/posts";
import { FilterParams, type Platform } from "../schemas/common";
import type { CreatePostBody, PostResponse } from "../schemas/posts";

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
			? true
			: false
		: false;
type Assert<T extends true> = T;

type ApiPost = z.infer<typeof PostResponse>;
type ApiCreatePost = z.input<typeof CreatePostBody>;
type ApiListPosts = z.input<typeof FilterParams>;
type SdkPost =
	| PostCreateResponse
	| PostRetrieveResponse
	| PostUpdateResponse
	| PostListResponse["data"][number]
	| PostBulkCreateResponse["data"][number]
	| PostRetryResponse
	| PostUnpublishResponse;
type TemplateKeys = "template_id" | "template_variables" | "skip_signature";
type ApiTargetAccount = NonNullable<
	ApiPost["targets"][string]["accounts"]
>[number];
type SdkTargetAccount = NonNullable<
	PostRetrieveResponse["targets"][string]["accounts"]
>[number];

// These compile-time assertions make API typecheck fail if the checked-in SDK
// falls behind the API schema again.
type _PlatformParity = Assert<Equal<Platform, PostTargetPlatform>>;
type _TargetStatusParity = Assert<
	Equal<ApiPost["targets"][string]["status"], PostTargetStatus>
>;
type _TargetPlatformParity = Assert<
	Equal<
		ApiPost["targets"][string]["platform"],
		PostRetrieveResponse["targets"][string]["platform"]
	>
>;
type _PostStatusParity = Assert<Equal<ApiPost["status"], SdkPost["status"]>>;
type _MetricsParity = Assert<
	Equal<NonNullable<ApiPost["metrics"]>, NonNullable<SdkPost["metrics"]>>
>;
type _MetricsAliasParity = Assert<
	Equal<NonNullable<ApiPost["metrics"]>, PostMetrics>
>;
type _CreateTemplateParity = Assert<
	Equal<Pick<ApiCreatePost, TemplateKeys>, Pick<PostCreateParams, TemplateKeys>>
>;
type _BulkCreateParity = Assert<
	Equal<PostBulkCreateParams["posts"][number], PostCreateParams>
>;
type _ListStatusParity = Assert<
	Equal<ApiListPosts["status"], PostListParams["status"]>
>;
type _PublishOperationParity = Assert<
	Equal<
		Pick<ApiTargetAccount, "publish_operation_id" | "delivery_state">,
		Pick<SdkTargetAccount, "publish_operation_id" | "delivery_state">
	>
>;

const _reconcileRequest: PostReconcileTargetParams = {
	outcome: "failed",
	publish_operation_id: "pubop_contract",
	error_code: "PROVIDER_REJECTED",
	error_message: "Provider confirmed that no post was created",
};
const _reconcileResponse: PostReconcileTargetResponse = {
	post_id: "post_contract",
	target_id: "pt_contract",
	publish_operation_id: "pubop_contract",
	outcome: "failed",
	post_status: "failed",
	thread_status: null,
};

describe("API/SDK contract parity", () => {
	it("encodes Ideas media as multipart with a generated boundary", async () => {
		let capturedRequest: Request | undefined;
		const client = new Relay({
			apiKey: "rlay_test_contract",
			maxRetries: 0,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				capturedRequest = new Request(input, init);
				return new Response(
					JSON.stringify({
						id: "idea_media_123",
						url: "https://media.relayapi.dev/idea_media_123.png",
						type: "image",
						alt: "Contract image",
						position: 0,
					}),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				);
			}) as typeof fetch,
		});

		await client.ideas.uploadMedia("idea_123", {
			file: new File(["image bytes"], "contract.png", {
				type: "image/png",
			}),
			alt: "Contract image",
		});

		expect(capturedRequest).toBeDefined();
		expect(capturedRequest?.headers.get("content-type")).toStartWith(
			"multipart/form-data; boundary=",
		);
		const form = await capturedRequest?.formData();
		expect((form?.get("file") as File | null)?.name).toBe("contract.png");
		expect(form?.get("alt")).toBe("Contract image");
	});

	it("accepts partial as a post list filter", () => {
		expect(FilterParams.safeParse({ status: "partial" }).success).toBe(true);
	});

	it("sends stable target reconciliation through the SDK", async () => {
		let capturedRequest: Request | undefined;
		const client = new Relay({
			apiKey: "rlay_test_contract",
			maxRetries: 0,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				capturedRequest = new Request(input, init);
				return Response.json(_reconcileResponse);
			}) as typeof fetch,
		});

		await client.posts.reconcileTarget(
			"post_contract",
			"pt_contract",
			_reconcileRequest,
		);

		expect(new URL(capturedRequest?.url ?? "http://invalid").pathname).toBe(
			"/v1/posts/post_contract/targets/pt_contract/reconcile",
		);
		const issuedRequest = capturedRequest as Request | undefined;
		if (!issuedRequest) throw new Error("SDK did not issue a request");
		const requestBody: unknown = await issuedRequest.json();
		expect(requestBody).toEqual(_reconcileRequest);
	});
});
