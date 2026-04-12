// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class APIKeys extends APIResource {
  /**
   * Create a new API key. The full key is returned only once in the response — store
   * it securely.
   */
  create(body: APIKeyCreateParams, options?: RequestOptions): APIPromise<APIKeyCreateResponse> {
    return this._client.post('/v1/api-keys', { body, ...options });
  }

  /**
   * List API keys
   */
  list(
    query: APIKeyListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<APIKeyListResponse> {
    return this._client.get('/v1/api-keys', { query, ...options });
  }

  /**
   * Delete an API key
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/api-keys/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface APIKeyCreateResponse {
  /**
   * API key ID
   */
  id: string;

  /**
   * Creation timestamp
   */
  created_at: string;

  /**
   * Expiration timestamp
   */
  expires_at: string | null;

  /**
   * Full API key (shown once, store securely)
   */
  key: string;

  /**
   * API key name
   */
  name: string | null;

  /**
   * Permission level
   */
  permission: 'read_write' | 'read_only';

  /**
   * Key prefix
   */
  prefix: string;

  /**
   * Workspace access: 'all' or array of workspace IDs
   */
  workspace_scope: 'all' | string[];
}

export interface APIKeyListResponse {
  data: Array<APIKeyListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace APIKeyListResponse {
  export interface Data {
    /**
     * API key ID
     */
    id: string;

    /**
     * Creation timestamp
     */
    created_at: string;

    /**
     * Whether the key is active
     */
    enabled: boolean;

    /**
     * Expiration timestamp
     */
    expires_at: string | null;

    /**
     * API key name
     */
    name: string | null;

    /**
     * Permission level
     */
    permission: 'read_write' | 'read_only';

    /**
     * Key prefix (e.g. rlay*live*)
     */
    prefix: string | null;

    /**
     * First 8 characters of the key (preview)
     */
    start: string;

    /**
     * Workspace access: 'all' or array of workspace IDs
     */
    workspace_scope: 'all' | string[];
  }
}

export interface APIKeyCreateParams {
  /**
   * Name for the API key
   */
  name: string;

  /**
   * Number of days until the key expires
   */
  expires_in_days?: number;

  /**
   * Permission level: read_write (default) or read_only
   */
  permission?: 'read_write' | 'read_only';

  /**
   * Workspace access: 'all' for unrestricted, or array of workspace IDs
   */
  workspace_scope?: 'all' | string[];
}

export interface APIKeyListParams {
  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;
}

export declare namespace APIKeys {
  export {
    type APIKeyCreateResponse as APIKeyCreateResponse,
    type APIKeyListResponse as APIKeyListResponse,
    type APIKeyCreateParams as APIKeyCreateParams,
    type APIKeyListParams as APIKeyListParams,
  };
}
