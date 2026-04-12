// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class GmbPlaceActions extends APIResource {
  /**
   * List place action links
   */
  list(id: string, options?: RequestOptions): APIPromise<GmbPlaceActionListResponse> {
    return this._client.get(path`/v1/accounts/${id}/gmb-place-actions`, options);
  }

  /**
   * Create a place action link
   */
  create(
    id: string,
    body: GmbPlaceActionCreateParams,
    options?: RequestOptions,
  ): APIPromise<GmbPlaceActionCreateResponse> {
    return this._client.post(path`/v1/accounts/${id}/gmb-place-actions`, { body, ...options });
  }

  /**
   * Delete a place action link
   */
  delete(
    id: string,
    query: GmbPlaceActionDeleteParams,
    options?: RequestOptions,
  ): APIPromise<GmbPlaceActionDeleteResponse> {
    return this._client.delete(path`/v1/accounts/${id}/gmb-place-actions`, { query, ...options });
  }
}

export interface GmbPlaceActionListResponse {
  data: unknown;
}

export interface GmbPlaceActionCreateResponse {
  data: unknown;
}

export interface GmbPlaceActionDeleteResponse {
  data: unknown;
}

export type GmbPlaceActionType =
  | 'APPOINTMENT'
  | 'ONLINE_APPOINTMENT'
  | 'DINING_RESERVATION'
  | 'FOOD_ORDERING'
  | 'FOOD_DELIVERY'
  | 'FOOD_TAKEOUT'
  | 'SHOP_ONLINE';

export interface GmbPlaceActionCreateParams {
  type: GmbPlaceActionType;

  /**
   * Action link URL
   */
  url: string;

  /**
   * Display name for the action
   */
  name?: string;
}

export interface GmbPlaceActionDeleteParams {
  /**
   * Place action link ID to delete
   */
  action_id: string;
}

export declare namespace GmbPlaceActions {
  export {
    type GmbPlaceActionListResponse as GmbPlaceActionListResponse,
    type GmbPlaceActionCreateResponse as GmbPlaceActionCreateResponse,
    type GmbPlaceActionDeleteResponse as GmbPlaceActionDeleteResponse,
    type GmbPlaceActionType as GmbPlaceActionType,
    type GmbPlaceActionCreateParams as GmbPlaceActionCreateParams,
    type GmbPlaceActionDeleteParams as GmbPlaceActionDeleteParams,
  };
}
