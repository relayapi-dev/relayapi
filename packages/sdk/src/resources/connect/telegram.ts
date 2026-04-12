// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Telegram extends APIResource {
  /**
   * Connect Telegram directly with chat ID
   */
  connectDirectly(
    body: TelegramConnectDirectlyParams,
    options?: RequestOptions,
  ): APIPromise<TelegramConnectDirectlyResponse> {
    return this._client.post('/v1/connect/telegram/direct', { body, ...options });
  }

  /**
   * Generates a 6-character access code (valid 15 minutes).
   */
  initiateConnection(options?: RequestOptions): APIPromise<TelegramInitiateConnectionResponse> {
    return this._client.post('/v1/connect/telegram', options);
  }

  /**
   * Poll Telegram connection status
   */
  pollConnectionStatus(
    query: TelegramPollConnectionStatusParams,
    options?: RequestOptions,
  ): APIPromise<TelegramPollConnectionStatusResponse> {
    return this._client.get('/v1/connect/telegram', { query, ...options });
  }
}

export interface TelegramConnectDirectlyResponse {
  account: TelegramConnectDirectlyResponse.Account;
}

export namespace TelegramConnectDirectlyResponse {
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

export interface TelegramInitiateConnectionResponse {
  /**
   * Telegram bot username to message
   */
  bot_username: string;

  /**
   * 6-character access code
   */
  code: string;

  /**
   * ISO 8601 expiry timestamp
   */
  expires_at: string;

  /**
   * Seconds until code expires
   */
  expires_in: number;

  /**
   * Step-by-step instructions for the user
   */
  instructions: Array<string>;
}

export interface TelegramPollConnectionStatusResponse {
  /**
   * Current connection status
   */
  status: 'pending' | 'connected' | 'expired';

  /**
   * Connected account details
   */
  account?: TelegramPollConnectionStatusResponse.Account;

  /**
   * Telegram chat ID once connected
   */
  chat_id?: string;

  /**
   * Chat or channel title
   */
  chat_title?: string;

  /**
   * Chat type (private, group, supergroup, channel)
   */
  chat_type?: string;

  /**
   * Code expiry timestamp
   */
  expires_at?: string;
}

export namespace TelegramPollConnectionStatusResponse {
  /**
   * Connected account details
   */
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

export interface TelegramConnectDirectlyParams {
  /**
   * Telegram chat or channel ID
   */
  chat_id: string;
}

export interface TelegramPollConnectionStatusParams {
  /**
   * The 6-character access code to check
   */
  code: string;
}

export declare namespace Telegram {
  export {
    type TelegramConnectDirectlyResponse as TelegramConnectDirectlyResponse,
    type TelegramInitiateConnectionResponse as TelegramInitiateConnectionResponse,
    type TelegramPollConnectionStatusResponse as TelegramPollConnectionStatusResponse,
    type TelegramConnectDirectlyParams as TelegramConnectDirectlyParams,
    type TelegramPollConnectionStatusParams as TelegramPollConnectionStatusParams,
  };
}
