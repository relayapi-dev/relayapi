import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	IHttpRequestMethods,
	IRequestOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

const BASE_URL = 'https://api.relayapi.dev';

export async function relayApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: object,
	qs?: Record<string, string | number>,
): Promise<any> {
	const credentials = await this.getCredentials('relayApi');

	const options: IRequestOptions = {
		method,
		uri: `${BASE_URL}${endpoint}`,
		headers: {
			Authorization: `Bearer ${credentials.apiKey}`,
			'Content-Type': 'application/json',
		},
		qs,
		body,
		json: true,
	};

	if (!body || Object.keys(body).length === 0) {
		delete options.body;
	}

	try {
		return await this.helpers.request(options);
	} catch (error) {
		const response = (error as { response?: { body?: JsonObject } } | undefined)?.response;
		const errorData = response?.body;
		const message =
			(errorData?.error as JsonObject)?.message as string ??
			(error as Error).message ??
			'Unknown error';
		throw new NodeApiError(this.getNode(), { message } as JsonObject, { message });
	}
}

export async function relayApiRequestAllItems(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: object,
	qs?: Record<string, string | number>,
): Promise<any[]> {
	const allItems: any[] = [];
	let cursor: string | undefined;

	do {
		const queryParams = { ...qs };
		if (cursor) {
			queryParams.cursor = cursor;
		}

		const response = await relayApiRequest.call(this, method, endpoint, body, queryParams);

		if (Array.isArray(response.data)) {
			allItems.push(...response.data);
		} else {
			allItems.push(response);
			break;
		}

		cursor = response.has_more ? response.next_cursor : undefined;
	} while (cursor);

	return allItems;
}
