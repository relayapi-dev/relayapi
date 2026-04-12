// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class GmbFoodMenus extends APIResource {
  /**
   * Get food menus
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<GmbFoodMenuRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/gmb-food-menus`, options);
  }

  /**
   * Update food menus
   */
  update(
    id: string,
    body: GmbFoodMenuUpdateParams,
    options?: RequestOptions,
  ): APIPromise<GmbFoodMenuUpdateResponse> {
    return this._client.put(path`/v1/accounts/${id}/gmb-food-menus`, { body, ...options });
  }
}

export interface GmbFoodMenuRetrieveResponse {
  data: unknown;
}

export interface GmbFoodMenuUpdateResponse {
  data: unknown;
}

export interface GmbFoodMenuUpdateParams {
  sections: Array<GmbFoodMenuUpdateParams.Section>;

  update_mask?: string;
}

export namespace GmbFoodMenuUpdateParams {
  export interface Section {
    /**
     * Section name (e.g. "Appetizers")
     */
    name: string;

    items: Array<Section.Item>;
  }

  export namespace Section {
    export interface Item {
      /**
       * Menu item name
       */
      name: string;

      price?: Item.Price;

      description?: string;

      dietary?: Array<string>;

      allergens?: Array<string>;
    }

    export namespace Item {
      export interface Price {
        /**
         * Price amount (e.g. "12")
         */
        units: string;

        /**
         * ISO 4217 currency code (e.g. "USD")
         */
        currency: string;
      }
    }
  }
}

export declare namespace GmbFoodMenus {
  export {
    type GmbFoodMenuRetrieveResponse as GmbFoodMenuRetrieveResponse,
    type GmbFoodMenuUpdateResponse as GmbFoodMenuUpdateResponse,
    type GmbFoodMenuUpdateParams as GmbFoodMenuUpdateParams,
  };
}
