import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { createDb } from "@relayapi/db";
import { getOwnedAccount } from "../lib/accounts";
import { isBlockedUrl } from "../lib/ssrf-guard";
import { IdParam, ErrorResponse } from "../schemas/common";
import {
	GmbFoodMenuBody,
	GmbFoodMenuResponse,
	GmbLocationDetailsQuery,
	GmbLocationDetailsBody,
	GmbLocationDetailsResponse,
	GmbUploadMediaBody,
	GmbMediaDeleteQuery,
	GmbMediaResponse,
	GmbAttributeBody,
	GmbAttributesResponse,
	GmbPlaceActionBody,
	GmbPlaceActionDeleteQuery,
	GmbPlaceActionsResponse,
} from "../schemas/gmb";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function getGmbContext(
	db: ReturnType<typeof createDb>,
	accountId: string,
	orgId: string,
	encryptionKey?: string,
	workspaceScope: "all" | string[] = "all",
) {
	const account = await getOwnedAccount(db, accountId, orgId, encryptionKey);
	if (!account || account.platform !== "googlebusiness") return null;
	if (workspaceScope !== "all") {
		if (!account.workspaceId || !workspaceScope.includes(account.workspaceId)) {
			return null;
		}
	}
	if (!account.accessToken) return null;

	const metadata = account.metadata as Record<string, string> | null;
	const locationName = metadata?.location_id ?? account.platformAccountId;
	const googleAccountName = metadata?.google_account_name ?? null;

	return { account, locationName, googleAccountName, accessToken: account.accessToken };
}

async function gmbFetch(
	accessToken: string,
	url: string,
	method: string,
	body?: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; code: string; message: string }> {
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	if (res.ok) {
		const text = await res.text();
		return { ok: true, data: text ? JSON.parse(text) : {} };
	}

	let message = `Google API error (${res.status})`;
	try {
		const errBody = (await res.json()) as { error?: { message?: string } };
		if (errBody.error?.message) message = errBody.error.message;
	} catch {}

	const codeMap: Record<number, string> = {
		401: "UNAUTHORIZED",
		403: "FORBIDDEN",
		404: "NOT_FOUND",
	};

	return {
		ok: false,
		status: res.status,
		code: codeMap[res.status] ?? "GOOGLE_API_ERROR",
		message,
	};
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

// --- Food Menus ---

const getFoodMenus = createRoute({
	operationId: "getGmbFoodMenus",
	method: "get",
	path: "/{id}/gmb-food-menus",
	tags: ["Google Business"],
	summary: "Get food menus",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: { description: "Food menus", content: { "application/json": { schema: GmbFoodMenuResponse } } },
		400: { description: "Google account name unavailable", content: { "application/json": { schema: ErrorResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const putFoodMenus = createRoute({
	operationId: "updateGmbFoodMenus",
	method: "put",
	path: "/{id}/gmb-food-menus",
	tags: ["Google Business"],
	summary: "Update food menus",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: GmbFoodMenuBody } } },
	},
	responses: {
		200: { description: "Updated food menus", content: { "application/json": { schema: GmbFoodMenuResponse } } },
		400: { description: "Google account name unavailable", content: { "application/json": { schema: ErrorResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

// --- Location Details ---

const getLocationDetails = createRoute({
	operationId: "getGmbLocationDetails",
	method: "get",
	path: "/{id}/gmb-location-details",
	tags: ["Google Business"],
	summary: "Get location details",
	security: [{ Bearer: [] }],
	request: { params: IdParam, query: GmbLocationDetailsQuery },
	responses: {
		200: { description: "Location details", content: { "application/json": { schema: GmbLocationDetailsResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const putLocationDetails = createRoute({
	operationId: "updateGmbLocationDetails",
	method: "put",
	path: "/{id}/gmb-location-details",
	tags: ["Google Business"],
	summary: "Update location details",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: GmbLocationDetailsBody } } },
	},
	responses: {
		200: { description: "Updated location details", content: { "application/json": { schema: GmbLocationDetailsResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

// --- Media/Photos ---

const getMedia = createRoute({
	operationId: "getGmbMedia",
	method: "get",
	path: "/{id}/gmb-media",
	tags: ["Google Business"],
	summary: "List media/photos",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: { description: "Media list", content: { "application/json": { schema: GmbMediaResponse } } },
		400: { description: "Google account name unavailable", content: { "application/json": { schema: ErrorResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const postMedia = createRoute({
	operationId: "uploadGmbMedia",
	method: "post",
	path: "/{id}/gmb-media",
	tags: ["Google Business"],
	summary: "Upload media/photo",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: GmbUploadMediaBody } } },
	},
	responses: {
		200: { description: "Uploaded media", content: { "application/json": { schema: GmbMediaResponse } } },
		400: { description: "Google account name unavailable", content: { "application/json": { schema: ErrorResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const deleteMedia = createRoute({
	operationId: "deleteGmbMedia",
	method: "delete",
	path: "/{id}/gmb-media",
	tags: ["Google Business"],
	summary: "Delete a media item",
	security: [{ Bearer: [] }],
	request: { params: IdParam, query: GmbMediaDeleteQuery },
	responses: {
		200: { description: "Media deleted", content: { "application/json": { schema: GmbMediaResponse } } },
		400: { description: "Google account name unavailable", content: { "application/json": { schema: ErrorResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

// --- Attributes ---

const getAttributes = createRoute({
	operationId: "getGmbAttributes",
	method: "get",
	path: "/{id}/gmb-attributes",
	tags: ["Google Business"],
	summary: "Get business attributes",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: { description: "Attributes", content: { "application/json": { schema: GmbAttributesResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const putAttributes = createRoute({
	operationId: "updateGmbAttributes",
	method: "put",
	path: "/{id}/gmb-attributes",
	tags: ["Google Business"],
	summary: "Update business attributes",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: GmbAttributeBody } } },
	},
	responses: {
		200: { description: "Updated attributes", content: { "application/json": { schema: GmbAttributesResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

// --- Place Actions ---

const getPlaceActions = createRoute({
	operationId: "getGmbPlaceActions",
	method: "get",
	path: "/{id}/gmb-place-actions",
	tags: ["Google Business"],
	summary: "List place action links",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: { description: "Place action links", content: { "application/json": { schema: GmbPlaceActionsResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const postPlaceAction = createRoute({
	operationId: "createGmbPlaceAction",
	method: "post",
	path: "/{id}/gmb-place-actions",
	tags: ["Google Business"],
	summary: "Create a place action link",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: GmbPlaceActionBody } } },
	},
	responses: {
		200: { description: "Created place action", content: { "application/json": { schema: GmbPlaceActionsResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const deletePlaceAction = createRoute({
	operationId: "deleteGmbPlaceAction",
	method: "delete",
	path: "/{id}/gmb-place-actions",
	tags: ["Google Business"],
	summary: "Delete a place action link",
	security: [{ Bearer: [] }],
	request: { params: IdParam, query: GmbPlaceActionDeleteQuery },
	responses: {
		200: { description: "Place action deleted", content: { "application/json": { schema: GmbPlaceActionsResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function notFound(c: any) {
	return c.json({ error: { code: "NOT_FOUND", message: "Account not found or not a Google Business account" } }, 404);
}

function missingGoogleAccount(c: any) {
	return c.json({ error: { code: "MISSING_GOOGLE_ACCOUNT", message: "Google Account ID not available. Please reconnect the account." } }, 400);
}

function googleError(c: any, err: { status: number; code: string; message: string }) {
	const httpStatus = err.status >= 400 && err.status < 600 ? err.status : 502;
	return c.json({ error: { code: err.code, message: err.message } }, httpStatus as any);
}

// --- Food Menus (v4 — needs googleAccountName) ---

app.openapi(getFoodMenus, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);
	if (!ctx.googleAccountName) return missingGoogleAccount(c);

	// Google Business Profile — Get food menus
	// https://developers.google.com/my-business/reference/rest/v4/accounts.locations.foodMenus
	const url = `https://mybusiness.googleapis.com/v4/${ctx.googleAccountName}/${ctx.locationName}/foodMenus`;
	const result = await gmbFetch(ctx.accessToken, url, "GET");
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

app.openapi(putFoodMenus, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);
	if (!ctx.googleAccountName) return missingGoogleAccount(c);

	// Google Business Profile — Update food menus
	// https://developers.google.com/my-business/reference/rest/v4/accounts.locations.foodMenus/patch
	const { update_mask, ...menuData } = body;
	const maskParam = update_mask ? `?updateMask=${encodeURIComponent(update_mask)}` : "";
	const url = `https://mybusiness.googleapis.com/v4/${ctx.googleAccountName}/${ctx.locationName}/foodMenus${maskParam}`;
	const result = await gmbFetch(ctx.accessToken, url, "PATCH", menuData);
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

// --- Location Details (v1) ---

app.openapi(getLocationDetails, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const query = c.req.valid("query");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);

	// Google Business Information — Get location
	// https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/get
	const maskParam = query.read_mask ? `?readMask=${encodeURIComponent(query.read_mask)}` : "";
	const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${ctx.locationName}${maskParam}`;
	const result = await gmbFetch(ctx.accessToken, url, "GET");
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

app.openapi(putLocationDetails, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);

	// Google Business Information — Patch location
	// https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/patch
	const { update_mask, ...locationData } = body;
	const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${ctx.locationName}?updateMask=${encodeURIComponent(update_mask)}`;
	const result = await gmbFetch(ctx.accessToken, url, "PATCH", locationData);
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

// --- Media/Photos (v4 — needs googleAccountName) ---

app.openapi(getMedia, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);
	if (!ctx.googleAccountName) return missingGoogleAccount(c);

	// Google Business Profile — List media
	// https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media/list
	const url = `https://mybusiness.googleapis.com/v4/${ctx.googleAccountName}/${ctx.locationName}/media`;
	const result = await gmbFetch(ctx.accessToken, url, "GET");
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

app.openapi(postMedia, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);
	if (!ctx.googleAccountName) return missingGoogleAccount(c);

	// SECURITY: Block private/internal URLs
	if (isBlockedUrl(body.source_url)) {
		return c.json(
			{ error: { code: "INVALID_URL", message: "source_url targets a blocked address" } } as never,
			400 as never,
		);
	}

	// Google Business Profile — Create media
	// https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media/create
	const url = `https://mybusiness.googleapis.com/v4/${ctx.googleAccountName}/${ctx.locationName}/media`;
	const result = await gmbFetch(ctx.accessToken, url, "POST", {
		mediaFormat: "PHOTO",
		locationAssociation: { category: body.category },
		sourceUrl: body.source_url,
		description: body.description,
	});
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

app.openapi(deleteMedia, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { media_id } = c.req.valid("query");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);
	if (!ctx.googleAccountName) return missingGoogleAccount(c);

	// Google Business Profile — Delete media
	// https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media/delete
	const url = `https://mybusiness.googleapis.com/v4/${ctx.googleAccountName}/${ctx.locationName}/media/${media_id}`;
	const result = await gmbFetch(ctx.accessToken, url, "DELETE");
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

// --- Attributes (v1) ---

app.openapi(getAttributes, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);

	// Google Business Information — Get attributes
	// https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations.attributes/getGoogleUpdated
	const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${ctx.locationName}/attributes`;
	const result = await gmbFetch(ctx.accessToken, url, "GET");
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

app.openapi(putAttributes, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);

	// Google Business Information — Patch attributes
	// https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations.attributes
	const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${ctx.locationName}/attributes?attributeMask=${encodeURIComponent(body.attribute_mask)}`;
	const result = await gmbFetch(ctx.accessToken, url, "PATCH", { attributes: body.attributes });
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

// --- Place Actions (v1) ---

app.openapi(getPlaceActions, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);

	// Google Business Place Actions — List place action links
	// https://developers.google.com/my-business/reference/placeactions/rest/v1/locations.placeActionLinks/list
	const url = `https://mybusinessplaceactions.googleapis.com/v1/${ctx.locationName}/placeActionLinks`;
	const result = await gmbFetch(ctx.accessToken, url, "GET");
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

app.openapi(postPlaceAction, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);

	// Google Business Place Actions — Create place action link
	// https://developers.google.com/my-business/reference/placeactions/rest/v1/locations.placeActionLinks/create
	const url = `https://mybusinessplaceactions.googleapis.com/v1/${ctx.locationName}/placeActionLinks`;
	const result = await gmbFetch(ctx.accessToken, url, "POST", {
		placeActionType: body.type,
		uri: body.url,
		...(body.name && { name: body.name }),
	});
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

app.openapi(deletePlaceAction, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { action_id } = c.req.valid("query");
	const db = c.get("db");
	const ctx = await getGmbContext(db, id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!ctx) return notFound(c);

	// Google Business Place Actions — Delete place action link
	// https://developers.google.com/my-business/reference/placeactions/rest/v1/locations.placeActionLinks/delete
	const url = `https://mybusinessplaceactions.googleapis.com/v1/${ctx.locationName}/placeActionLinks/${action_id}`;
	const result = await gmbFetch(ctx.accessToken, url, "DELETE");
	if (!result.ok) return googleError(c, result);
	return c.json({ data: result.data }, 200);
});

export default app;
