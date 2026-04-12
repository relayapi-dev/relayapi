// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as TelegramAPI from './telegram';
import {
  Telegram,
  TelegramConnectDirectlyParams,
  TelegramConnectDirectlyResponse,
  TelegramInitiateConnectionResponse,
  TelegramPollConnectionStatusParams,
  TelegramPollConnectionStatusResponse,
} from './telegram';
import * as WhatsappAPI from './whatsapp';
import {
  Whatsapp,
  WhatsappCompleteEmbeddedSignupParams,
  WhatsappCompleteEmbeddedSignupResponse,
  WhatsappConnectViaCredentialsParams,
  WhatsappConnectViaCredentialsResponse,
  WhatsappGetSDKConfigResponse,
} from './whatsapp';
import * as FacebookAPI from './facebook/facebook';
import { Facebook } from './facebook/facebook';
import * as GooglebusinessAPI from './googlebusiness/googlebusiness';
import { Googlebusiness } from './googlebusiness/googlebusiness';
import * as LinkedinAPI from './linkedin/linkedin';
import { Linkedin } from './linkedin/linkedin';
import * as PinterestAPI from './pinterest/pinterest';
import { Pinterest } from './pinterest/pinterest';
import * as SnapchatAPI from './snapchat/snapchat';
import { Snapchat } from './snapchat/snapchat';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Connect extends APIResource {
  telegram: TelegramAPI.Telegram = new TelegramAPI.Telegram(this._client);
  whatsapp: WhatsappAPI.Whatsapp = new WhatsappAPI.Whatsapp(this._client);
  facebook: FacebookAPI.Facebook = new FacebookAPI.Facebook(this._client);
  linkedin: LinkedinAPI.Linkedin = new LinkedinAPI.Linkedin(this._client);
  pinterest: PinterestAPI.Pinterest = new PinterestAPI.Pinterest(this._client);
  googlebusiness: GooglebusinessAPI.Googlebusiness = new GooglebusinessAPI.Googlebusiness(this._client);
  snapchat: SnapchatAPI.Snapchat = new SnapchatAPI.Snapchat(this._client);

  /**
   * Exchange OAuth code for tokens and save the account.
   */
  completeOAuthCallback(
    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'threads'
      | 'snapchat'
      | 'googlebusiness'
      | 'mastodon',
    body: ConnectCompleteOAuthCallbackParams,
    options?: RequestOptions,
  ): APIPromise<ConnectCompleteOAuthCallbackResponse> {
    return this._client.post(path`/v1/connect/${platform}`, { body, ...options });
  }

  /**
   * Connect Bluesky via app password
   */
  createBlueskyConnection(
    body: ConnectCreateBlueskyConnectionParams,
    options?: RequestOptions,
  ): APIPromise<ConnectCreateBlueskyConnectionResponse> {
    return this._client.post('/v1/connect/bluesky', { body, ...options });
  }

  /**
   * One-time use, expires after 10 minutes. For headless OAuth flows.
   */
  fetchPendingData(
    query: ConnectFetchPendingDataParams,
    options?: RequestOptions,
  ): APIPromise<ConnectFetchPendingDataResponse> {
    return this._client.get('/v1/connect/pending-data', { query, ...options });
  }

  /**
   * Returns an auth_url to redirect the user for OAuth authorization.
   */
  startOAuthFlow(
    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'threads'
      | 'snapchat'
      | 'googlebusiness'
      | 'mastodon',
    query: ConnectStartOAuthFlowParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ConnectStartOAuthFlowResponse> {
    return this._client.get(path`/v1/connect/${platform}`, { query, ...options });
  }

  /**
   * Connect a Beehiiv newsletter account via API key.
   */
  connectBeehiiv(
    body: ConnectBeehiivParams,
    options?: RequestOptions,
  ): APIPromise<ConnectNewsletterResponse> {
    return this._client.post('/v1/connect/beehiiv', { body, ...options });
  }

  /**
   * Connect a ConvertKit (Kit) newsletter account via API key.
   */
  connectConvertKit(
    body: ConnectConvertKitParams,
    options?: RequestOptions,
  ): APIPromise<ConnectNewsletterResponse> {
    return this._client.post('/v1/connect/convertkit', { body, ...options });
  }

  /**
   * Connect a Mailchimp newsletter account via API key.
   */
  connectMailchimp(
    body: ConnectMailchimpParams,
    options?: RequestOptions,
  ): APIPromise<ConnectNewsletterResponse> {
    return this._client.post('/v1/connect/mailchimp', { body, ...options });
  }

  /**
   * Connect a self-hosted ListMonk newsletter instance.
   */
  connectListMonk(
    body: ConnectListMonkParams,
    options?: RequestOptions,
  ): APIPromise<ConnectNewsletterResponse> {
    return this._client.post('/v1/connect/listmonk', { body, ...options });
  }
}

export interface ConnectCompleteOAuthCallbackResponse {
  account: ConnectCompleteOAuthCallbackResponse.Account;
}

export namespace ConnectCompleteOAuthCallbackResponse {
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

export interface ConnectCreateBlueskyConnectionResponse {
  account: ConnectCreateBlueskyConnectionResponse.Account;
}

export namespace ConnectCreateBlueskyConnectionResponse {
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

export interface ConnectFetchPendingDataResponse {
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

  /**
   * Token to use for secondary selection
   */
  temp_token: string;

  /**
   * Basic user profile from the platform
   */
  user_profile: ConnectFetchPendingDataResponse.UserProfile;

  /**
   * Pinterest boards available
   */
  boards?: Array<{ [key: string]: unknown }>;

  /**
   * Google Business locations available
   */
  locations?: Array<{ [key: string]: unknown }>;

  /**
   * LinkedIn organizations available
   */
  organizations?: Array<{ [key: string]: unknown }>;

  /**
   * Facebook pages available
   */
  pages?: Array<{ [key: string]: unknown }>;

  /**
   * Snapchat profiles available
   */
  profiles?: Array<{ [key: string]: unknown }>;
}

export namespace ConnectFetchPendingDataResponse {
  /**
   * Basic user profile from the platform
   */
  export interface UserProfile {
    id: string;

    avatar_url: string | null;

    name: string | null;

    username: string | null;
  }
}

export interface ConnectStartOAuthFlowResponse {
  /**
   * URL to redirect the user for OAuth authorization
   */
  auth_url: string;
}

export interface ConnectCompleteOAuthCallbackParams {
  /**
   * OAuth authorization code
   */
  code: string;

  /**
   * Redirect URL used during the OAuth flow (must match)
   */
  redirect_url?: string;
}

export interface ConnectCreateBlueskyConnectionParams {
  /**
   * Bluesky app password
   */
  app_password: string;

  /**
   * Bluesky handle (e.g. user.bsky.social)
   */
  handle: string;
}

export interface ConnectFetchPendingDataParams {
  /**
   * Temporary token from headless OAuth flow
   */
  token: string;
}

export interface ConnectStartOAuthFlowParams {
  /**
   * Set to "true" for headless mode (returns data instead of redirecting)
   */
  headless?: string;

  /**
   * Auth method variant (e.g. "direct" for Instagram Login instead of Facebook Login)
   */
  method?: string;

  /**
   * URL to redirect after OAuth completes
   */
  redirect_url?: string;
}

export interface ConnectNewsletterResponse {
  account_id: string;
  platform: string;
  username: string;
  display_name: string;
}

export interface ConnectBeehiivParams {
  api_key: string;
  publication_id: string;
}

export interface ConnectConvertKitParams {
  api_key: string;
  api_secret: string;
}

export interface ConnectMailchimpParams {
  api_key: string;
}

export interface ConnectListMonkParams {
  instance_url: string;
  username: string;
  password: string;
}

Connect.Telegram = Telegram;
Connect.Whatsapp = Whatsapp;
Connect.Facebook = Facebook;
Connect.Linkedin = Linkedin;
Connect.Pinterest = Pinterest;
Connect.Googlebusiness = Googlebusiness;
Connect.Snapchat = Snapchat;

export declare namespace Connect {
  export {
    type ConnectCompleteOAuthCallbackResponse as ConnectCompleteOAuthCallbackResponse,
    type ConnectCreateBlueskyConnectionResponse as ConnectCreateBlueskyConnectionResponse,
    type ConnectFetchPendingDataResponse as ConnectFetchPendingDataResponse,
    type ConnectStartOAuthFlowResponse as ConnectStartOAuthFlowResponse,
    type ConnectCompleteOAuthCallbackParams as ConnectCompleteOAuthCallbackParams,
    type ConnectCreateBlueskyConnectionParams as ConnectCreateBlueskyConnectionParams,
    type ConnectFetchPendingDataParams as ConnectFetchPendingDataParams,
    type ConnectStartOAuthFlowParams as ConnectStartOAuthFlowParams,
  };

  export {
    Telegram as Telegram,
    type TelegramConnectDirectlyResponse as TelegramConnectDirectlyResponse,
    type TelegramInitiateConnectionResponse as TelegramInitiateConnectionResponse,
    type TelegramPollConnectionStatusResponse as TelegramPollConnectionStatusResponse,
    type TelegramConnectDirectlyParams as TelegramConnectDirectlyParams,
    type TelegramPollConnectionStatusParams as TelegramPollConnectionStatusParams,
  };

  export {
    Whatsapp as Whatsapp,
    type WhatsappCompleteEmbeddedSignupResponse as WhatsappCompleteEmbeddedSignupResponse,
    type WhatsappConnectViaCredentialsResponse as WhatsappConnectViaCredentialsResponse,
    type WhatsappGetSDKConfigResponse as WhatsappGetSDKConfigResponse,
    type WhatsappCompleteEmbeddedSignupParams as WhatsappCompleteEmbeddedSignupParams,
    type WhatsappConnectViaCredentialsParams as WhatsappConnectViaCredentialsParams,
  };

  export { Facebook as Facebook };

  export { Linkedin as Linkedin };

  export { Pinterest as Pinterest };

  export { Googlebusiness as Googlebusiness };

  export { Snapchat as Snapchat };
}
