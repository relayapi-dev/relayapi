// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as LocationsAPI from './locations';
import { LocationListResponse, LocationSelectParams, LocationSelectResponse, Locations } from './locations';

export class Googlebusiness extends APIResource {
  locations: LocationsAPI.Locations = new LocationsAPI.Locations(this._client);
}

Googlebusiness.Locations = Locations;

export declare namespace Googlebusiness {
  export {
    Locations as Locations,
    type LocationListResponse as LocationListResponse,
    type LocationSelectResponse as LocationSelectResponse,
    type LocationSelectParams as LocationSelectParams,
  };
}
