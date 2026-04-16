import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class IdeaGroups extends APIResource {
  /**
   * Create an idea group
   */
  create(body: IdeaGroupCreateParams, options?: RequestOptions): APIPromise<IdeaGroupCreateResponse> {
    return this._client.post('/v1/idea-groups', { body, ...options });
  }

  /**
   * Update an idea group
   */
  update(
    id: string,
    body: IdeaGroupUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaGroupUpdateResponse> {
    return this._client.patch(path`/v1/idea-groups/${id}`, { body, ...options });
  }

  /**
   * List idea groups
   */
  list(
    query: IdeaGroupListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaGroupListResponse> {
    return this._client.get('/v1/idea-groups', { query, ...options });
  }

  /**
   * Delete an idea group
   *
   * Moves all ideas in the group to the default 'Unassigned' group before deleting.
   * Cannot delete the default group.
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/idea-groups/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Reorder idea groups
   */
  reorder(body: IdeaGroupReorderParams, options?: RequestOptions): APIPromise<IdeaGroupListResponse> {
    return this._client.post('/v1/idea-groups/reorder', { body, ...options });
  }
}

export interface IdeaGroupResponse {
  id: string;
  name: string;
  position: number;
  color: string | null;
  is_default: boolean;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export type IdeaGroupCreateResponse = IdeaGroupResponse;
export type IdeaGroupUpdateResponse = IdeaGroupResponse;

export interface IdeaGroupListResponse {
  data: Array<IdeaGroupResponse>;
}

export interface IdeaGroupCreateParams {
  name: string;
  color?: string;
  position?: number;
  workspace_id?: string;
}

export interface IdeaGroupUpdateParams {
  name?: string;
  color?: string | null;
}

export interface IdeaGroupListParams {
  workspace_id?: string;
}

export interface IdeaGroupReorderParams {
  groups: Array<{
    id: string;
    position: number;
  }>;
}

export declare namespace IdeaGroups {
  export {
    type IdeaGroupResponse as IdeaGroupResponse,
    type IdeaGroupCreateResponse as IdeaGroupCreateResponse,
    type IdeaGroupUpdateResponse as IdeaGroupUpdateResponse,
    type IdeaGroupListResponse as IdeaGroupListResponse,
    type IdeaGroupCreateParams as IdeaGroupCreateParams,
    type IdeaGroupUpdateParams as IdeaGroupUpdateParams,
    type IdeaGroupListParams as IdeaGroupListParams,
    type IdeaGroupReorderParams as IdeaGroupReorderParams,
  };
}
