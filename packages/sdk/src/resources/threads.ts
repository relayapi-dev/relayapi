import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class Threads extends APIResource {
  /**
   * Create a multi-item thread for publishing as a reply chain on supported
   * platforms.
   */
  create(body: ThreadCreateParams, options?: RequestOptions): APIPromise<ThreadResponse> {
    return this._client.post('/v1/threads', { body, ...options });
  }

  /**
   * Retrieve a full thread with all items and their per-target results.
   */
  retrieve(threadGroupId: string, options?: RequestOptions): APIPromise<ThreadResponse> {
    return this._client.get(`/v1/threads/${threadGroupId}`, options);
  }

  /**
   * List threads with pagination.
   */
  list(
    query: ThreadListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ThreadListResponse> {
    return this._client.get('/v1/threads', { query, ...options });
  }

  /**
   * Delete an entire thread and all its items.
   */
  delete(threadGroupId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(`/v1/threads/${threadGroupId}`, {
      ...options,
      headers: { Accept: '*/*', ...options?.headers },
    });
  }
}

export interface ThreadCreateParams {
  /**
   * Thread items in order. Minimum 2, maximum 25.
   */
  items: Array<ThreadCreateParams.Item>;

  /**
   * Account IDs, platform names, or workspace IDs.
   */
  targets: Array<string>;

  /**
   * Publish intent: "now", "draft", "auto", or ISO 8601 timestamp.
   */
  scheduled_at: string;

  /**
   * Per-platform options applied to all items.
   */
  target_options?: Record<string, Record<string, unknown>>;

  /**
   * IANA timezone.
   */
  timezone?: string;

  /**
   * Workspace ID.
   */
  workspace_id?: string;
}

export namespace ThreadCreateParams {
  export interface Item {
    /**
     * Post content for this thread item.
     */
    content: string;

    /**
     * Media attachments for this item.
     */
    media?: Array<{ url: string; type?: 'image' | 'video' | 'gif' | 'document' }>;

    /**
     * Minutes to wait after the previous item is published before publishing this
     * item (0-1440).
     */
    delay_minutes?: number;
  }
}

export interface ThreadResponse {
  thread_group_id: string;
  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partial';
  items: Array<ThreadResponse.Item>;
  scheduled_at: string | null;
  timezone?: string | null;
  created_at: string;
  updated_at: string;
}

export namespace ThreadResponse {
  export interface Item {
    id: string;
    position: number;
    content: string | null;
    media: Array<{ url: string; type?: string }> | null;
    delay_minutes: number;
    status: string;
    targets: Record<string, Item.Target>;
  }

  export namespace Item {
    export interface Target {
      platform: string;
      status: string;
      platform_post_id: string | null;
      platform_url: string | null;
      error?: string | null;
    }
  }
}

export interface ThreadListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
  status?: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';
}

export interface ThreadListResponse {
  data: Array<ThreadListResponse.Thread>;
  next_cursor: string | null;
  has_more: boolean;
}

export namespace ThreadListResponse {
  export interface Thread {
    thread_group_id: string;
    status: string;
    item_count: number;
    root_content: string | null;
    scheduled_at: string | null;
    created_at: string;
    updated_at: string;
  }
}
