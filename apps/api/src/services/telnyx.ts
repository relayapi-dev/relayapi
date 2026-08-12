// ---------------------------------------------------------------------------
// Telnyx Phone Number Management Service
// Docs: https://developers.telnyx.com/api/numbers
// ---------------------------------------------------------------------------

import { readResponseJson } from "../lib/fetch-public-url";
import { fetchWithTimeout } from "../lib/fetch-timeout";

const TELNYX_API = "https://api.telnyx.com/v2";
const TELNYX_RESPONSE_MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelnyxAvailableNumber {
	phone_number: string;
	region_information: { region_name: string; region_type: string }[];
}

export interface SearchOptions {
	countryCode?: string;
	areaCode?: string;
	limit?: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TelnyxError extends Error {
	code: string;
	status: number;

	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "TelnyxError";
		this.code = code;
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function telnyxFetch<T = unknown>(
	url: string,
	apiKey: string,
	options: RequestInit = {},
): Promise<T> {
	const res = await fetchWithTimeout(url, {
		...options,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			...options.headers,
		},
		timeout: 5_000,
		timeoutThroughBody: true,
	});

	if (!res.ok) {
		type TelnyxErrorBody = {
			errors?: { code?: string; title?: string; detail?: string }[];
		};
		const body = await readResponseJson<TelnyxErrorBody>(
			res,
			TELNYX_RESPONSE_MAX_BYTES,
		).catch((): TelnyxErrorBody => ({}));
		const first = body.errors?.[0];
		throw new TelnyxError(
			first?.code ?? `HTTP_${res.status}`,
			first?.detail ?? first?.title ?? `Telnyx API error: ${res.status}`,
			res.status,
		);
	}

	// DELETE responses may return 204 with no body
	if (res.status === 204) {
		return undefined as T;
	}

	return readResponseJson<T>(res, TELNYX_RESPONSE_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search for available phone numbers on Telnyx.
 * GET /v2/available_phone_numbers
 */
export async function searchAvailableNumbers(
	apiKey: string,
	opts: SearchOptions,
): Promise<TelnyxAvailableNumber[]> {
	const params = new URLSearchParams();
	params.set("filter[country_code]", opts.countryCode ?? "US");
	if (opts.areaCode) {
		params.set("filter[national_destination_code]", opts.areaCode);
	}
	if (opts.limit) {
		params.set("filter[limit]", String(opts.limit));
	}

	const data = await telnyxFetch<{
		data: TelnyxAvailableNumber[];
	}>(`${TELNYX_API}/available_phone_numbers?${params.toString()}`, apiKey);

	return data.data;
}

/**
 * Order (purchase) a phone number.
 * POST /v2/number_orders
 */
export async function orderNumber(
	apiKey: string,
	phoneNumber: string,
	customerReference?: string,
): Promise<{ orderId: string; phoneNumberId: string; phoneNumbers: string[] }> {
	const data = await telnyxFetch<{
		data: {
			id: string;
			phone_numbers: { id: string; phone_number: string }[];
		};
	}>(`${TELNYX_API}/number_orders`, apiKey, {
		method: "POST",
		body: JSON.stringify({
			phone_numbers: [{ phone_number: phoneNumber }],
			...(customerReference ? { customer_reference: customerReference } : {}),
		}),
	});

	return {
		orderId: data.data.id,
		phoneNumberId: data.data.phone_numbers[0]?.id ?? data.data.id,
		phoneNumbers: data.data.phone_numbers.map((pn) => pn.phone_number),
	};
}

/**
 * Look up a possibly-created order after an ambiguous POST outcome. Telnyx's
 * customer_reference is explicitly intended for customer lookups, so the
 * durable RelayAPI operation id is used as the provider correlation key.
 */
export async function findNumberOrderByCustomerReference(
	apiKey: string,
	customerReference: string,
): Promise<{
	orderId: string;
	phoneNumberId: string;
	phoneNumbers: string[];
} | null> {
	const params = new URLSearchParams({
		"filter[customer_reference]": customerReference,
		"page[size]": "2",
	});
	const response = await telnyxFetch<{
		data: Array<{
			id: string;
			customer_reference?: string | null;
			phone_numbers?: Array<{ id?: string; phone_number: string }>;
		}>;
	}>(`${TELNYX_API}/number_orders?${params.toString()}`, apiKey);
	const matches = response.data.filter(
		(order) => order.customer_reference === customerReference,
	);
	if (matches.length !== 1) return null;
	const order = matches[0];
	if (!order) return null;
	const numbers = order.phone_numbers ?? [];
	return {
		orderId: order.id,
		phoneNumberId: numbers[0]?.id ?? order.id,
		phoneNumbers: numbers.map((number) => number.phone_number),
	};
}

/**
 * Resolve the configured phone-number resource after a successful order.
 * Number-order responses contain `number_order_phone_number` IDs, which are
 * not valid IDs for DELETE /phone_numbers/{id}. The high-rate slim list is the
 * authoritative mapping from E.164 number to the owned `phone_number` ID.
 *
 * Official docs:
 * https://developers.telnyx.com/api-reference/phone-number-configurations/slim-list-phone-numbers
 * GET /v2/phone_numbers/slim, filter[phone_number]
 */
export async function findOwnedPhoneNumber(
	apiKey: string,
	phoneNumber: string,
): Promise<{ id: string; phoneNumber: string } | null> {
	const params = new URLSearchParams();
	params.set("filter[phone_number]", phoneNumber);
	params.set("page[size]", "1");
	const data = await telnyxFetch<{
		data: Array<{ id: string; phone_number: string }>;
	}>(`${TELNYX_API}/phone_numbers/slim?${params.toString()}`, apiKey);
	const match = data.data.find(
		(row) =>
			row.phone_number.replace(/\D/g, "") === phoneNumber.replace(/\D/g, ""),
	);
	return match ? { id: match.id, phoneNumber: match.phone_number } : null;
}

/**
 * Enumerate the complete Telnyx account inventory for the pre-live money-path
 * gate. This is deliberately account-wide so a lost local row cannot hide a
 * still-rented number.
 *
 * Official docs:
 * https://developers.telnyx.com/api-reference/phone-number-configurations/slim-list-phone-numbers
 * GET /v2/phone_numbers/slim, page[size], page[number]
 */
export async function listOwnedPhoneNumbers(apiKey: string): Promise<
	Array<{
		id: string;
		phoneNumber: string;
		status: string | null;
		customerReference: string | null;
	}>
> {
	const rows: Array<{
		id: string;
		phoneNumber: string;
		status: string | null;
		customerReference: string | null;
	}> = [];
	let expectedTotalPages: number | undefined;
	let expectedTotalResults: number | undefined;
	for (let pageNumber = 1; pageNumber <= 10_000; pageNumber++) {
		const params = new URLSearchParams({
			"page[number]": String(pageNumber),
			"page[size]": "100",
		});
		const response = await telnyxFetch<{
			data: Array<{
				id: string;
				phone_number: string;
				status?: string | null;
				customer_reference?: string | null;
			}>;
			meta?: {
				page_number?: number;
				page_size?: number;
				total_pages?: number;
				total_results?: number;
			};
		}>(`${TELNYX_API}/phone_numbers/slim?${params.toString()}`, apiKey);
		for (const row of response.data) {
			if (!row.id || !row.phone_number) {
				throw new Error(
					"Telnyx returned a phone number without an ID or number",
				);
			}
			rows.push({
				id: row.id,
				phoneNumber: row.phone_number,
				status: row.status ?? null,
				customerReference: row.customer_reference ?? null,
			});
		}
		const totalPages = response.meta?.total_pages;
		const observedPage = response.meta?.page_number;
		const observedPageSize = response.meta?.page_size;
		const totalResults = response.meta?.total_results;
		if (
			!Number.isSafeInteger(observedPage) ||
			observedPage !== pageNumber ||
			(observedPageSize !== undefined &&
				(!Number.isSafeInteger(observedPageSize) ||
					observedPageSize !== 100)) ||
			!Number.isSafeInteger(totalPages) ||
			(totalPages ?? -1) < 0 ||
			(totalResults !== undefined &&
				(!Number.isSafeInteger(totalResults) || totalResults < 0))
		) {
			throw new Error("Telnyx phone-number inventory pagination was invalid");
		}
		if (
			(expectedTotalPages !== undefined && totalPages !== expectedTotalPages) ||
			(expectedTotalResults !== undefined &&
				totalResults !== expectedTotalResults)
		) {
			throw new Error("Telnyx phone-number inventory totals changed");
		}
		expectedTotalPages ??= totalPages;
		expectedTotalResults ??= totalResults;
		if (totalPages === 0) {
			if (
				pageNumber !== 1 ||
				response.data.length !== 0 ||
				(totalResults !== undefined && totalResults !== 0)
			) {
				throw new Error("Telnyx phone-number inventory empty page was invalid");
			}
			return [];
		}
		if (pageNumber >= (totalPages as number)) {
			if (new Set(rows.map((row) => row.id)).size !== rows.length) {
				throw new Error("Telnyx phone-number inventory returned duplicate IDs");
			}
			if (
				expectedTotalResults !== undefined &&
				rows.length !== expectedTotalResults
			) {
				throw new Error(
					"Telnyx phone-number inventory did not match total_results",
				);
			}
			return rows.sort((left, right) => left.id.localeCompare(right.id));
		}
	}
	throw new Error("Telnyx phone-number inventory exceeded 10000 pages");
}

/**
 * Enumerate every number order so the pre-live provider gate can detect an
 * order that may still allocate a billable number after local state is wiped.
 *
 * Official docs:
 * https://developers.telnyx.com/api-reference/phone-number-orders/list-number-orders
 * GET /v2/number_orders, page[size], page[number]
 */
export async function listNumberOrders(apiKey: string): Promise<
	Array<{
		id: string;
		status: string;
		customerReference: string | null;
		phoneNumbers: string[];
		updatedAt: string | null;
	}>
> {
	const rows: Array<{
		id: string;
		status: string;
		customerReference: string | null;
		phoneNumbers: string[];
		updatedAt: string | null;
	}> = [];
	let expectedTotalPages: number | undefined;
	let expectedTotalResults: number | undefined;
	for (let pageNumber = 1; pageNumber <= 10_000; pageNumber++) {
		const params = new URLSearchParams({
			"page[number]": String(pageNumber),
			"page[size]": "100",
		});
		const response = await telnyxFetch<{
			data: Array<{
				id?: string;
				status?: string;
				customer_reference?: string | null;
				phone_numbers?: Array<{ phone_number?: string }>;
				updated_at?: string | null;
			}>;
			meta?: {
				page_number?: number;
				page_size?: number;
				total_pages?: number;
				total_results?: number;
			};
		}>(`${TELNYX_API}/number_orders?${params.toString()}`, apiKey);
		for (const row of response.data) {
			if (!row.id || !row.status) {
				throw new Error(
					"Telnyx returned a number order without an ID or status",
				);
			}
			rows.push({
				id: row.id,
				status: row.status,
				customerReference: row.customer_reference ?? null,
				phoneNumbers: (row.phone_numbers ?? [])
					.map(({ phone_number: phoneNumber }) => phoneNumber)
					.filter((phoneNumber): phoneNumber is string => Boolean(phoneNumber))
					.sort(),
				updatedAt: row.updated_at ?? null,
			});
		}
		const totalPages = response.meta?.total_pages;
		const observedPage = response.meta?.page_number;
		const observedPageSize = response.meta?.page_size;
		const totalResults = response.meta?.total_results;
		if (
			!Number.isSafeInteger(observedPage) ||
			observedPage !== pageNumber ||
			(observedPageSize !== undefined &&
				(!Number.isSafeInteger(observedPageSize) ||
					observedPageSize !== 100)) ||
			!Number.isSafeInteger(totalPages) ||
			(totalPages ?? -1) < 0 ||
			(totalResults !== undefined &&
				(!Number.isSafeInteger(totalResults) || totalResults < 0))
		) {
			throw new Error("Telnyx number-order inventory pagination was invalid");
		}
		if (
			(expectedTotalPages !== undefined && totalPages !== expectedTotalPages) ||
			(expectedTotalResults !== undefined &&
				totalResults !== expectedTotalResults)
		) {
			throw new Error("Telnyx number-order inventory totals changed");
		}
		expectedTotalPages ??= totalPages;
		expectedTotalResults ??= totalResults;
		if (totalPages === 0) {
			if (
				pageNumber !== 1 ||
				response.data.length !== 0 ||
				(totalResults !== undefined && totalResults !== 0)
			) {
				throw new Error("Telnyx number-order inventory empty page was invalid");
			}
			return [];
		}
		if (pageNumber >= (totalPages as number)) {
			if (new Set(rows.map((row) => row.id)).size !== rows.length) {
				throw new Error("Telnyx number-order inventory returned duplicate IDs");
			}
			if (
				expectedTotalResults !== undefined &&
				rows.length !== expectedTotalResults
			) {
				throw new Error(
					"Telnyx number-order inventory did not match total_results",
				);
			}
			return rows.sort((left, right) => left.id.localeCompare(right.id));
		}
	}
	throw new Error("Telnyx number-order inventory exceeded 10000 pages");
}

/** Return false only when Telnyx authoritatively reports that the number is gone. */
export async function telnyxPhoneNumberExists(
	apiKey: string,
	phoneNumberId: string,
): Promise<boolean> {
	try {
		await telnyxFetch(`${TELNYX_API}/phone_numbers/${phoneNumberId}`, apiKey);
		return true;
	} catch (error) {
		if (error instanceof TelnyxError && error.status === 404) return false;
		throw error;
	}
}

/**
 * Release (delete) a phone number by its Telnyx phone number ID.
 * DELETE /v2/phone_numbers/{phoneNumberId}
 */
export async function releaseNumber(
	apiKey: string,
	phoneNumberId: string,
): Promise<void> {
	await telnyxFetch(`${TELNYX_API}/phone_numbers/${phoneNumberId}`, apiKey, {
		method: "DELETE",
	});
}
