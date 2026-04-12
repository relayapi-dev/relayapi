// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class CommentAutomations extends APIResource {
  /**
   * Create a new comment automation
   */
  create(
    body: CommentAutomationCreateParams,
    options?: RequestOptions,
  ): APIPromise<CommentAutomationResponse> {
    return this._client.post('/v1/comment-automations', { body, ...options });
  }

  /**
   * Retrieve a comment automation by ID
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<CommentAutomationResponse> {
    return this._client.get(path`/v1/comment-automations/${id}`, options);
  }

  /**
   * Update a comment automation
   */
  update(
    id: string,
    body: CommentAutomationUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<CommentAutomationResponse> {
    return this._client.patch(path`/v1/comment-automations/${id}`, { body, ...options });
  }

  /**
   * List comment automations
   */
  list(
    query: CommentAutomationListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<CommentAutomationListResponse> {
    return this._client.get('/v1/comment-automations', { query, ...options });
  }

  /**
   * Delete a comment automation
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/comment-automations/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * List logs for a comment automation
   */
  listLogs(
    id: string,
    query: CommentAutomationListLogsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<CommentAutomationLogListResponse> {
    return this._client.get(path`/v1/comment-automations/${id}/logs`, { query, ...options });
  }
}

export interface CommentAutomationResponse {
  id: string;

  name: string;

  platform: string;

  account_id: string;

  post_id: string | null;

  enabled: boolean;

  keywords: string[];

  match_mode: string;

  dm_message: string;

  public_reply: string | null;

  once_per_user: boolean;

  stats: {
    total_triggered: number;
    last_triggered_at: string | null;
  };

  created_at: string;
}

export interface CommentAutomationListResponse {
  data: CommentAutomationResponse[];

  next_cursor: string | null;

  has_more: boolean;
}

export interface CommentAutomationLogResponse {
  id: string;

  comment_id: string;

  commenter_id: string;

  commenter_name: string;

  comment_text: string;

  dm_sent: boolean;

  reply_sent: boolean;

  error: string | null;

  created_at: string;
}

export interface CommentAutomationLogListResponse {
  data: CommentAutomationLogResponse[];

  next_cursor: string | null;

  has_more: boolean;
}

export interface CommentAutomationCreateParams {
  account_id: string;

  platform: 'instagram' | 'facebook';

  post_id?: string;

  name: string;

  workspace_id?: string;

  keywords?: string[];

  match_mode?: 'contains' | 'exact';

  dm_message: string;

  public_reply?: string;

  once_per_user?: boolean;
}

export interface CommentAutomationUpdateParams {
  name?: string;

  keywords?: string[];

  match_mode?: 'contains' | 'exact';

  dm_message?: string;

  public_reply?: string | null;

  once_per_user?: boolean;

  enabled?: boolean;
}

export interface CommentAutomationListParams {
  workspace_id?: string;

  cursor?: string;

  limit?: number;
}

export interface CommentAutomationListLogsParams {
  cursor?: string;

  limit?: number;
}

export declare namespace CommentAutomations {
  export {
    type CommentAutomationResponse as CommentAutomationResponse,
    type CommentAutomationListResponse as CommentAutomationListResponse,
    type CommentAutomationLogResponse as CommentAutomationLogResponse,
    type CommentAutomationLogListResponse as CommentAutomationLogListResponse,
    type CommentAutomationListParams as CommentAutomationListParams,
    type CommentAutomationCreateParams as CommentAutomationCreateParams,
    type CommentAutomationUpdateParams as CommentAutomationUpdateParams,
    type CommentAutomationListLogsParams as CommentAutomationListLogsParams,
  };
}
