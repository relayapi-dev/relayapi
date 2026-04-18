// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as LogsAPI from './logs';
import { LogListParams, LogListResponse, LogRetrieveResponse, Logs } from './logs';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

function isRequestOptions(
  value: PostUnpublishParams | RequestOptions | undefined,
): value is RequestOptions {
  return !!value && typeof value === 'object' && !('platforms' in value);
}

export class Posts extends APIResource {
  logs: LogsAPI.Logs = new LogsAPI.Logs(this._client);

  /**
   * Create a post. Use scheduled_at: "now" to publish immediately, "draft" to save
   * as draft, or an ISO timestamp to schedule.
   *
   * @example
   * ```ts
   * const post = await client.posts.create({
   *   scheduled_at: 'now',
   *   targets: ['string'],
   * });
   * ```
   */
  create(body: PostCreateParams, options?: RequestOptions): APIPromise<PostCreateResponse> {
    return this._client.post('/v1/posts', { body, ...options });
  }

  /**
   * Get a post
   *
   * @example
   * ```ts
   * const post = await client.posts.retrieve('id');
   * ```
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<PostRetrieveResponse> {
    return this._client.get(path`/v1/posts/${id}`, options);
  }

  /**
   * Update a draft or scheduled post.
   *
   * @example
   * ```ts
   * const post = await client.posts.update('id');
   * ```
   */
  update(
    id: string,
    body: PostUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<PostUpdateResponse> {
    return this._client.patch(path`/v1/posts/${id}`, { body, ...options });
  }

  /**
   * List posts
   *
   * @example
   * ```ts
   * const posts = await client.posts.list();
   * ```
   */
  list(
    query: PostListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<PostListResponse> {
    return this._client.get('/v1/posts', { query, ...options });
  }

  /**
   * Delete a draft or scheduled post.
   *
   * @example
   * ```ts
   * await client.posts.delete('id');
   * ```
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/posts/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Create multiple posts in a single request. Each item follows the same schema as
   * single post creation.
   *
   * @example
   * ```ts
   * const response = await client.posts.bulkCreate({
   *   posts: [{ scheduled_at: 'now', targets: ['string'] }],
   * });
   * ```
   */
  bulkCreate(body: PostBulkCreateParams, options?: RequestOptions): APIPromise<PostBulkCreateResponse> {
    return this._client.post('/v1/posts/bulk', { body, ...options });
  }

  /**
   * Upload a CSV file to create multiple posts.
   */
  bulkCsvUpload(
    body: FormData,
    query: PostBulkCsvUploadParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<PostBulkCsvUploadResponse> {
    return this._client.post('/v1/posts/bulk-csv', { body, query, ...options });
  }

  /**
   * Retry publishing for failed targets on a post.
   *
   * @example
   * ```ts
   * const response = await client.posts.retry('id');
   * ```
   */
  retry(id: string, options?: RequestOptions): APIPromise<PostRetryResponse> {
    return this._client.post(path`/v1/posts/${id}/retry`, options);
  }

  /**
   * Attempt to delete the post from each platform and set the post status to
   * cancelled.
   *
   * @example
   * ```ts
   * const response = await client.posts.unpublish('id');
   * ```
   */
  unpublish(
    id: string,
    bodyOrOptions?: PostUnpublishParams | RequestOptions,
    options?: RequestOptions,
  ): APIPromise<PostUnpublishResponse> {
    const body = isRequestOptions(bodyOrOptions) ? undefined : bodyOrOptions;
    const requestOptions = isRequestOptions(bodyOrOptions) ? bodyOrOptions : options;
    return this._client.post(path`/v1/posts/${id}/unpublish`, { body, ...requestOptions });
  }

  /**
   * Get notes for a post.
   */
  getNotes(id: string, options?: RequestOptions): APIPromise<PostNotesResponse> {
    return this._client.get(path`/v1/posts/${id}/notes`, options);
  }

  /**
   * Update notes for a post.
   */
  updateNotes(
    id: string,
    body: PostUpdateNotesParams,
    options?: RequestOptions,
  ): APIPromise<PostNotesResponse> {
    return this._client.patch(path`/v1/posts/${id}/notes`, { body, ...options });
  }

  /**
   * Update metadata on a published video.
   */
  updateMetadata(
    id: string,
    body: PostUpdateMetadataParams,
    options?: RequestOptions,
  ): APIPromise<PostUpdateMetadataResponse> {
    return this._client.post(path`/v1/posts/${id}/update-metadata`, { body, ...options });
  }

  /**
   * Get recycling configuration for a post.
   */
  getRecycling(id: string, options?: RequestOptions): APIPromise<RecyclingConfig> {
    return this._client.get(path`/v1/posts/${id}/recycling`, options);
  }

  /**
   * Set or replace recycling configuration for a post. Pro plan only.
   */
  setRecycling(
    id: string,
    body: RecyclingInput,
    options?: RequestOptions,
  ): APIPromise<PostSetRecyclingResponse> {
    return this._client.put(path`/v1/posts/${id}/recycling`, { body, ...options });
  }

  /**
   * Remove recycling configuration from a post.
   */
  deleteRecycling(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/posts/${id}/recycling`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * List all recycled copies of a post.
   */
  listRecycledCopies(
    id: string,
    query: PostListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<PostListResponse> {
    return this._client.get(path`/v1/posts/${id}/recycled-copies`, { query, ...options });
  }
}

/**
 * Recycling configuration for evergreen content (Pro plan only).
 */
export interface RecyclingConfig {
  id: string;
  enabled: boolean;
  gap: number;
  gap_freq: 'day' | 'week' | 'month';
  start_date: string;
  expire_count: number | null;
  expire_date: string | null;
  content_variations: Array<string>;
  recycle_count: number;
  content_variation_index: number;
  next_recycle_at: string | null;
  last_recycled_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Input for creating or updating a recycling configuration.
 */
export interface RecyclingInput {
  gap: number;
  gap_freq: 'day' | 'week' | 'month';
  start_date: string;
  enabled?: boolean;
  expire_count?: number;
  expire_date?: string;
  content_variations?: Array<string>;
}

export interface PostSetRecyclingResponse {
  data: RecyclingConfig;
  warnings?: Array<string>;
}

export interface PostCreateResponse {
  /**
   * Post ID
   */
  id: string;

  content: string | null;

  /**
   * Internal notes for this post
   */
  notes?: string | null;

  created_at: string;

  media: Array<PostCreateResponse.Media> | null;

  /**
   * Recycling configuration, if any
   */
  recycling: RecyclingConfig | null;

  /**
   * Source post ID if this is a recycled copy
   */
  recycled_from_id: string | null;

  /**
   * Thread group ID (non-null if part of a thread)
   */
  thread_group_id?: string | null;

  /**
   * Position within thread (0 = root)
   */
  thread_position?: number | null;

  scheduled_at: string | null;

  /**
   * When the post was published
   */
  published_at: string | null;

  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partial';

  /**
   * Per-target results
   */
  targets: { [key: string]: PostCreateResponse.Targets };

  updated_at: string;
}

export namespace PostCreateResponse {
  export interface Media {
    /**
     * Public URL of the media file
     */
    url: string;

    /**
     * Media type. Inferred from URL extension if omitted.
     */
    type?: 'image' | 'video' | 'gif' | 'document';
  }

  export interface Targets {
    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'bluesky'
      | 'threads'
      | 'telegram'
      | 'snapchat'
      | 'googlebusiness'
      | 'whatsapp'
      | 'mastodon'
      | 'discord'
      | 'sms';

    status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

    accounts?: Array<Targets.Account>;

    error?: Targets.Error;
  }

  export namespace Targets {
    export interface Account {
      id: string;

      /**
       * Published post URL on the platform
       */
      url: string | null;

      username: string | null;

      /**
       * Account display name
       */
      display_name: string | null;

      /**
       * Account avatar URL
       */
      avatar_url: string | null;

      /**
       * Platform-native post ID
       */
      platform_post_id: string | null;
    }

    export interface Error {
      code: string;

      message: string;
    }
  }
}

export interface PostRetrieveResponse {
  /**
   * Post ID
   */
  id: string;

  content: string | null;

  /**
   * Internal notes for this post
   */
  notes: string | null;

  created_at: string;

  media: Array<PostRetrieveResponse.Media> | null;

  /**
   * Recycling configuration, if any
   */
  recycling: RecyclingConfig | null;

  /**
   * Source post ID if this is a recycled copy
   */
  recycled_from_id: string | null;

  /**
   * Thread group ID (non-null if part of a thread)
   */
  thread_group_id?: string | null;

  /**
   * Position within thread (0 = root)
   */
  thread_position?: number | null;

  scheduled_at: string | null;

  /**
   * When the post was published
   */
  published_at: string | null;

  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partial';

  /**
   * Per-target results
   */
  targets: { [key: string]: PostRetrieveResponse.Targets };

  /**
   * Per-target customizations
   */
  target_options?: { [key: string]: { [key: string]: unknown } } | null;

  /**
   * IANA timezone
   */
  timezone?: string | null;

  updated_at: string;
}

export namespace PostRetrieveResponse {
  export interface Media {
    /**
     * Public URL of the media file
     */
    url: string;

    /**
     * Media type. Inferred from URL extension if omitted.
     */
    type?: 'image' | 'video' | 'gif' | 'document';
  }

  export interface Targets {
    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'bluesky'
      | 'threads'
      | 'telegram'
      | 'snapchat'
      | 'googlebusiness'
      | 'whatsapp'
      | 'mastodon'
      | 'discord'
      | 'sms';

    status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

    accounts?: Array<Targets.Account>;

    error?: Targets.Error;
  }

  export namespace Targets {
    export interface Account {
      id: string;

      /**
       * Published post URL on the platform
       */
      url: string | null;

      username: string | null;

      /**
       * Account display name
       */
      display_name: string | null;

      /**
       * Account avatar URL
       */
      avatar_url: string | null;

      /**
       * Platform-native post ID
       */
      platform_post_id: string | null;
    }

    export interface Error {
      code: string;

      message: string;
    }
  }
}

export interface PostUpdateResponse {
  /**
   * Post ID
   */
  id: string;

  content: string | null;

  /**
   * Internal notes for this post
   */
  notes: string | null;

  created_at: string;

  media: Array<PostUpdateResponse.Media> | null;

  /**
   * Recycling configuration, if any
   */
  recycling: RecyclingConfig | null;

  /**
   * Source post ID if this is a recycled copy
   */
  recycled_from_id: string | null;

  scheduled_at: string | null;

  /**
   * When the post was published
   */
  published_at: string | null;

  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partial';

  /**
   * Per-target results
   */
  targets: { [key: string]: PostUpdateResponse.Targets };

  /**
   * Per-target customizations
   */
  target_options?: { [key: string]: { [key: string]: unknown } } | null;

  /**
   * IANA timezone
   */
  timezone?: string | null;

  updated_at: string;
}

export namespace PostUpdateResponse {
  export interface Media {
    /**
     * Public URL of the media file
     */
    url: string;

    /**
     * Media type. Inferred from URL extension if omitted.
     */
    type?: 'image' | 'video' | 'gif' | 'document';
  }

  export interface Targets {
    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'bluesky'
      | 'threads'
      | 'telegram'
      | 'snapchat'
      | 'googlebusiness'
      | 'whatsapp'
      | 'mastodon'
      | 'discord'
      | 'sms';

    status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

    accounts?: Array<Targets.Account>;

    error?: Targets.Error;
  }

  export namespace Targets {
    export interface Account {
      id: string;

      /**
       * Published post URL on the platform
       */
      url: string | null;

      username: string | null;

      /**
       * Account display name
       */
      display_name: string | null;

      /**
       * Account avatar URL
       */
      avatar_url: string | null;

      /**
       * Platform-native post ID
       */
      platform_post_id: string | null;
    }

    export interface Error {
      code: string;

      message: string;
    }
  }
}

export interface PostListResponse {
  data: Array<PostListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace PostListResponse {
  export interface Data {
    /**
     * Post ID
     */
    id: string;

    content: string | null;

    /**
     * Internal notes for this post
     */
    notes?: string | null;

    created_at: string;

    media: Array<Data.Media> | null;

    /**
     * Recycling configuration, if any
     */
    recycling: RecyclingConfig | null;

    /**
     * Source post ID if this is a recycled copy
     */
    recycled_from_id: string | null;

    scheduled_at: string | null;

    /**
     * When the post was published
     */
    published_at: string | null;

    status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partial';

    /**
     * Per-target results
     */
    targets: { [key: string]: Data.Targets };

    updated_at: string;
  }

  export namespace Data {
    export interface Media {
      /**
       * Public URL of the media file
       */
      url: string;

      /**
       * Media type. Inferred from URL extension if omitted.
       */
      type?: 'image' | 'video' | 'gif' | 'document';
    }

    export interface Targets {
      platform:
        | 'twitter'
        | 'instagram'
        | 'facebook'
        | 'linkedin'
        | 'tiktok'
        | 'youtube'
        | 'pinterest'
        | 'reddit'
        | 'bluesky'
        | 'threads'
        | 'telegram'
        | 'snapchat'
        | 'googlebusiness'
        | 'whatsapp'
        | 'mastodon'
        | 'discord'
        | 'sms';

      status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

      accounts?: Array<Targets.Account>;

      error?: Targets.Error;
    }

    export namespace Targets {
      export interface Account {
        id: string;

        /**
         * Published post URL on the platform
         */
        url: string | null;

        username: string | null;

        /**
         * Account display name
         */
        display_name: string | null;

        /**
         * Account avatar URL
         */
        avatar_url: string | null;

        /**
         * Platform-native post ID
         */
        platform_post_id: string | null;
      }

      export interface Error {
        code: string;

        message: string;
      }
    }
  }
}

export interface PostBulkCreateResponse {
  data: Array<PostBulkCreateResponse.Data>;

  summary: PostBulkCreateResponse.Summary;
}

export namespace PostBulkCreateResponse {
  export interface Data {
    /**
     * Post ID
     */
    id: string;

    content: string | null;

    created_at: string;

    media: Array<Data.Media> | null;

    /**
     * Recycling configuration, if any
     */
    recycling: RecyclingConfig | null;

    /**
     * Source post ID if this is a recycled copy
     */
    recycled_from_id: string | null;

    scheduled_at: string | null;

    /**
     * When the post was published
     */
    published_at: string | null;

    status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partial';

    /**
     * Per-target results
     */
    targets: { [key: string]: Data.Targets };

    updated_at: string;
  }

  export namespace Data {
    export interface Media {
      /**
       * Public URL of the media file
       */
      url: string;

      /**
       * Media type. Inferred from URL extension if omitted.
       */
      type?: 'image' | 'video' | 'gif' | 'document';
    }

    export interface Targets {
      platform:
        | 'twitter'
        | 'instagram'
        | 'facebook'
        | 'linkedin'
        | 'tiktok'
        | 'youtube'
        | 'pinterest'
        | 'reddit'
        | 'bluesky'
        | 'threads'
        | 'telegram'
        | 'snapchat'
        | 'googlebusiness'
        | 'whatsapp'
        | 'mastodon'
        | 'discord'
        | 'sms';

      status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

      accounts?: Array<Targets.Account>;

      error?: Targets.Error;
    }

    export namespace Targets {
      export interface Account {
        id: string;

        /**
         * Published post URL on the platform
         */
        url: string | null;

        username: string | null;

        /**
         * Account display name
         */
        display_name: string | null;

        /**
         * Account avatar URL
         */
        avatar_url: string | null;

        /**
         * Platform-native post ID
         */
        platform_post_id: string | null;
      }

      export interface Error {
        code: string;

        message: string;
      }
    }
  }

  export interface Summary {
    failed: number;

    succeeded: number;

    total: number;
  }
}

export interface PostRetryResponse {
  /**
   * Post ID
   */
  id: string;

  content: string | null;

  created_at: string;

  media: Array<PostRetryResponse.Media> | null;

  /**
   * Recycling configuration, if any
   */
  recycling: RecyclingConfig | null;

  /**
   * Source post ID if this is a recycled copy
   */
  recycled_from_id: string | null;

  scheduled_at: string | null;

  /**
   * When the post was published
   */
  published_at: string | null;

  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partial';

  /**
   * Per-target results
   */
  targets: { [key: string]: PostRetryResponse.Targets };

  updated_at: string;
}

export namespace PostRetryResponse {
  export interface Media {
    /**
     * Public URL of the media file
     */
    url: string;

    /**
     * Media type. Inferred from URL extension if omitted.
     */
    type?: 'image' | 'video' | 'gif' | 'document';
  }

  export interface Targets {
    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'bluesky'
      | 'threads'
      | 'telegram'
      | 'snapchat'
      | 'googlebusiness'
      | 'whatsapp'
      | 'mastodon'
      | 'discord'
      | 'sms';

    status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

    accounts?: Array<Targets.Account>;

    error?: Targets.Error;
  }

  export namespace Targets {
    export interface Account {
      id: string;

      /**
       * Published post URL on the platform
       */
      url: string | null;

      username: string | null;

      /**
       * Account display name
       */
      display_name: string | null;

      /**
       * Account avatar URL
       */
      avatar_url: string | null;

      /**
       * Platform-native post ID
       */
      platform_post_id: string | null;
    }

    export interface Error {
      code: string;

      message: string;
    }
  }
}

export interface PostUnpublishResponse {
  /**
   * Post ID
   */
  id: string;

  content: string | null;

  created_at: string;

  media: Array<PostUnpublishResponse.Media> | null;

  /**
   * Recycling configuration, if any
   */
  recycling: RecyclingConfig | null;

  /**
   * Source post ID if this is a recycled copy
   */
  recycled_from_id: string | null;

  scheduled_at: string | null;

  /**
   * When the post was published
   */
  published_at: string | null;

  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partial';

  /**
   * Per-target results
   */
  targets: { [key: string]: PostUnpublishResponse.Targets };

  updated_at: string;
}

export namespace PostUnpublishResponse {
  export interface Media {
    /**
     * Public URL of the media file
     */
    url: string;

    /**
     * Media type. Inferred from URL extension if omitted.
     */
    type?: 'image' | 'video' | 'gif' | 'document';
  }

  export interface Targets {
    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'bluesky'
      | 'threads'
      | 'telegram'
      | 'snapchat'
      | 'googlebusiness'
      | 'whatsapp'
      | 'mastodon'
      | 'discord'
      | 'sms';

    status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

    accounts?: Array<Targets.Account>;

    error?: Targets.Error;
  }

  export namespace Targets {
    export interface Account {
      id: string;

      /**
       * Published post URL on the platform
       */
      url: string | null;

      username: string | null;

      /**
       * Account display name
       */
      display_name: string | null;

      /**
       * Account avatar URL
       */
      avatar_url: string | null;

      /**
       * Platform-native post ID
       */
      platform_post_id: string | null;
    }

    export interface Error {
      code: string;

      message: string;
    }
  }
}

export interface PostUnpublishParams {
  /**
   * Restrict the unpublish action to specific platforms.
   */
  platforms?: Array<string>;
}

export interface PostNotesResponse {
  /**
   * Notes stored for the post.
   */
  notes: string | null;
}

export interface PostUpdateNotesParams {
  /**
   * Notes content to store for the post.
   */
  notes: string;
}

export interface PostUpdateMetadataResponse {
  platform: string;

  success: boolean;

  updated_fields: Array<string>;

  video_id: string;
}

export interface PostUpdateMetadataParams {
  /**
   * Platform to update metadata on (YouTube only for now)
   */
  platform: 'youtube';

  /**
   * Account ID (required when post ID is '_' for direct video ID mode)
   */
  account_id?: string;

  /**
   * YouTube video ID (required when post ID is '_' for direct mode)
   */
  video_id?: string;

  /**
   * Video title (max 100 chars)
   */
  title?: string;

  /**
   * Video description
   */
  description?: string;

  /**
   * Video tags
   */
  tags?: Array<string>;

  /**
   * Video visibility
   */
  visibility?: 'public' | 'private' | 'unlisted';

  /**
   * YouTube category ID
   */
  category_id?: string;

  /**
   * COPPA compliance flag
   */
  made_for_kids?: boolean;

  /**
   * YouTube playlist ID to add the video to
   */
  playlist_id?: string;
}

export interface PostBulkCsvUploadParams {
  /**
   * Set to "true" to validate without creating posts.
   */
  dry_run?: string;
}

export interface PostBulkCsvUploadResponse {
  data: Array<PostBulkCsvUploadResponse.Data>;

  summary: PostBulkCsvUploadResponse.Summary;
}

export namespace PostBulkCsvUploadResponse {
  export interface Data {
    /**
     * 1-based row number
     */
    row: number;

    status: 'success' | 'error' | 'skipped';

    /**
     * Created post ID (only on success)
     */
    post_id?: string;

    error?: Data.Error;
  }

  export namespace Data {
    export interface Error {
      code: string;

      message: string;
    }
  }

  export interface Summary {
    failed: number;

    posts_created: number;

    /**
     * Rows skipped in dry_run mode
     */
    skipped: number;

    succeeded: number;

    total_rows: number;
  }
}

export interface PostCreateParams {
  /**
   * Publish intent. Use "now" to publish immediately, "draft" to save as draft,
   * "auto" to auto-schedule to the best available slot, or an ISO 8601 timestamp
   * to schedule.
   */
  scheduled_at: string;

  /**
   * Account IDs or platform names to publish to
   */
  targets: Array<string>;

  /**
   * Workspace ID to scope this post to
   */
  workspace_id?: string;

  /**
   * Post text. Optional if target_options provide per-target content.
   */
  content?: string;

  /**
   * Media attachments
   */
  media?: Array<PostCreateParams.Media>;

  /**
   * Recycling configuration for evergreen content (Pro plan only)
   */
  recycling?: RecyclingInput;

  /**
   * Shorten URLs in post content. Only relevant when short link mode is 'ask'.
   * Ignored when mode is 'always' or 'never'. (Pro plan only)
   */
  shorten_urls?: boolean;

  /**
   * Per-target customizations keyed by target value (account ID or platform name).
   * Supports platform-specific features such as Twitter polls
   * (`poll.options`, `poll.duration_minutes`), threads, `reply_to`, and `reply_settings`.
   */
  target_options?: { [key: string]: { [key: string]: unknown } };

  /**
   * IANA timezone for scheduling
   */
  timezone?: string;

  /**
   * Cross-post actions to execute after publishing (e.g., repost from another account)
   */
  cross_post_actions?: Array<PostCreateParams.CrossPostAction>;

  /**
   * Create post from an idea. Pre-fills content from the idea.
   */
  idea_id?: string;
}

export namespace PostCreateParams {
  export interface CrossPostAction {
    action_type: 'repost' | 'comment' | 'quote';
    target_account_id: string;
    content?: string;
    delay_minutes?: number;
  }

  export interface Media {
    /**
     * Public URL of the media file
     */
    url: string;

    /**
     * Media type. Inferred from URL extension if omitted.
     */
    type?: 'image' | 'video' | 'gif' | 'document';
  }
}

export interface PostUpdateParams {
  /**
   * Post text
   */
  content?: string;

  /**
   * Internal notes for this post
   */
  notes?: string | null;

  /**
   * Updated media
   */
  media?: Array<PostUpdateParams.Media>;

  /**
   * Recycling configuration (Pro plan only)
   */
  recycling?: RecyclingInput;

  /**
   * Publish intent. Use "now" to publish immediately, "draft" to save as draft, or
   * an ISO 8601 timestamp to schedule.
   */
  scheduled_at?: string;

  /**
   * Per-target customizations keyed by target value (account ID or platform name).
   * Supports platform-specific features such as Twitter polls
   * (`poll.options`, `poll.duration_minutes`), threads, `reply_to`, and `reply_settings`.
   */
  target_options?: { [key: string]: { [key: string]: unknown } };

  /**
   * Updated targets
   */
  targets?: Array<string>;

  timezone?: string;
}

export namespace PostUpdateParams {
  export interface Media {
    /**
     * Public URL of the media file
     */
    url: string;

    /**
     * Media type. Inferred from URL extension if omitted.
     */
    type?: 'image' | 'video' | 'gif' | 'document';
  }
}

export interface PostListParams {
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

  /**
   * Filter by specific account ID
   */
  account_id?: string;

  /**
   * Filter by post status
   */
  status?: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

  /**
   * Filter: start date (ISO 8601)
   */
  from?: string;

  /**
   * Filter: end date (ISO 8601)
   */
  to?: string;

  /**
   * Comma-separated list of fields to include (e.g. 'targets,media')
   */
  include?: string;

  /**
   * When true and status=published, also return external posts (published natively
   * on platforms) merged by published_at.
   */
  include_external?: 'true' | 'false';
}

export interface PostBulkCreateParams {
  /**
   * Array of posts to create (max 50)
   */
  posts: Array<PostBulkCreateParams.Post>;
}

export namespace PostBulkCreateParams {
  export interface Post {
    /**
     * Publish intent. Use "now" to publish immediately, "draft" to save as draft, or
     * an ISO 8601 timestamp to schedule.
     */
    scheduled_at: string;

    /**
     * Account IDs or platform names to publish to
     */
    targets: Array<string>;

    /**
     * Post text. Optional if target_options provide per-target content.
     */
    content?: string;

    /**
     * Media attachments
     */
    media?: Array<Post.Media>;

    /**
     * Per-target customizations keyed by target value (account ID or platform name).
     * Supports platform-specific features such as Twitter polls
     * (`poll.options`, `poll.duration_minutes`), threads, `reply_to`, and `reply_settings`.
     */
    target_options?: { [key: string]: { [key: string]: unknown } };

    /**
     * IANA timezone for scheduling
     */
    timezone?: string;
  }

  export namespace Post {
    export interface Media {
      /**
       * Public URL of the media file
       */
      url: string;

      /**
       * Media type. Inferred from URL extension if omitted.
       */
      type?: 'image' | 'video' | 'gif' | 'document';
    }
  }
}

/**
 * An external post fetched from a social platform (not created through RelayAPI).
 * Returned in list responses when `include_external=true` and `status=published`.
 */
export interface ExternalPost {
  id: string;
  source: 'external';
  platform: string;
  social_account_id: string;
  platform_post_id: string;
  platform_url: string | null;
  content: string | null;
  media_urls: string[];
  media_type: string | null;
  thumbnail_url: string | null;
  metrics: {
    impressions?: number;
    reach?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    clicks?: number;
    views?: number;
  };
  published_at: string;
  created_at: string;
}

Posts.Logs = Logs;

export declare namespace Posts {
  export {
    type RecyclingConfig as RecyclingConfig,
    type RecyclingInput as RecyclingInput,
    type PostSetRecyclingResponse as PostSetRecyclingResponse,
    type PostCreateResponse as PostCreateResponse,
    type PostRetrieveResponse as PostRetrieveResponse,
    type PostUpdateResponse as PostUpdateResponse,
    type PostListResponse as PostListResponse,
    type PostBulkCreateResponse as PostBulkCreateResponse,
    type PostBulkCsvUploadResponse as PostBulkCsvUploadResponse,
    type PostRetryResponse as PostRetryResponse,
    type PostUnpublishResponse as PostUnpublishResponse,
    type PostUnpublishParams as PostUnpublishParams,
    type PostNotesResponse as PostNotesResponse,
    type PostUpdateNotesParams as PostUpdateNotesParams,
    type PostUpdateMetadataResponse as PostUpdateMetadataResponse,
    type PostUpdateMetadataParams as PostUpdateMetadataParams,
    type ExternalPost as ExternalPost,
    type PostCreateParams as PostCreateParams,
    type PostUpdateParams as PostUpdateParams,
    type PostListParams as PostListParams,
    type PostBulkCreateParams as PostBulkCreateParams,
    type PostBulkCsvUploadParams as PostBulkCsvUploadParams,
  };

  export {
    Logs as Logs,
    type LogRetrieveResponse as LogRetrieveResponse,
    type LogListResponse as LogListResponse,
    type LogListParams as LogListParams,
  };
}
