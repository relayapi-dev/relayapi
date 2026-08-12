// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Media extends APIResource {
  /**
   * List media files
   */
  list(
    query: MediaListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<MediaListResponse> {
    return this._client.get('/v1/media', { query, ...options });
  }

  /**
   * Get media details
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<MediaRetrieveResponse> {
    return this._client.get(path`/v1/media/${id}`, options);
  }

  /**
   * Delete media
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/media/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Create a pending media upload intent and generate a pre-signed R2 PUT URL. PUT
   * the file with the exact declared Content-Type, then call confirm(); confirmation
   * is mandatory before using the canonical media URL.
   */
  getPresignURL(
    body: MediaGetPresignURLParams,
    options?: RequestOptions,
  ): APIPromise<MediaGetPresignURLResponse> {
    return this._client.post('/v1/media/presign', { body, ...options });
  }

  /**
   * Mandatory final step for a presigned upload. Verifies the stored object and
   * marks the pending media intent ready.
   */
  confirm(body: MediaConfirmParams, options?: RequestOptions): APIPromise<MediaRetrieveResponse> {
    return this._client.post('/v1/media/confirm', { body, ...options });
  }

  /**
   * Upload a raw file body. Pass the filename as a query parameter and set the
   * Content-Type header to the file's actual allowed media type.
   */
  upload(
    body: string | ArrayBuffer | ArrayBufferView | Blob | DataView | ReadableStream<Uint8Array>,
    params: MediaUploadParams,
    options?: RequestOptions,
  ): APIPromise<MediaUploadResponse> {
    const { filename, content_type, workspace_id } = params;
    return this._client.post('/v1/media/upload', {
      body: body,
      query: { filename, workspace_id },
      ...options,
      headers: buildHeaders([{ 'Content-Type': content_type }, options?.headers]),
    });
  }

  /** Create a direct-to-storage upload session for files up to 200 MiB. */
  createUploadSession(
    body: MediaCreateUploadSessionParams,
    options?: RequestOptions,
  ): APIPromise<MediaUploadSession> {
    return this._client.post('/v1/media/uploads', { body, ...options });
  }

  /** Retrieve a resumable upload session and its processing projection. */
  retrieveUploadSession(id: string, options?: RequestOptions): APIPromise<MediaUploadSession> {
    return this._client.get(path`/v1/media/uploads/${id}`, options);
  }

  /** Mint bounded-lived URLs for selected multipart part numbers. */
  createUploadPartURLs(
    id: string,
    body: MediaCreateUploadPartURLsParams,
    options?: RequestOptions,
  ): APIPromise<MediaUploadPartURLsResponse> {
    return this._client.post(path`/v1/media/uploads/${id}/parts`, { body, ...options });
  }

  /** Complete a single-part or multipart upload after every byte is stored. */
  completeUploadSession(
    id: string,
    body: MediaCompleteUploadSessionParams = { parts: [] },
    options?: RequestOptions,
  ): APIPromise<MediaRetrieveResponse> {
    return this._client.post(path`/v1/media/uploads/${id}/complete`, { body, ...options });
  }

  /** Abort an incomplete upload session. */
  abortUploadSession(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/media/uploads/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /** Request normalization, a provider-specific derivative, or a custom cover. */
  process(
    id: string,
    body: MediaProcessParams,
    options?: RequestOptions,
  ): APIPromise<MediaRetrieveResponse> {
    return this._client.post(path`/v1/media/${id}/process`, { body, ...options });
  }
}

export interface MediaRetrieveResponse {
  /**
   * Media ID
   */
  id: string;

  /**
   * Whether original bytes remain available for provider delivery
   */
  original_available: boolean;

  /**
   * Workspace scope, or null for organization-shared media
   */
  workspace_id: string | null;

  /**
   * Upload timestamp
   */
  created_at: string;

  /**
   * Original filename
   */
  filename: string;

  /**
   * MIME type
   */
  mime_type: string;

  /**
   * File size in bytes
   */
  size: number;

  /**
   * Original URL while retained, otherwise the durable thumbnail URL; null when
   * neither is available
   */
  url: string | null;

  /**
   * Stable canonical attachment URL while the original remains available. Use
   * this value in post media payloads instead of the expiring read URL.
   */
  reference_url: string | null;

  /**
   * Duration in seconds (video/audio)
   */
  duration?: number | null;

  /**
   * Height in pixels
   */
  height?: number | null;

  /**
   * Width in pixels
   */
  width?: number | null;

  /** Asynchronous normalization/derivative state. */
  processing_status?: 'not_requested' | 'pending' | 'processing' | 'ready' | 'failed';

  processing_error?: { code: string; message: string } | null;

  variants?: Array<MediaVariant>;

  /** Whether additional derivative variants were omitted. */
  variants_truncated?: boolean;
}

export interface MediaVariant {
  id: string;
  kind: 'normalized' | 'provider' | 'cover' | 'gif_video';
  profile: string;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  status: 'processing' | 'ready' | 'failed' | 'deleting';
}

export interface MediaUploadSession {
  id: string;
  media_id: string;
  mode: 'single' | 'multipart';
  status:
    | 'created'
    | 'uploading'
    | 'completing'
    | 'completed'
    | 'aborting'
    | 'aborted'
    | 'failed'
    | 'expired';
  expected_size: number;
  content_type: string;
  part_size: number | null;
  part_count: number | null;
  expires_at: string;
  upload?: { url: string; headers: Record<string, string> } | null;
  media?: MediaRetrieveResponse | null;
  error?: { code: string; message: string } | null;
}

export interface MediaCreateUploadSessionParams {
  filename: string;
  content_type: string;
  size_bytes: number;
  workspace_id?: string;
}

export interface MediaCreateUploadPartURLsParams {
  part_numbers: Array<number>;
}

export interface MediaUploadPartURLsResponse {
  upload_id: string;
  parts: Array<{
    part_number: number;
    upload_url: string;
    upload_headers: Record<string, string>;
    expires_at: string;
  }>;
}

export interface MediaCompleteUploadSessionParams {
  parts?: Array<{ part_number: number; etag: string }>;
}

export type MediaProcessParams =
  | {
      operation: 'normalize' | 'provider_variant';
      profile: string;
      options?: {
        compression_mode?: 'balanced' | 'high_quality' | 'smaller';
        fail_open?: boolean;
      };
    }
  | {
      operation: 'cover';
      profile: string;
      options?: { timestamp_seconds?: number };
    };

export interface MediaGetPresignURLResponse {
  /**
   * ID of the pending media upload intent
   */
  id: string;

  /**
   * Seconds until the upload URL expires
   */
  expires_in: number;

  /**
   * Pre-signed PUT URL for uploading
   */
  upload_url: string;

  /**
   * Exact headers required by the pre-signed create-only PUT
   */
  upload_headers: MediaGetPresignURLResponse.UploadHeaders;

  /**
   * Public URL after upload completes
   */
  url: string;
}

export namespace MediaGetPresignURLResponse {
  export interface UploadHeaders {
    'Content-Type': string;

    'If-None-Match': '*';
  }
}

export interface MediaUploadResponse {
  /**
   * ID of the ready media record
   */
  id: string;

  /**
   * Original filename
   */
  filename: string;

  /**
   * File size in bytes
   */
  size: number;

  /**
   * MIME type of the uploaded file
   */
  type: string;

  /**
   * Public URL of the uploaded file
   */
  url: string;
}

export interface MediaGetPresignURLParams {
  /**
   * MIME type of the file to upload
   */
  content_type: string;

  /**
   * Desired filename
   */
  filename: string;

  /**
   * Workspace ID for the media record
   */
  workspace_id?: string;
}

export interface MediaConfirmParams {
  /**
   * The path portion of the canonical url returned by getPresignURL(), without the
   * leading slash
   */
  storage_key: string;
}

export interface MediaUploadParams {
  /**
   * The file's actual MIME type. Generic application/octet-stream is rejected.
   */
  content_type: string;

  /**
   * Query param: Original filename
   */
  filename: string;

  /**
   * Workspace ID for the media record
   */
  workspace_id?: string;
}

export interface MediaListParams {
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

export interface MediaListResponse {
  data: Array<MediaListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace MediaListResponse {
  export interface Data {
    /**
     * Media ID
     */
    id: string;

    /**
     * Whether original bytes remain available for provider delivery
     */
    original_available: boolean;

    /**
     * Workspace scope, or null for organization-shared media
     */
    workspace_id: string | null;

    /**
     * Upload timestamp
     */
    created_at: string;

    /**
     * Original filename
     */
    filename: string;

    /**
     * MIME type
     */
    mime_type: string;

    /**
     * File size in bytes
     */
    size: number;

    /**
     * Original URL while retained, otherwise the durable thumbnail URL; null when
     * neither is available
     */
    url: string | null;

    /**
     * Stable canonical attachment URL while the original remains available. Use
     * this value in post media payloads instead of the expiring read URL.
     */
    reference_url: string | null;

    /**
     * Duration in seconds (video/audio)
     */
    duration?: number | null;

    /**
     * Height in pixels
     */
    height?: number | null;

    /**
     * Width in pixels
     */
    width?: number | null;

    processing_status?: 'not_requested' | 'pending' | 'processing' | 'ready' | 'failed';

    processing_error?: { code: string; message: string } | null;

    variants?: Array<MediaVariant>;

    variants_truncated?: boolean;
  }
}

export declare namespace Media {
  export {
    type MediaListResponse as MediaListResponse,
    type MediaRetrieveResponse as MediaRetrieveResponse,
    type MediaGetPresignURLResponse as MediaGetPresignURLResponse,
    type MediaConfirmParams as MediaConfirmParams,
    type MediaUploadResponse as MediaUploadResponse,
    type MediaListParams as MediaListParams,
    type MediaGetPresignURLParams as MediaGetPresignURLParams,
    type MediaUploadParams as MediaUploadParams,
    type MediaVariant as MediaVariant,
    type MediaUploadSession as MediaUploadSession,
    type MediaCreateUploadSessionParams as MediaCreateUploadSessionParams,
    type MediaCreateUploadPartURLsParams as MediaCreateUploadPartURLsParams,
    type MediaUploadPartURLsResponse as MediaUploadPartURLsResponse,
    type MediaCompleteUploadSessionParams as MediaCompleteUploadSessionParams,
    type MediaProcessParams as MediaProcessParams,
  };
}
