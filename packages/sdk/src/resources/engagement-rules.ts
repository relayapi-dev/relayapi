import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class EngagementRules extends APIResource {
  /**
   * Create an engagement rule
   */
  create(
    body: EngagementRuleCreateParams,
    options?: RequestOptions,
  ): APIPromise<EngagementRuleResponse> {
    return this._client.post('/v1/engagement-rules', { body, ...options });
  }

  /**
   * Get an engagement rule by ID
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<EngagementRuleResponse> {
    return this._client.get(path`/v1/engagement-rules/${id}`, options);
  }

  /**
   * Update an engagement rule
   */
  update(
    id: string,
    body: EngagementRuleUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<EngagementRuleResponse> {
    return this._client.patch(path`/v1/engagement-rules/${id}`, { body, ...options });
  }

  /**
   * List engagement rules
   */
  list(
    query: EngagementRuleListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<EngagementRuleListResponse> {
    return this._client.get('/v1/engagement-rules', { query, ...options });
  }

  /**
   * Delete an engagement rule
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/engagement-rules/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Activate a paused engagement rule
   */
  activate(id: string, options?: RequestOptions): APIPromise<EngagementRuleResponse> {
    return this._client.post(path`/v1/engagement-rules/${id}/activate`, options);
  }

  /**
   * Pause an active engagement rule
   */
  pause(id: string, options?: RequestOptions): APIPromise<EngagementRuleResponse> {
    return this._client.post(path`/v1/engagement-rules/${id}/pause`, options);
  }

  /**
   * List execution logs for an engagement rule
   */
  listLogs(
    id: string,
    query: EngagementRuleListLogsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<EngagementRuleLogListResponse> {
    return this._client.get(path`/v1/engagement-rules/${id}/logs`, { query, ...options });
  }
}

export interface EngagementRuleResponse {
  id: string;
  name: string;
  account_id: string;
  trigger_metric: 'likes' | 'comments' | 'shares' | 'views';
  trigger_threshold: number;
  action_type: 'repost' | 'reply' | 'repost_from_account';
  action_account_id: string | null;
  action_content: string | null;
  check_interval_minutes: number;
  max_checks: number;
  status: 'active' | 'paused';
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EngagementRuleListResponse {
  data: EngagementRuleResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface EngagementRuleLogResponse {
  id: string;
  rule_id: string;
  post_target_id: string;
  check_number: number;
  metric_value: number | null;
  threshold_met: boolean;
  action_taken: boolean;
  result_post_id: string | null;
  error: string | null;
  executed_at: string;
}

export interface EngagementRuleLogListResponse {
  data: EngagementRuleLogResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface EngagementRuleCreateParams {
  name: string;
  account_id: string;
  trigger_metric: 'likes' | 'comments' | 'shares' | 'views';
  trigger_threshold: number;
  action_type: 'repost' | 'reply' | 'repost_from_account';
  action_account_id?: string;
  action_content?: string;
  check_interval_minutes?: number;
  max_checks?: number;
  workspace_id?: string;
}

export interface EngagementRuleUpdateParams {
  name?: string;
  trigger_metric?: 'likes' | 'comments' | 'shares' | 'views';
  trigger_threshold?: number;
  action_type?: 'repost' | 'reply' | 'repost_from_account';
  action_account_id?: string | null;
  action_content?: string | null;
  check_interval_minutes?: number;
  max_checks?: number;
}

export interface EngagementRuleListParams {
  workspace_id?: string;
  cursor?: string;
  limit?: number;
}

export interface EngagementRuleListLogsParams {
  cursor?: string;
  limit?: number;
}

export declare namespace EngagementRules {
  export {
    type EngagementRuleResponse as EngagementRuleResponse,
    type EngagementRuleListResponse as EngagementRuleListResponse,
    type EngagementRuleLogResponse as EngagementRuleLogResponse,
    type EngagementRuleLogListResponse as EngagementRuleLogListResponse,
    type EngagementRuleCreateParams as EngagementRuleCreateParams,
    type EngagementRuleUpdateParams as EngagementRuleUpdateParams,
    type EngagementRuleListParams as EngagementRuleListParams,
    type EngagementRuleListLogsParams as EngagementRuleListLogsParams,
  };
}
