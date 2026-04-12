import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class CrossPostActions extends APIResource {
  /**
   * List cross-post actions for a post
   */
  listByPost(
    postId: string,
    query: CrossPostActionListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<CrossPostActionListResponse> {
    return this._client.get(path`/v1/posts/${postId}/cross-post-actions`, { query, ...options });
  }

  /**
   * Cancel a pending cross-post action
   */
  cancel(id: string, options?: RequestOptions): APIPromise<CrossPostActionResponse> {
    return this._client.delete(path`/v1/cross-post-actions/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: 'application/json' }, options?.headers]),
    });
  }
}

export interface CrossPostActionResponse {
  id: string;
  post_id: string;
  action_type: 'repost' | 'comment' | 'quote';
  target_account_id: string;
  content: string | null;
  delay_minutes: number;
  status: 'pending' | 'executed' | 'failed' | 'cancelled';
  execute_at: string;
  executed_at: string | null;
  result_post_id: string | null;
  error: string | null;
  created_at: string;
}

export interface CrossPostActionListResponse {
  data: CrossPostActionResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface CrossPostActionInput {
  action_type: 'repost' | 'comment' | 'quote';
  target_account_id: string;
  content?: string;
  delay_minutes?: number;
}

export interface CrossPostActionListParams {
  cursor?: string;
  limit?: number;
}

export declare namespace CrossPostActions {
  export {
    type CrossPostActionResponse as CrossPostActionResponse,
    type CrossPostActionListResponse as CrossPostActionListResponse,
    type CrossPostActionInput as CrossPostActionInput,
    type CrossPostActionListParams as CrossPostActionListParams,
  };
}
