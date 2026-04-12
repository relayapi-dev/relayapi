// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class Connections extends APIResource {
  /**
   * Returns connection event history for the organization.
   */
  listLogs(
    query: ConnectionListLogsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ConnectionListLogsResponse> {
    return this._client.get('/v1/connections/logs', { query, ...options });
  }
}

export interface ConnectionListLogsResponse {
  data: Array<ConnectionListLogsResponse.Data>;

  has_more: boolean;

  next_cursor: string | null;
}

export namespace ConnectionListLogsResponse {
  export interface Data {
    /**
     * Log entry ID
     */
    id: string;

    /**
     * Social account ID
     */
    account_id: string | null;

    /**
     * Timestamp
     */
    created_at: string;

    /**
     * Event type
     */
    event: 'connected' | 'disconnected' | 'token_refreshed' | 'error';

    /**
     * Event details
     */
    message: string | null;

    /**
     * Platform name
     */
    platform: string;
  }
}

export interface ConnectionListLogsParams {
  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;
}

export declare namespace Connections {
  export {
    type ConnectionListLogsResponse as ConnectionListLogsResponse,
    type ConnectionListLogsParams as ConnectionListLogsParams,
  };
}
