// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class LinkedinOrganizations extends APIResource {
  /**
   * Fetch LinkedIn organizations for an account
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<LinkedinOrganizationRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/linkedin-organizations`, options);
  }

  /**
   * Switch LinkedIn account type
   */
  switchType(
    id: string,
    body: LinkedinOrganizationSwitchTypeParams,
    options?: RequestOptions,
  ): APIPromise<LinkedinOrganizationSwitchTypeResponse> {
    return this._client.put(path`/v1/accounts/${id}/linkedin-organizations`, { body, ...options });
  }
}

export interface LinkedinOrganizationRetrieveResponse {
  data: Array<LinkedinOrganizationRetrieveResponse.Data>;
}

export namespace LinkedinOrganizationRetrieveResponse {
  export interface Data {
    id: string;

    name: string;

    vanity_name: string | null;
  }
}

export interface LinkedinOrganizationSwitchTypeResponse {
  /**
   * Account ID
   */
  id: string;

  avatar_url: string | null;

  connected_at: string;

  display_name: string | null;

  metadata: { [key: string]: unknown } | null;

  platform:
    | 'twitter'
    | 'instagram'
    | 'facebook'
    | 'linkedin'
    | 'tiktok'
    | 'youtube'
    | 'pinterest'
    | 'reddit'
    | 'bluesky'
    | 'threads'
    | 'telegram'
    | 'snapchat'
    | 'googlebusiness'
    | 'whatsapp'
    | 'mastodon'
    | 'discord'
    | 'sms';

  platform_account_id: string;

  updated_at: string;

  username: string | null;
}

export interface LinkedinOrganizationSwitchTypeParams {
  /**
   * Account type to switch to
   */
  account_type: 'personal' | 'organization';

  /**
   * LinkedIn organization ID
   */
  organization_id: string;
}

export declare namespace LinkedinOrganizations {
  export {
    type LinkedinOrganizationRetrieveResponse as LinkedinOrganizationRetrieveResponse,
    type LinkedinOrganizationSwitchTypeResponse as LinkedinOrganizationSwitchTypeResponse,
    type LinkedinOrganizationSwitchTypeParams as LinkedinOrganizationSwitchTypeParams,
  };
}
