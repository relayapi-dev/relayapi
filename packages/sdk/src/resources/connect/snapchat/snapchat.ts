// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as ProfilesAPI from './profiles';
import { ProfileListResponse, ProfileSelectParams, ProfileSelectResponse, Profiles } from './profiles';

export class Snapchat extends APIResource {
  profiles: ProfilesAPI.Profiles = new ProfilesAPI.Profiles(this._client);
}

Snapchat.Profiles = Profiles;

export declare namespace Snapchat {
  export {
    Profiles as Profiles,
    type ProfileListResponse as ProfileListResponse,
    type ProfileSelectResponse as ProfileSelectResponse,
    type ProfileSelectParams as ProfileSelectParams,
  };
}
