// ---------------------------------------------------------------------------
// Telnyx Phone Number Management Service
// Docs: https://developers.telnyx.com/api/numbers
// ---------------------------------------------------------------------------

const TELNYX_API = "https://api.telnyx.com/v2";

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

	constructor(code: string, message: string) {
		super(message);
		this.name = "TelnyxError";
		this.code = code;
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
	const res = await fetch(url, {
		...options,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			...options.headers,
		},
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as {
			errors?: { code?: string; title?: string; detail?: string }[];
		};
		const first = body.errors?.[0];
		throw new TelnyxError(
			first?.code ?? `HTTP_${res.status}`,
			first?.detail ?? first?.title ?? `Telnyx API error: ${res.status}`,
		);
	}

	// DELETE responses may return 204 with no body
	if (res.status === 204) {
		return undefined as T;
	}

	return (await res.json()) as T;
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
		}),
	});

	return {
		orderId: data.data.id,
		phoneNumberId: data.data.phone_numbers[0]?.id ?? data.data.id,
		phoneNumbers: data.data.phone_numbers.map((pn) => pn.phone_number),
	};
}

/**
 * Release (delete) a phone number by its Telnyx phone number ID.
 * DELETE /v2/phone_numbers/{phoneNumberId}
 */
export async function releaseNumber(
	apiKey: string,
	phoneNumberId: string,
): Promise<void> {
	await telnyxFetch(
		`${TELNYX_API}/phone_numbers/${phoneNumberId}`,
		apiKey,
		{ method: "DELETE" },
	);
}
