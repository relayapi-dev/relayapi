// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Workspaces extends APIResource {
  /**
   * Create a workspace
   */
  create(body: WorkspaceCreateParams, options?: RequestOptions): APIPromise<WorkspaceCreateResponse> {
    return this._client.post('/v1/workspaces', { body, ...options });
  }

  /**
   * Update a workspace
   */
  update(
    id: string,
    body: WorkspaceUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<WorkspaceUpdateResponse> {
    return this._client.patch(path`/v1/workspaces/${id}`, { body, ...options });
  }

  /**
   * List workspaces
   */
  list(query?: WorkspaceListParams, options?: RequestOptions): APIPromise<WorkspaceListResponse> {
    return this._client.get('/v1/workspaces', { query, ...options });
  }

  /**
   * Delete a workspace
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/workspaces/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface WorkspaceResponse {
  id: string;
  name: string;
  description: string | null;
  account_ids: string[];
  account_count: number;
  created_at: string;
  updated_at: string;
}

export type WorkspaceCreateResponse = WorkspaceResponse;
export type WorkspaceUpdateResponse = WorkspaceResponse;

export interface WorkspaceListResponse {
  data: Array<WorkspaceResponse>;
  next_cursor: string | null;
  has_more: boolean;
}

export interface WorkspaceCreateParams {
  name: string;
  description?: string;
}

export interface WorkspaceUpdateParams {
  name?: string;
  description?: string | null;
}

export interface WorkspaceListParams {
  search?: string;
  limit?: number;
  cursor?: string;
}

export declare namespace Workspaces {
  export {
    type WorkspaceResponse as WorkspaceResponse,
    type WorkspaceCreateResponse as WorkspaceCreateResponse,
    type WorkspaceUpdateResponse as WorkspaceUpdateResponse,
    type WorkspaceListResponse as WorkspaceListResponse,
    type WorkspaceCreateParams as WorkspaceCreateParams,
    type WorkspaceUpdateParams as WorkspaceUpdateParams,
    type WorkspaceListParams as WorkspaceListParams,
  };
}
