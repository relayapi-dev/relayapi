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

  /** Principal that created this service key. */
  created_by_principal_id: string | null;

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
   * Whether this key can create, list, and revoke API keys
   */
  can_manage_api_keys: boolean;

  /** Whether this key can view billing */
  can_view_billing: boolean;

  /** Whether this key can mutate subscriptions and paid add-ons */
  can_manage_billing: boolean;

  /** Whether this key can create or increase provider spend */
  can_manage_spend: boolean;

  /** Whether this key can decrypt and view ad leads */
  can_view_ad_leads: boolean;

  /** Whether this key can promote and manage ad leads */
  can_manage_ad_leads: boolean;

  /** Whether this key can configure and submit ad conversions */
  can_manage_ad_conversions: boolean;

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
     * Principal that created the service key, when attribution metadata is
     * available.
     */
    created_by_principal_id: string | null;

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
     * Whether this key can create, list, and revoke API keys
     */
    can_manage_api_keys: boolean;

    /** Whether this key can view billing */
    can_view_billing: boolean;

    /** Whether this key can mutate subscriptions and paid add-ons */
    can_manage_billing: boolean;

    /** Whether this key can create or increase provider spend */
    can_manage_spend: boolean;

    /** Whether this key can decrypt and view ad leads */
    can_view_ad_leads: boolean;

    /** Whether this key can promote and manage ad leads */
    can_manage_ad_leads: boolean;

    /** Whether this key can configure and submit ad conversions */
    can_manage_ad_conversions: boolean;

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
   * Allow this key to administer organization API keys; requires read_write and
   * workspace_scope='all'
   */
  can_manage_api_keys?: boolean;

  /** Allow this key to view billing; organization owner grant required. */
  can_view_billing?: boolean;

  /** Allow subscription and paid add-on mutations; also requires view billing. */
  can_manage_billing?: boolean;

  /** Allow creation or increases of provider spend. */
  can_manage_spend?: boolean;

  /** Allow this key to decrypt and view ad leads. */
  can_view_ad_leads?: boolean;

  /** Allow this key to promote and manage ad leads. */
  can_manage_ad_leads?: boolean;

  /** Allow this key to configure and submit ad conversions. */
  can_manage_ad_conversions?: boolean;

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
