// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Health extends APIResource {
  /**
   * Check health of a single connected account
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<HealthRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/health`, options);
  }

  /**
   * Check health of all connected accounts
   */
  list(
    query: HealthListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<HealthListResponse> {
    return this._client.get('/v1/accounts/health', { query, ...options });
  }
}

export interface HealthRetrieveResponse {
  id: string;

  healthy: boolean;

  platform: string;

  token_expires_at: string | null;

  username: string | null;

  display_name: string | null;

  avatar_url: string | null;

  scopes: string[];

  sync?: HealthRetrieveResponse.Sync | null;

  error?: HealthRetrieveResponse.Error;
}

export namespace HealthRetrieveResponse {
  export interface Sync {
    enabled: boolean;

    last_sync_at: string | null;

    next_sync_at: string | null;

    total_posts_synced: number;

    total_sync_runs: number;

    last_error: string | null;

    last_error_at: string | null;

    consecutive_errors: number;

    rate_limit_reset_at: string | null;
  }

  export interface Error {
    code: string;

    message: string;
  }
}

export interface HealthListParams {
  cursor?: string;

  limit?: number;
}

export interface HealthListResponse {
  data: Array<HealthListResponse.Data>;

  next_cursor: string | null;

  has_more: boolean;
}

export namespace HealthListResponse {
  export interface Data {
    id: string;

    healthy: boolean;

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

    token_expires_at: string | null;

    username: string | null;

    display_name: string | null;

    avatar_url: string | null;

    scopes: string[];

    workspace: Data.Workspace | null;

    sync?: Data.Sync | null;

    error?: Data.Error;
  }

  export namespace Data {
    export interface Sync {
      enabled: boolean;

      last_sync_at: string | null;

      next_sync_at: string | null;

      total_posts_synced: number;

      total_sync_runs: number;

      last_error: string | null;

      last_error_at: string | null;

      consecutive_errors: number;

      rate_limit_reset_at: string | null;
    }

    export interface Error {
      code: string;

      message: string;
    }

    export interface Workspace {
      id: string;

      name: string;
    }
  }
}

export declare namespace Health {
  export {
    type HealthRetrieveResponse as HealthRetrieveResponse,
    type HealthListParams as HealthListParams,
    type HealthListResponse as HealthListResponse,
  };
}
