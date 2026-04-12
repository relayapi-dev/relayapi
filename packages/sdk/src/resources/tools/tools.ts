// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as InstagramAPI from './instagram';
import {
  Instagram,
  InstagramCheckHashtagSafetyParams,
  InstagramCheckHashtagSafetyResponse,
} from './instagram';
import * as ValidateAPI from './validate';
import {
  Validate,
  ValidateCheckPostLengthParams,
  ValidateCheckPostLengthResponse,
  ValidateRetrieveSubredditParams,
  ValidateRetrieveSubredditResponse,
  ValidateValidateMediaParams,
  ValidateValidateMediaResponse,
  ValidateValidatePostParams,
  ValidateValidatePostResponse,
} from './validate';

export class Tools extends APIResource {
  validate: ValidateAPI.Validate = new ValidateAPI.Validate(this._client);
  instagram: InstagramAPI.Instagram = new InstagramAPI.Instagram(this._client);
}

Tools.Validate = Validate;
Tools.Instagram = Instagram;

export declare namespace Tools {
  export {
    Validate as Validate,
    type ValidateCheckPostLengthResponse as ValidateCheckPostLengthResponse,
    type ValidateRetrieveSubredditResponse as ValidateRetrieveSubredditResponse,
    type ValidateValidateMediaResponse as ValidateValidateMediaResponse,
    type ValidateValidatePostResponse as ValidateValidatePostResponse,
    type ValidateCheckPostLengthParams as ValidateCheckPostLengthParams,
    type ValidateRetrieveSubredditParams as ValidateRetrieveSubredditParams,
    type ValidateValidateMediaParams as ValidateValidateMediaParams,
    type ValidateValidatePostParams as ValidateValidatePostParams,
  };

  export {
    Instagram as Instagram,
    type InstagramCheckHashtagSafetyResponse as InstagramCheckHashtagSafetyResponse,
    type InstagramCheckHashtagSafetyParams as InstagramCheckHashtagSafetyParams,
  };
}
