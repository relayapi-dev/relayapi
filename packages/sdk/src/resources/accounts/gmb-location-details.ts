// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class GmbLocationDetails extends APIResource {
  /**
   * Get location details
   */
  retrieve(
    id: string,
    query?: GmbLocationDetailRetrieveParams | null | undefined,
    options?: RequestOptions,
  ): APIPromise<GmbLocationDetailRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/gmb-location-details`, { query, ...options });
  }

  /**
   * Update location details
   */
  update(
    id: string,
    body: GmbLocationDetailUpdateParams,
    options?: RequestOptions,
  ): APIPromise<GmbLocationDetailUpdateResponse> {
    return this._client.put(path`/v1/accounts/${id}/gmb-location-details`, { body, ...options });
  }
}

export interface GmbLocationDetailRetrieveResponse {
  data: unknown;
}

export interface GmbLocationDetailUpdateResponse {
  data: unknown;
}

export interface GmbLocationDetailRetrieveParams {
  /**
   * Comma-separated fields to read (e.g. "regularHours,profile.description")
   */
  read_mask?: string;
}

export interface GmbLocationDetailUpdateParams {
  /**
   * Comma-separated fields to update
   */
  update_mask: string;

  regularHours?: unknown;

  specialHours?: unknown;

  profile?: GmbLocationDetailUpdateParams.Profile;

  websiteUri?: string;

  phoneNumbers?: GmbLocationDetailUpdateParams.PhoneNumbers;

  categories?: unknown;

  serviceItems?: unknown;
}

export namespace GmbLocationDetailUpdateParams {
  export interface Profile {
    description?: string;
  }

  export interface PhoneNumbers {
    primaryPhone?: string;

    additionalPhones?: Array<string>;
  }
}

export declare namespace GmbLocationDetails {
  export {
    type GmbLocationDetailRetrieveResponse as GmbLocationDetailRetrieveResponse,
    type GmbLocationDetailUpdateResponse as GmbLocationDetailUpdateResponse,
    type GmbLocationDetailRetrieveParams as GmbLocationDetailRetrieveParams,
    type GmbLocationDetailUpdateParams as GmbLocationDetailUpdateParams,
  };
}
