// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class GmbAttributes extends APIResource {
  /**
   * Get business attributes
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<GmbAttributeRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/gmb-attributes`, options);
  }

  /**
   * Update business attributes
   */
  update(
    id: string,
    body: GmbAttributeUpdateParams,
    options?: RequestOptions,
  ): APIPromise<GmbAttributeUpdateResponse> {
    return this._client.put(path`/v1/accounts/${id}/gmb-attributes`, { body, ...options });
  }
}

export interface GmbAttributeRetrieveResponse {
  data: unknown;
}

export interface GmbAttributeUpdateResponse {
  data: unknown;
}

export interface GmbAttributeUpdateParams {
  /**
   * Comma-separated attribute names to update
   */
  attribute_mask: string;

  attributes: Array<GmbAttributeUpdateParams.Attribute>;
}

export namespace GmbAttributeUpdateParams {
  export interface Attribute {
    name: string;

    values: Array<unknown>;
  }
}

export declare namespace GmbAttributes {
  export {
    type GmbAttributeRetrieveResponse as GmbAttributeRetrieveResponse,
    type GmbAttributeUpdateResponse as GmbAttributeUpdateResponse,
    type GmbAttributeUpdateParams as GmbAttributeUpdateParams,
  };
}
