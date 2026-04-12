// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Whatsapp extends APIResource {
  /**
   * Complete WhatsApp Embedded Signup
   */
  completeEmbeddedSignup(
    body: WhatsappCompleteEmbeddedSignupParams,
    options?: RequestOptions,
  ): APIPromise<WhatsappCompleteEmbeddedSignupResponse> {
    return this._client.post('/v1/connect/whatsapp/embedded-signup', { body, ...options });
  }

  /**
   * Connect WhatsApp via System User credentials
   */
  connectViaCredentials(
    body: WhatsappConnectViaCredentialsParams,
    options?: RequestOptions,
  ): APIPromise<WhatsappConnectViaCredentialsResponse> {
    return this._client.post('/v1/connect/whatsapp/credentials', { body, ...options });
  }

  /**
   * Get WhatsApp Embedded Signup SDK config
   */
  getSDKConfig(options?: RequestOptions): APIPromise<WhatsappGetSDKConfigResponse> {
    return this._client.get('/v1/connect/whatsapp/sdk-config', options);
  }
}

export interface WhatsappCompleteEmbeddedSignupResponse {
  account: WhatsappCompleteEmbeddedSignupResponse.Account;
}

export namespace WhatsappCompleteEmbeddedSignupResponse {
  export interface Account {
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
}

export interface WhatsappConnectViaCredentialsResponse {
  account: WhatsappConnectViaCredentialsResponse.Account;
}

export namespace WhatsappConnectViaCredentialsResponse {
  export interface Account {
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
}

export interface WhatsappGetSDKConfigResponse {
  /**
   * Facebook App ID for WhatsApp embedded signup
   */
  app_id: string;

  /**
   * WhatsApp configuration ID
   */
  config_id: string;
}

export interface WhatsappCompleteEmbeddedSignupParams {
  /**
   * Code from WhatsApp embedded signup flow
   */
  code: string;
}

export interface WhatsappConnectViaCredentialsParams {
  /**
   * WhatsApp Business API access token
   */
  access_token: string;

  /**
   * WhatsApp phone number ID
   */
  phone_number_id: string;

  /**
   * WhatsApp Business Account ID
   */
  waba_id: string;
}

export declare namespace Whatsapp {
  export {
    type WhatsappCompleteEmbeddedSignupResponse as WhatsappCompleteEmbeddedSignupResponse,
    type WhatsappConnectViaCredentialsResponse as WhatsappConnectViaCredentialsResponse,
    type WhatsappGetSDKConfigResponse as WhatsappGetSDKConfigResponse,
    type WhatsappCompleteEmbeddedSignupParams as WhatsappCompleteEmbeddedSignupParams,
    type WhatsappConnectViaCredentialsParams as WhatsappConnectViaCredentialsParams,
  };
}
