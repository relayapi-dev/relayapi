import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';
import type { TagResponse } from './tags';

export class Ideas extends APIResource {
  /**
   * List ideas
   */
  list(
    query: IdeaListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaListResponse> {
    return this._client.get('/v1/ideas', { query, ...options });
  }

  /**
   * Get an idea
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<IdeaResponse> {
    return this._client.get(path`/v1/ideas/${id}`, options);
  }

  /**
   * Create an idea
   */
  create(body: IdeaCreateParams, options?: RequestOptions): APIPromise<IdeaResponse> {
    return this._client.post('/v1/ideas', { body, ...options });
  }

  /**
   * Update an idea
   */
  update(
    id: string,
    body: IdeaUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaResponse> {
    return this._client.patch(path`/v1/ideas/${id}`, { body, ...options });
  }

  /**
   * Delete an idea
   *
   * FK cascades handle media, tags, comments, and activity.
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ideas/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Move an idea
   *
   * Reposition an idea within its group or move it to a different group.
   */
  move(id: string, body: IdeaMoveParams, options?: RequestOptions): APIPromise<IdeaResponse> {
    return this._client.post(path`/v1/ideas/${id}/move`, { body, ...options });
  }

  /**
   * Convert an idea to a post
   *
   * Creates a draft post pre-filled from idea content and media.
   */
  convert(id: string, body: IdeaConvertParams, options?: RequestOptions): APIPromise<IdeaConvertResponse> {
    return this._client.post(path`/v1/ideas/${id}/convert`, { body, ...options });
  }

  /**
   * Upload media to an idea (max 2MB)
   */
  uploadMedia(id: string, body: IdeaUploadMediaParams, options?: RequestOptions): APIPromise<IdeaMediaResponse> {
    return this._client.post(path`/v1/ideas/${id}/media`, {
      body,
      ...options,
      headers: buildHeaders([{ 'Content-Type': 'multipart/form-data' }, options?.headers]),
    });
  }

  /**
   * Delete idea media
   */
  deleteMedia(id: string, mediaId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ideas/${id}/media/${mediaId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * List comments on an idea
   */
  listComments(
    id: string,
    query: IdeaCommentListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaCommentListResponse> {
    return this._client.get(path`/v1/ideas/${id}/comments`, { query, ...options });
  }

  /**
   * Add a comment to an idea
   */
  createComment(
    id: string,
    body: IdeaCommentCreateParams,
    options?: RequestOptions,
  ): APIPromise<IdeaCommentResponse> {
    return this._client.post(path`/v1/ideas/${id}/comments`, { body, ...options });
  }

  /**
   * Edit a comment (own comments only)
   */
  updateComment(
    id: string,
    commentId: string,
    body: IdeaCommentUpdateParams,
    options?: RequestOptions,
  ): APIPromise<IdeaCommentResponse> {
    return this._client.patch(path`/v1/ideas/${id}/comments/${commentId}`, { body, ...options });
  }

  /**
   * Delete a comment (own comments only). FK cascade handles child replies.
   */
  deleteComment(id: string, commentId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ideas/${id}/comments/${commentId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * List activity for an idea (read-only audit log)
   */
  listActivity(
    id: string,
    query: IdeaActivityListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaActivityListResponse> {
    return this._client.get(path`/v1/ideas/${id}/activity`, { query, ...options });
  }
}

// ── Response types ────────────────────────────────────────────────────────────

export interface IdeaMediaResponse {
  id: string;
  url: string;
  type: 'image' | 'video' | 'gif' | 'document';
  alt: string | null;
  position: number;
}

export interface IdeaResponse {
  id: string;
  title: string | null;
  content: string | null;
  group_id: string;
  position: number;
  assigned_to: string | null;
  converted_to_post_id: string | null;
  tags: TagResponse[];
  media: IdeaMediaResponse[];
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaListResponse {
  data: IdeaResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface IdeaConvertResponse {
  idea: IdeaResponse;
  post_id: string;
}

export interface IdeaCommentResponse {
  id: string;
  author_id: string;
  content: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaCommentListResponse {
  data: IdeaCommentResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface IdeaActivityResponse {
  id: string;
  actor_id: string;
  action:
    | 'created'
    | 'moved'
    | 'assigned'
    | 'commented'
    | 'converted'
    | 'updated'
    | 'media_added'
    | 'media_removed'
    | 'tagged'
    | 'untagged';
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface IdeaActivityListResponse {
  data: IdeaActivityResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

// ── Param types ───────────────────────────────────────────────────────────────

export interface IdeaListParams {
  cursor?: string;
  limit?: number;
  group_id?: string;
  tag_id?: string;
  assigned_to?: string;
  workspace_id?: string;
}

export interface IdeaCreateParams {
  title?: string;
  content?: string;
  group_id?: string;
  tag_ids?: string[];
  assigned_to?: string;
  workspace_id?: string;
}

export interface IdeaUpdateParams {
  title?: string | null;
  content?: string | null;
  assigned_to?: string | null;
  tag_ids?: string[];
}

export interface IdeaMoveParams {
  group_id?: string;
  position?: number;
  after_idea_id?: string;
}

export interface IdeaConvertParams {
  targets: Array<{ account_id: string }>;
  scheduled_at?: string;
  timezone?: string;
  content?: string;
}

export interface IdeaUploadMediaParams {
  file: Blob | File;
  alt?: string;
}

export interface IdeaCommentListParams {
  cursor?: string;
  limit?: number;
}

export interface IdeaCommentCreateParams {
  content: string;
  parent_id?: string;
}

export interface IdeaCommentUpdateParams {
  content: string;
}

export interface IdeaActivityListParams {
  cursor?: string;
  limit?: number;
}

export declare namespace Ideas {
  export {
    type IdeaMediaResponse as IdeaMediaResponse,
    type IdeaResponse as IdeaResponse,
    type IdeaListResponse as IdeaListResponse,
    type IdeaConvertResponse as IdeaConvertResponse,
    type IdeaCommentResponse as IdeaCommentResponse,
    type IdeaCommentListResponse as IdeaCommentListResponse,
    type IdeaActivityResponse as IdeaActivityResponse,
    type IdeaActivityListResponse as IdeaActivityListResponse,
    type IdeaListParams as IdeaListParams,
    type IdeaCreateParams as IdeaCreateParams,
    type IdeaUpdateParams as IdeaUpdateParams,
    type IdeaMoveParams as IdeaMoveParams,
    type IdeaConvertParams as IdeaConvertParams,
    type IdeaUploadMediaParams as IdeaUploadMediaParams,
    type IdeaCommentListParams as IdeaCommentListParams,
    type IdeaCommentCreateParams as IdeaCommentCreateParams,
    type IdeaCommentUpdateParams as IdeaCommentUpdateParams,
    type IdeaActivityListParams as IdeaActivityListParams,
  };
}
