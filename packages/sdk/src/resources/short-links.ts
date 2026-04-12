// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class ShortLinks extends APIResource {
  /**
   * Get the organization's short link configuration.
   */
  getConfig(options?: RequestOptions): APIPromise<ShortLinkConfigResponse> {
    return this._client.get('/v1/short-links/config', options);
  }

  /**
   * Create or update the organization's short link configuration.
   */
  updateConfig(
    body: ShortLinkUpdateConfigParams,
    options?: RequestOptions,
  ): APIPromise<ShortLinkConfigResponse> {
    return this._client.put('/v1/short-links/config', { body, ...options });
  }

  /**
   * Test the configured provider by shortening a test URL.
   */
  testConfig(options?: RequestOptions): APIPromise<ShortLinkTestResponse> {
    return this._client.post('/v1/short-links/test', options);
  }

  /**
   * List all short links for the organization.
   */
  list(
    query: ShortLinkListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ShortLinkListResponse> {
    return this._client.get('/v1/short-links', { query, ...options });
  }

  /**
   * List short links associated with a specific post.
   */
  listByPost(
    postId: string,
    options?: RequestOptions,
  ): APIPromise<ShortLinkListByPostResponse> {
    return this._client.get(path`/v1/short-links/by-post/${postId}`, options);
  }

  /**
   * Manually shorten a single URL using the configured provider.
   */
  shorten(
    body: ShortLinkShortenParams,
    options?: RequestOptions,
  ): APIPromise<ShortLinkShortenResponse> {
    return this._client.post('/v1/short-links/shorten', { body, ...options });
  }

  /**
   * Get click statistics for a specific short link.
   */
  getStats(id: string, options?: RequestOptions): APIPromise<ShortLinkStatsResponse> {
    return this._client.get(path`/v1/short-links/${id}/stats`, options);
  }
}

export interface ShortLinkConfigResponse {
  id: string | null;
  mode: 'always' | 'ask' | 'never';
  provider: 'relayapi' | 'dub' | 'short_io' | 'bitly' | null;
  has_api_key: boolean;
  domain: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ShortLinkTestResponse {
  success: boolean;
  short_url: string | null;
  error: string | null;
}

export interface ShortLinkResponse {
  id: string;
  original_url: string;
  short_url: string;
  post_id: string | null;
  click_count: number;
  created_at: string;
}

export interface ShortLinkListResponse {
  data: Array<ShortLinkResponse>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface ShortLinkListByPostResponse {
  data: Array<ShortLinkResponse>;
}

export interface ShortLinkShortenResponse {
  original_url: string;
  short_url: string;
}

export interface ShortLinkStatsResponse {
  id: string;
  short_url: string;
  original_url: string;
  click_count: number;
  last_synced_at: string | null;
}

export interface ShortLinkUpdateConfigParams {
  mode: 'always' | 'ask' | 'never';
  provider?: 'relayapi' | 'dub' | 'short_io' | 'bitly';
  api_key?: string;
  domain?: string;
}

export interface ShortLinkListParams {
  cursor?: string;
  limit?: number;
}

export interface ShortLinkShortenParams {
  url: string;
}

export declare namespace ShortLinks {
  export {
    type ShortLinkConfigResponse as ShortLinkConfigResponse,
    type ShortLinkTestResponse as ShortLinkTestResponse,
    type ShortLinkResponse as ShortLinkResponse,
    type ShortLinkListResponse as ShortLinkListResponse,
    type ShortLinkListByPostResponse as ShortLinkListByPostResponse,
    type ShortLinkShortenResponse as ShortLinkShortenResponse,
    type ShortLinkStatsResponse as ShortLinkStatsResponse,
    type ShortLinkUpdateConfigParams as ShortLinkUpdateConfigParams,
    type ShortLinkListParams as ShortLinkListParams,
    type ShortLinkShortenParams as ShortLinkShortenParams,
  };
}
