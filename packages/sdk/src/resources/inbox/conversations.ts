// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Conversations extends APIResource {
  /**
   * Get a conversation with its messages
   */
  get(conversationID: string, options?: RequestOptions): APIPromise<ConversationGetResponse> {
    return this._client.get(path`/v1/inbox/conversations/${conversationID}`, options);
  }

  /**
   * List conversations
   */
  list(
    query: ConversationListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ConversationListResponse> {
    return this._client.get('/v1/inbox/conversations', { query, ...options });
  }

  /**
   * Update a conversation (status, labels, priority, assignee)
   */
  update(
    conversationID: string,
    body: ConversationUpdateParams,
    options?: RequestOptions,
  ): APIPromise<ConversationUpdateResponse> {
    return this._client.patch(path`/v1/inbox/conversations/${conversationID}`, { body, ...options });
  }

  /**
   * Mark one or more conversations as read
   */
  markRead(
    body: ConversationMarkReadParams,
    options?: RequestOptions,
  ): APIPromise<ConversationMarkReadResponse> {
    return this._client.post('/v1/inbox/bulk', {
      body: { action: 'mark_read', targets: body.targets },
      ...options,
    });
  }

  /**
   * Send a message in a conversation
   */
  sendMessage(
    conversationID: string,
    body: MessageSendParams,
    options?: RequestOptions,
  ): APIPromise<MessageSendResponse> {
    return this._client.post(path`/v1/inbox/conversations/${conversationID}/messages`, { body, ...options });
  }

  /**
   * Send a typing indicator in a conversation. Best-effort — always returns success.
   */
  sendTyping(
    conversationID: string,
    body: MessageSendTypingParams,
    options?: RequestOptions,
  ): APIPromise<MessageActionResponse> {
    return this._client.post(path`/v1/inbox/conversations/${conversationID}/typing`, { body, ...options });
  }

  /**
   * Add a reaction to a message
   */
  addReaction(
    messageID: string,
    params: MessageAddReactionParams,
    options?: RequestOptions,
  ): APIPromise<MessageActionResponse> {
    const { conversation_id, ...body } = params;
    return this._client.post(
      path`/v1/inbox/conversations/${conversation_id}/messages/${messageID}/reactions`,
      {
        body,
        ...options,
      },
    );
  }

  /**
   * Remove a reaction from a message
   */
  removeReaction(
    messageID: string,
    params: MessageRemoveReactionParams,
    options?: RequestOptions,
  ): APIPromise<MessageActionResponse> {
    const { conversation_id, ...query } = params;
    return this._client.delete(
      path`/v1/inbox/conversations/${conversation_id}/messages/${messageID}/reactions`,
      { query, ...options },
    );
  }

  /**
   * Delete a message
   */
  deleteMessage(
    messageID: string,
    params: MessageDeleteParams,
    options?: RequestOptions,
  ): APIPromise<MessageActionResponse> {
    const { conversation_id, ...query } = params;
    return this._client.delete(
      path`/v1/inbox/conversations/${conversation_id}/messages/${messageID}`,
      {
        query,
        ...options,
      },
    );
  }
}

export interface ConversationGetResponse {
  conversation: ConversationGetResponse.Conversation;

  messages: Array<ConversationGetResponse.Message>;
}

export namespace ConversationGetResponse {
  export interface Conversation {
    /**
     * Conversation ID
     */
    id: string;

    /**
     * Account ID
     */
    account_id: string;

    /**
     * Participant display name
     */
    participant_name: string | null;

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
     * Conversation status
     */
    status: 'open' | 'archived' | 'snoozed';

    /**
     * Assigned organization user ID
     */
    assigned_user_id: string | null;

    /**
     * Last updated timestamp
     */
    updated_at: string;

    /**
     * Last message text
     */
    last_message_text?: string | null;

    /**
     * Participant avatar URL
     */
    participant_avatar?: string | null;

    /**
     * Unread message count
     */
    unread_count?: number;

    /**
     * Conversation labels
     */
    labels?: string[];

    /**
     * Conversation priority
     */
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }

  export interface Message {
    /**
     * Message ID
     */
    id: string;

    /**
     * Conversation ID
     */
    conversation_id: string;

    /**
     * Platform message ID
     */
    platform_message_id: string;

    /**
     * Author name
     */
    author_name: string | null;

    /**
     * Message text
     */
    text: string | null;

    /**
     * Message direction (inbound or outbound)
     */
    direction: 'inbound' | 'outbound';

    /**
     * Message attachments
     */
    attachments?: unknown;

    /**
     * Message timestamp
     */
    created_at: string;
  }
}

export interface ConversationListResponse {
  data: Array<ConversationListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace ConversationListResponse {
  export interface Data {
    /**
     * Conversation ID
     */
    id: string;

    /**
     * Account ID
     */
    account_id: string;

    /**
     * Participant display name
     */
    participant_name: string | null;

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
     * Conversation status
     */
    status: 'open' | 'archived' | 'snoozed';

    /**
     * Assigned organization user ID
     */
    assigned_user_id: string | null;

    /**
     * Last updated timestamp
     */
    updated_at: string;

    /**
     * Last message text
     */
    last_message_text?: string | null;

    /**
     * Participant avatar URL
     */
    participant_avatar?: string | null;

    /**
     * Unread message count
     */
    unread_count?: number;
  }
}

export interface ConversationUpdateResponse {
  conversation: ConversationUpdateResponse.Conversation;
}

export namespace ConversationUpdateResponse {
  export interface Conversation {
    /**
     * Conversation ID
     */
    id: string;

    /**
     * Conversation status
     */
    status: 'open' | 'archived' | 'snoozed';

    /**
     * Assigned organization user ID
     */
    assigned_user_id: string | null;

    /**
     * Conversation labels
     */
    labels?: string[];

    /**
     * Conversation priority
     */
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }
}

export interface MessageSendResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Error message if failed
   */
  error?: string;

  /**
   * Message ID
   */
  message_id?: string;
}

/**
 * Generic action response for typing, reactions, and delete operations
 */
export interface MessageActionResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Error message if failed
   */
  error?: string;

  /**
   * Message ID
   */
  message_id?: string;
}

export interface ConversationMarkReadResponse {
  errors: string[];

  failed: number;

  processed: number;
}

export interface ConversationListParams {
  /**
   * Filter by account ID
   */
  account_id?: string;

  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items
   */
  limit?: number;

  /**
   * Filter by platform
   */
  platform?:
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
   * Filter by conversation status
   */
  status?: 'open' | 'archived' | 'snoozed';

  /**
   * Filter by conversation type
   */
  type?: string;

  /**
   * Filter by labels (comma-separated)
   */
  labels?: string;
}

export interface ConversationUpdateParams {
  /**
   * Conversation status
   */
  status?: 'open' | 'archived' | 'snoozed';

  /**
   * Conversation labels
   */
  labels?: string[];

  /**
   * Conversation priority
   */
  priority?: 'low' | 'normal' | 'high' | 'urgent';

  /**
   * Assigned organization user ID. Use null to clear the assignee.
   */
  assigned_user_id?: string | null;
}

export interface ConversationMarkReadParams {
  targets: string[];
}

export interface MessageSendParams {
  /**
   * Account ID to send from
   */
  account_id: string;

  /**
   * Message text (optional if template or attachments are provided)
   */
  text?: string;

  /**
   * Attachments
   */
  attachments?: Array<MessageSendParams.Attachment>;

  /**
   * Message tag for sending outside the 24h window (Facebook only)
   */
  message_tag?: 'HUMAN_AGENT' | 'CUSTOMER_FEEDBACK';

  /**
   * Message ID to reply to
   */
  reply_to?: string;

  /**
   * Quick reply buttons (Facebook/Instagram, max 13)
   */
  quick_replies?: Array<MessageSendParams.QuickReply>;

  /**
   * Structured template message (Facebook/Instagram)
   */
  template?: MessageSendParams.Template;
}

export namespace MessageSendParams {
  export interface Attachment {
    /**
     * Attachment MIME type
     */
    type: string;

    /**
     * Attachment URL
     */
    url: string;
  }

  export interface QuickReply {
    /**
     * Quick reply type
     */
    content_type?: 'text' | 'user_phone_number' | 'user_email';

    /**
     * Button label (required for text type)
     */
    title?: string;

    /**
     * Postback payload
     */
    payload?: string;

    /**
     * Icon URL for the button
     */
    image_url?: string;
  }

  export interface Template {
    /**
     * Template type
     */
    type: 'generic' | 'button';

    /**
     * Template elements (max 10 for carousel)
     */
    elements: Array<Template.Element>;
  }

  export namespace Template {
    export interface Element {
      /**
       * Element title
       */
      title: string;

      /**
       * Element subtitle
       */
      subtitle?: string;

      /**
       * Element image URL
       */
      image_url?: string;

      /**
       * Element buttons (max 3)
       */
      buttons?: Array<Element.Button>;
    }

    export namespace Element {
      export interface Button {
        /**
         * Button type
         */
        type: 'web_url' | 'postback';

        /**
         * Button label
         */
        title: string;

        /**
         * URL for web_url buttons
         */
        url?: string;

        /**
         * Payload for postback buttons
         */
        payload?: string;
      }
    }
  }
}

export interface MessageSendTypingParams {
  /**
   * Account ID to send from
   */
  account_id: string;
}

export interface MessageAddReactionParams {
  /**
   * Path param: Conversation ID
   */
  conversation_id: string;

  /**
   * Body param: Account ID to react from
   */
  account_id: string;

  /**
   * Body param: Unicode emoji character
   */
  emoji: string;
}

export interface MessageRemoveReactionParams {
  /**
   * Path param: Conversation ID
   */
  conversation_id: string;

  /**
   * Query param: Account ID that reacted
   */
  account_id: string;
}

export interface MessageDeleteParams {
  /**
   * Path param: Conversation ID
   */
  conversation_id: string;

  /**
   * Query param: Account ID that sent the message
   */
  account_id: string;
}

export declare namespace Conversations {
  export {
    type ConversationGetResponse as ConversationGetResponse,
    type ConversationListResponse as ConversationListResponse,
    type ConversationUpdateResponse as ConversationUpdateResponse,
    type ConversationMarkReadResponse as ConversationMarkReadResponse,
    type MessageSendResponse as MessageSendResponse,
    type MessageActionResponse as MessageActionResponse,
    type ConversationListParams as ConversationListParams,
    type ConversationUpdateParams as ConversationUpdateParams,
    type ConversationMarkReadParams as ConversationMarkReadParams,
    type MessageSendParams as MessageSendParams,
    type MessageSendTypingParams as MessageSendTypingParams,
    type MessageAddReactionParams as MessageAddReactionParams,
    type MessageRemoveReactionParams as MessageRemoveReactionParams,
    type MessageDeleteParams as MessageDeleteParams,
  };
}
