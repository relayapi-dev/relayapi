import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class AutoPostRules extends APIResource {
  /**
   * Create a new auto-post rule for RSS/Atom feed auto-posting.
   */
  create(
    body: AutoPostRuleCreateParams,
    options?: RequestOptions,
  ): APIPromise<AutoPostRuleResponse> {
    return this._client.post('/v1/auto-post-rules', { body, ...options });
  }

  /**
   * Get an auto-post rule by ID.
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<AutoPostRuleResponse> {
    return this._client.get(path`/v1/auto-post-rules/${id}`, options);
  }

  /**
   * Update an auto-post rule.
   */
  update(
    id: string,
    body: AutoPostRuleUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AutoPostRuleResponse> {
    return this._client.patch(path`/v1/auto-post-rules/${id}`, { body, ...options });
  }

  /**
   * List auto-post rules.
   */
  list(
    query: AutoPostRuleListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AutoPostRuleListResponse> {
    return this._client.get('/v1/auto-post-rules', { query, ...options });
  }

  /**
   * Delete an auto-post rule.
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/auto-post-rules/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Activate an auto-post rule.
   */
  activate(id: string, options?: RequestOptions): APIPromise<AutoPostRuleResponse> {
    return this._client.post(path`/v1/auto-post-rules/${id}/activate`, options);
  }

  /**
   * Pause an auto-post rule.
   */
  pause(id: string, options?: RequestOptions): APIPromise<AutoPostRuleResponse> {
    return this._client.post(path`/v1/auto-post-rules/${id}/pause`, options);
  }

  /**
   * Test-parse a feed URL and return the 5 most recent items.
   */
  testFeed(
    body: AutoPostRuleTestFeedParams,
    options?: RequestOptions,
  ): APIPromise<AutoPostRuleTestFeedResponse> {
    return this._client.post('/v1/auto-post-rules/test-feed', { body, ...options });
  }
}

export interface AutoPostRuleResponse {
  id: string;
  name: string;
  feed_url: string;
  polling_interval_minutes: number;
  content_template: string | null;
  append_feed_url: boolean;
  account_ids: Array<string>;
  status: 'active' | 'paused' | 'error';
  consecutive_errors: number;
  last_processed_url: string | null;
  last_processed_at: string | null;
  last_error: string | null;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutoPostRuleListResponse {
  data: Array<AutoPostRuleResponse>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface AutoPostRuleCreateParams {
  name: string;
  feed_url: string;
  polling_interval_minutes?: number;
  content_template?: string;
  append_feed_url?: boolean;
  account_ids?: Array<string>;
  workspace_id?: string;
}

export interface AutoPostRuleUpdateParams {
  name?: string;
  feed_url?: string;
  polling_interval_minutes?: number;
  content_template?: string | null;
  append_feed_url?: boolean;
  account_ids?: Array<string>;
}

export interface AutoPostRuleListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
  status?: 'active' | 'paused' | 'error';
}

export interface AutoPostRuleTestFeedParams {
  feed_url: string;
}

export interface AutoPostRuleTestFeedResponse {
  items: Array<{
    title: string;
    url: string;
    description: string;
    published_at: string | null;
    image_url: string | null;
  }>;
}

export declare namespace AutoPostRules {
  export {
    type AutoPostRuleResponse as AutoPostRuleResponse,
    type AutoPostRuleListResponse as AutoPostRuleListResponse,
    type AutoPostRuleCreateParams as AutoPostRuleCreateParams,
    type AutoPostRuleUpdateParams as AutoPostRuleUpdateParams,
    type AutoPostRuleListParams as AutoPostRuleListParams,
    type AutoPostRuleTestFeedParams as AutoPostRuleTestFeedParams,
    type AutoPostRuleTestFeedResponse as AutoPostRuleTestFeedResponse,
  };
}
