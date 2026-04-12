// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Webhooks extends APIResource {
  /**
   * Create a new webhook endpoint. The signing secret is returned only once in the
   * response.
   */
  create(body: WebhookCreateParams, options?: RequestOptions): APIPromise<WebhookCreateResponse> {
    return this._client.post('/v1/webhooks', { body, ...options });
  }

  /**
   * Update a webhook endpoint
   */
  update(
    id: string,
    body: WebhookUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<WebhookUpdateResponse> {
    return this._client.patch(path`/v1/webhooks/${id}`, { body, ...options });
  }

  /**
   * List webhook endpoints
   */
  list(
    query: WebhookListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<WebhookListResponse> {
    return this._client.get('/v1/webhooks', { query, ...options });
  }

  /**
   * Delete a webhook endpoint
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/webhooks/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Returns delivery logs from the last 7 days.
   */
  listLogs(
    query: WebhookListLogsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<WebhookListLogsResponse> {
    return this._client.get('/v1/webhooks/logs', { query, ...options });
  }

  /**
   * Send a test POST request to the webhook URL to verify it is reachable.
   */
  sendTest(body: WebhookSendTestParams, options?: RequestOptions): APIPromise<WebhookSendTestResponse> {
    return this._client.post('/v1/webhooks/test', { body, ...options });
  }
}

export interface WebhookCreateResponse {
  /**
   * Webhook ID
   */
  id: string;

  /**
   * Creation timestamp
   */
  created_at: string;

  /**
   * Whether the webhook is active
   */
  enabled: boolean;

  /**
   * Subscribed events
   */
  events: Array<string>;

  /**
   * Webhook signing secret (shown only once)
   */
  secret: string;

  /**
   * Endpoint URL
   */
  url: string;
}

export interface WebhookUpdateResponse {
  /**
   * Webhook ID
   */
  id: string;

  /**
   * Creation timestamp
   */
  created_at: string;

  /**
   * Whether the webhook is active
   */
  enabled: boolean;

  /**
   * Subscribed events
   */
  events: Array<string>;

  /**
   * Last update timestamp
   */
  updated_at: string;

  /**
   * Endpoint URL
   */
  url: string;
}

export interface WebhookListResponse {
  data: Array<WebhookListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace WebhookListResponse {
  export interface Data {
    /**
     * Webhook ID
     */
    id: string;

    /**
     * Creation timestamp
     */
    created_at: string;

    /**
     * Whether the webhook is active
     */
    enabled: boolean;

    /**
     * Subscribed events
     */
    events: Array<string>;

    /**
     * Last update timestamp
     */
    updated_at: string;

    /**
     * Endpoint URL
     */
    url: string;
  }
}

export interface WebhookListLogsResponse {
  data: Array<WebhookListLogsResponse.Data>;

  has_more: boolean;

  next_cursor: string | null;
}

export namespace WebhookListLogsResponse {
  export interface Data {
    id: string;

    created_at: string;

    error: string | null;

    event: string;

    response_time_ms: number | null;

    status_code: number | null;

    success: boolean;

    webhook_id: string;
  }
}

export interface WebhookSendTestResponse {
  /**
   * Response time in milliseconds
   */
  response_time_ms: number | null;

  /**
   * HTTP status code from the test delivery
   */
  status_code: number | null;

  /**
   * Whether the test delivery succeeded
   */
  success: boolean;
}

export interface WebhookCreateParams {
  /**
   * Events to subscribe to
   */
  events: Array<
    | 'post.published'
    | 'post.partial'
    | 'post.failed'
    | 'post.scheduled'
    | 'post.recycled'
    | 'account.connected'
    | 'account.disconnected'
    | 'comment.received'
    | 'message.received'
  >;

  /**
   * Webhook endpoint URL
   */
  url: string;

  /**
   * Workspace ID to scope this webhook to
   */
  workspace_id?: string;
}

export interface WebhookUpdateParams {
  /**
   * Enable or disable the webhook
   */
  enabled?: boolean;

  /**
   * Updated events
   */
  events?: Array<
    | 'post.published'
    | 'post.partial'
    | 'post.failed'
    | 'post.scheduled'
    | 'post.recycled'
    | 'account.connected'
    | 'account.disconnected'
    | 'comment.received'
    | 'message.received'
  >;

  /**
   * Updated endpoint URL
   */
  url?: string;
}

export interface WebhookListParams {
  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;

  /**
   * Filter by workspace ID
   */
  workspace_id?: string;
}

export interface WebhookListLogsParams {
  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;
}

export interface WebhookSendTestParams {
  /**
   * ID of the webhook to test
   */
  webhook_id: string;
}

export declare namespace Webhooks {
  export {
    type WebhookCreateResponse as WebhookCreateResponse,
    type WebhookUpdateResponse as WebhookUpdateResponse,
    type WebhookListResponse as WebhookListResponse,
    type WebhookListLogsResponse as WebhookListLogsResponse,
    type WebhookSendTestResponse as WebhookSendTestResponse,
    type WebhookCreateParams as WebhookCreateParams,
    type WebhookUpdateParams as WebhookUpdateParams,
    type WebhookListParams as WebhookListParams,
    type WebhookListLogsParams as WebhookListLogsParams,
    type WebhookSendTestParams as WebhookSendTestParams,
  };
}
