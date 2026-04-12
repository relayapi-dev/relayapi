// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class GmbMedia extends APIResource {
  /**
   * List media/photos
   */
  list(id: string, options?: RequestOptions): APIPromise<GmbMediaListResponse> {
    return this._client.get(path`/v1/accounts/${id}/gmb-media`, options);
  }

  /**
   * Upload media/photo
   */
  upload(
    id: string,
    body: GmbMediaUploadParams,
    options?: RequestOptions,
  ): APIPromise<GmbMediaUploadResponse> {
    return this._client.post(path`/v1/accounts/${id}/gmb-media`, { body, ...options });
  }

  /**
   * Delete a media item
   */
  delete(
    id: string,
    query: GmbMediaDeleteParams,
    options?: RequestOptions,
  ): APIPromise<GmbMediaDeleteResponse> {
    return this._client.delete(path`/v1/accounts/${id}/gmb-media`, { query, ...options });
  }
}

export interface GmbMediaListResponse {
  data: unknown;
}

export interface GmbMediaUploadResponse {
  data: unknown;
}

export interface GmbMediaDeleteResponse {
  data: unknown;
}

export type GmbMediaCategory =
  | 'COVER'
  | 'PROFILE'
  | 'LOGO'
  | 'EXTERIOR'
  | 'INTERIOR'
  | 'FOOD_AND_DRINK'
  | 'MENU'
  | 'PRODUCT'
  | 'AT_WORK'
  | 'COMMON_AREA'
  | 'ROOMS'
  | 'TEAMS'
  | 'ADDITIONAL';

export interface GmbMediaUploadParams {
  /**
   * Public URL of the image for Google to download
   */
  source_url: string;

  /**
   * Google Business media category
   */
  category: GmbMediaCategory;

  /**
   * Photo description
   */
  description?: string;
}

export interface GmbMediaDeleteParams {
  /**
   * Google media item ID to delete
   */
  media_id: string;
}

export declare namespace GmbMedia {
  export {
    type GmbMediaListResponse as GmbMediaListResponse,
    type GmbMediaUploadResponse as GmbMediaUploadResponse,
    type GmbMediaDeleteResponse as GmbMediaDeleteResponse,
    type GmbMediaCategory as GmbMediaCategory,
    type GmbMediaUploadParams as GmbMediaUploadParams,
    type GmbMediaDeleteParams as GmbMediaDeleteParams,
  };
}
