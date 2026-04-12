// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class InviteTokens extends APIResource {
  /**
   * Create a single-use invite token with a 7-day expiry. The full token is returned
   * only once — store it securely.
   */
  create(
    body: InviteTokenCreateParams,
    options?: RequestOptions,
  ): APIPromise<InviteTokenCreateResponse> {
    return this._client.post('/v1/invite/tokens', { body, ...options });
  }

  /**
   * List invite tokens
   */
  list(
    query: InviteTokenListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<InviteTokenListResponse> {
    return this._client.get('/v1/invite/tokens', { query, ...options });
  }

  /**
   * Revoke an invite token
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/invite/tokens/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface InviteTokenCreateResponse {
  /**
   * Invite token ID
   */
  id: string;

  /**
   * Creation timestamp
   */
  created_at: string;

  /**
   * Expiration timestamp
   */
  expires_at: string;

  /**
   * Invite URL to share
   */
  invite_url: string;

  /**
   * Role assigned on acceptance
   */
  role: 'owner' | 'admin' | 'member';

  /**
   * Access scope
   */
  scope: 'all' | 'workspaces';

  /**
   * Full invite token (shown once, store securely)
   */
  token: string;

  /**
   * Scoped workspace IDs
   */
  workspace_ids: string[] | null;
}

export interface InviteTokenListResponse {
  data: Array<InviteTokenListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace InviteTokenListResponse {
  export interface Data {
    /**
     * Invite token ID
     */
    id: string;

    /**
     * Creation timestamp
     */
    created_at: string;

    /**
     * Expiration timestamp
     */
    expires_at: string;

    /**
     * Role assigned on acceptance
     */
    role: 'owner' | 'admin' | 'member';

    /**
     * Access scope
     */
    scope: 'all' | 'workspaces';

    /**
     * Whether the token has been used
     */
    used: boolean;

    /**
     * Scoped workspace IDs
     */
    workspace_ids: string[] | null;
  }
}

export interface InviteTokenCreateParams {
  /**
   * Role to assign on acceptance
   */
  role?: 'owner' | 'admin' | 'member';

  /**
   * Access scope: 'all' for full org access, or 'workspaces' for specific workspaces
   */
  scope?: 'all' | 'workspaces';

  /**
   * Workspace IDs to scope access to (required when scope is 'workspaces')
   */
  workspace_ids?: string[];
}

export interface InviteTokenListParams {
  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;
}

export declare namespace InviteTokens {
  export {
    type InviteTokenCreateResponse as InviteTokenCreateResponse,
    type InviteTokenListResponse as InviteTokenListResponse,
    type InviteTokenCreateParams as InviteTokenCreateParams,
    type InviteTokenListParams as InviteTokenListParams,
  };
}
