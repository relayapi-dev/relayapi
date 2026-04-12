// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Groups extends APIResource {
  /**
   * Create a contact group
   */
  create(body: GroupCreateParams, options?: RequestOptions): APIPromise<GroupCreateResponse> {
    return this._client.post('/v1/whatsapp/groups', { body, ...options });
  }

  /**
   * List contact groups
   */
  list(query: GroupListParams, options?: RequestOptions): APIPromise<GroupListResponse> {
    return this._client.get('/v1/whatsapp/groups', { query, ...options });
  }

  /**
   * Delete a contact group
   */
  delete(groupID: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/whatsapp/groups/${groupID}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface GroupCreateResponse {
  /**
   * Group ID
   */
  id: string;

  /**
   * Number of contacts
   */
  contact_count: number;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Group name
   */
  name: string;

  description?: string | null;
}

export interface GroupListResponse {
  data: Array<GroupListResponse.Data>;
}

export namespace GroupListResponse {
  export interface Data {
    /**
     * Group ID
     */
    id: string;

    /**
     * Number of contacts
     */
    contact_count: number;

    /**
     * Created timestamp
     */
    created_at: string;

    /**
     * Group name
     */
    name: string;

    description?: string | null;
  }
}

export interface GroupCreateParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;

  /**
   * Group name
   */
  name: string;

  /**
   * Initial contact IDs
   */
  contact_ids?: Array<string>;

  /**
   * Group description
   */
  description?: string;
}

export interface GroupListParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;
}

export declare namespace Groups {
  export {
    type GroupCreateResponse as GroupCreateResponse,
    type GroupListResponse as GroupListResponse,
    type GroupCreateParams as GroupCreateParams,
    type GroupListParams as GroupListParams,
  };
}
