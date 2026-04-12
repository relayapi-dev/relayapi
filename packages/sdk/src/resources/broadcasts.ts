// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Broadcasts extends APIResource {
  /**
   * Create a new broadcast
   */
  create(body: BroadcastCreateParams, options?: RequestOptions): APIPromise<BroadcastResponse> {
    return this._client.post('/v1/broadcasts', { body, ...options });
  }

  /**
   * Retrieve a broadcast by ID
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<BroadcastResponse> {
    return this._client.get(path`/v1/broadcasts/${id}`, options);
  }

  /**
   * Update a broadcast
   */
  update(
    id: string,
    body: BroadcastUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<BroadcastResponse> {
    return this._client.patch(path`/v1/broadcasts/${id}`, { body, ...options });
  }

  /**
   * List broadcasts
   */
  list(
    query: BroadcastListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<BroadcastListResponse> {
    return this._client.get('/v1/broadcasts', { query, ...options });
  }

  /**
   * Delete a broadcast
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/broadcasts/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Add recipients to a broadcast
   */
  addRecipients(
    id: string,
    body: BroadcastAddRecipientsParams,
    options?: RequestOptions,
  ): APIPromise<BroadcastAddRecipientsResponse> {
    return this._client.post(path`/v1/broadcasts/${id}/recipients`, { body, ...options });
  }

  /**
   * List recipients of a broadcast
   */
  listRecipients(
    id: string,
    query: BroadcastListRecipientsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<BroadcastListRecipientsResponse> {
    return this._client.get(path`/v1/broadcasts/${id}/recipients`, { query, ...options });
  }

  /**
   * Send a broadcast immediately
   */
  send(id: string, options?: RequestOptions): APIPromise<BroadcastResponse> {
    return this._client.post(path`/v1/broadcasts/${id}/send`, options);
  }

  /**
   * Schedule a broadcast for later delivery
   */
  schedule(
    id: string,
    body: BroadcastScheduleParams,
    options?: RequestOptions,
  ): APIPromise<BroadcastResponse> {
    return this._client.post(path`/v1/broadcasts/${id}/schedule`, { body, ...options });
  }

  /**
   * Cancel a scheduled broadcast
   */
  cancel(id: string, options?: RequestOptions): APIPromise<BroadcastResponse> {
    return this._client.post(path`/v1/broadcasts/${id}/cancel`, options);
  }
}

export interface BroadcastResponse {
  id: string;

  name: string;

  description: string | null;

  platform: string;

  account_id: string;

  status: string;

  message_text: string | null;

  template_name: string | null;

  template_language: string | null;

  recipient_count: number;

  sent_count: number;

  failed_count: number;

  scheduled_at: string | null;

  completed_at: string | null;

  created_at: string;
}

export interface BroadcastListResponse {
  data: BroadcastResponse[];

  next_cursor: string | null;

  has_more: boolean;
}

export interface BroadcastAddRecipientsResponse {
  added: number;

  skipped: number;
}

export interface BroadcastRecipientResponse {
  id: string;

  contact_id: string | null;

  contact_identifier: string;

  status: string;

  message_id: string | null;

  error: string | null;

  sent_at: string | null;
}

export interface BroadcastListRecipientsResponse {
  data: BroadcastRecipientResponse[];

  next_cursor: string | null;

  has_more: boolean;
}

export interface BroadcastCreateParams {
  account_id: string;

  workspace_id?: string;

  name?: string;

  description?: string;

  message_text?: string;

  template?: {
    name: string;
    language: string;
    components?: Array<{
      type: string;
      parameters?: Array<Record<string, unknown>>;
    }>;
  };
}

export interface BroadcastUpdateParams {
  name?: string;

  description?: string | null;

  message_text?: string;

  template?: {
    name: string;
    language: string;
    components?: Array<{
      type: string;
      parameters?: Array<Record<string, unknown>>;
    }>;
  };
}

export interface BroadcastListParams {
  account_id?: string;

  status?: string;

  cursor?: string;

  limit?: number;

  workspace_id?: string;
}

export interface BroadcastAddRecipientsParams {
  phones?: string[];

  contact_ids?: string[];

  identifiers?: string[];
}

export interface BroadcastScheduleParams {
  scheduled_at: string;
}

export interface BroadcastListRecipientsParams {
  status?: string;

  cursor?: string;

  limit?: number;
}

export declare namespace Broadcasts {
  export {
    type BroadcastResponse as BroadcastResponse,
    type BroadcastListResponse as BroadcastListResponse,
    type BroadcastAddRecipientsResponse as BroadcastAddRecipientsResponse,
    type BroadcastRecipientResponse as BroadcastRecipientResponse,
    type BroadcastListRecipientsResponse as BroadcastListRecipientsResponse,
    type BroadcastCreateParams as BroadcastCreateParams,
    type BroadcastUpdateParams as BroadcastUpdateParams,
    type BroadcastListParams as BroadcastListParams,
    type BroadcastAddRecipientsParams as BroadcastAddRecipientsParams,
    type BroadcastScheduleParams as BroadcastScheduleParams,
    type BroadcastListRecipientsParams as BroadcastListRecipientsParams,
  };
}
