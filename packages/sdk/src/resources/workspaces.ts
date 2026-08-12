// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
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
    body: WorkspaceUpdateParams,
    options?: RequestOptions,
  ): APIPromise<WorkspaceUpdateResponse> {
    return this._client.patch(path`/v1/workspaces/${id}`, { body, ...options });
  }

  /**
   * Archive a workspace without deleting its data.
   */
  archive(
    id: string,
    body: WorkspaceLifecycleParams,
    options?: RequestOptions,
  ): APIPromise<WorkspaceUpdateResponse> {
    return this._client.post(path`/v1/workspaces/${id}/archive`, { body, ...options });
  }

  /**
   * Restore an archived workspace.
   */
  restore(
    id: string,
    body: WorkspaceLifecycleParams,
    options?: RequestOptions,
  ): APIPromise<WorkspaceUpdateResponse> {
    return this._client.post(path`/v1/workspaces/${id}/restore`, { body, ...options });
  }

  /**
   * List workspaces
   */
  list(query?: WorkspaceListParams, options?: RequestOptions): APIPromise<WorkspaceListResponse> {
    return this._client.get('/v1/workspaces', { query, ...options });
  }

  /**
   * Request irreversible erasure of an archived workspace.
   */
  delete(
    id: string,
    body: WorkspaceDeleteParams,
    options?: RequestOptions,
  ): APIPromise<WorkspaceDeleteResponse> {
    return this._client.delete(path`/v1/workspaces/${id}`, { body, ...options });
  }
}

export interface WorkspaceResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  lifecycle_status: 'active' | 'archived' | 'erasing';
  revision: number;
  archived_at: string | null;
  erasure_requested_at: string | null;
  account_ids: string[];
  account_count: number;
  created_at: string;
  updated_at: string;
}

export type WorkspaceCreateResponse = WorkspaceResponse;
export type WorkspaceUpdateResponse = WorkspaceResponse;

export interface WorkspaceDeleteResponse {
  workspace_id: string;
  erasure_operation_id: string;
  status: 'pending' | 'processing' | 'held' | 'manual_review' | 'failed' | 'purged';
  requested_at: string;
}

export interface WorkspaceListResponse {
  data: Array<WorkspaceResponse>;
  next_cursor: string | null;
  has_more: boolean;
}

export interface WorkspaceCreateParams {
  name: string;
  slug?: string;
  description?: string;
}

export interface WorkspaceUpdateParams {
  expected_revision: number;
  name?: string;
  slug?: string;
  description?: string | null;
}

export interface WorkspaceLifecycleParams {
  expected_revision: number;
}

export type WorkspaceDeleteParams = WorkspaceLifecycleParams;

export interface WorkspaceListParams {
  search?: string;
  lifecycle_status?: 'active' | 'archived' | 'erasing' | 'all';
  limit?: number;
  cursor?: string;
}

export declare namespace Workspaces {
  export {
    type WorkspaceResponse as WorkspaceResponse,
    type WorkspaceCreateResponse as WorkspaceCreateResponse,
    type WorkspaceUpdateResponse as WorkspaceUpdateResponse,
    type WorkspaceDeleteResponse as WorkspaceDeleteResponse,
    type WorkspaceListResponse as WorkspaceListResponse,
    type WorkspaceCreateParams as WorkspaceCreateParams,
    type WorkspaceUpdateParams as WorkspaceUpdateParams,
    type WorkspaceLifecycleParams as WorkspaceLifecycleParams,
    type WorkspaceDeleteParams as WorkspaceDeleteParams,
    type WorkspaceListParams as WorkspaceListParams,
  };
}
