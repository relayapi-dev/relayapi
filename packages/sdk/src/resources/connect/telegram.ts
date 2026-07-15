// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Telegram extends APIResource {
  /**
   * Generates an organization- and workspace-bound bot challenge code (valid 15
   * minutes).
   */
  initiateConnection(
    query: TelegramInitiateConnectionParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<TelegramInitiateConnectionResponse> {
    return this._client.post('/v1/connect/telegram', { query, ...options });
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

export interface TelegramInitiateConnectionResponse {
  /**
   * Telegram bot username to message
   */
  bot_username: string;

  /**
   * Organization-bound challenge code in the form RLAY-XXXXXXXXXXXX (12 uppercase
   * hexadecimal characters)
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

export interface TelegramPollConnectionStatusParams {
  /**
   * Organization-bound challenge code to check (RLAY- followed by 12 uppercase
   * hexadecimal characters)
   */
  code: string;
}

export interface TelegramInitiateConnectionParams {
  /**
   * Workspace for the connected account. Required only when Require Workspace ID
   * is enabled.
   */
  workspace_id?: string;
}

export declare namespace Telegram {
  export {
    type TelegramInitiateConnectionResponse as TelegramInitiateConnectionResponse,
    type TelegramInitiateConnectionParams as TelegramInitiateConnectionParams,
    type TelegramPollConnectionStatusResponse as TelegramPollConnectionStatusResponse,
    type TelegramPollConnectionStatusParams as TelegramPollConnectionStatusParams,
  };
}
