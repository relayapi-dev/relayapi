// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as ConversationsAPI from './conversations';
import {
  ConversationGetResponse,
  ConversationListParams,
  ConversationListResponse,
  ConversationUpdateParams,
  ConversationUpdateResponse,
  Conversations,
  InboxNote,
  MessageActionResponse,
  MessageAddReactionParams,
  MessageDeleteParams,
  MessageRemoveReactionParams,
  MessageSendParams,
  MessageSendResponse,
  MessageSendTypingParams,
  NoteCreateParams,
  NoteDeleteResponse,
  NoteListResponse,
  NoteResponse,
  NoteUpdateParams,
} from './conversations';
import * as CommentsAPI from './comments/comments';
import {
  CommentDeleteResponse,
  CommentListParams,
  CommentListResponse,
  CommentPrivateReplyParams,
  CommentPrivateReplyResponse,
  CommentReplyParams,
  CommentReplyResponse,
  CommentRetrieveParams,
  CommentRetrieveResponse,
  Comments,
} from './comments/comments';
import * as ReviewsAPI from './reviews/reviews';
import { ReviewListParams, ReviewListResponse, Reviews } from './reviews/reviews';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Inbox extends APIResource {
  comments: CommentsAPI.Comments = new CommentsAPI.Comments(this._client);
  conversations: ConversationsAPI.Conversations = new ConversationsAPI.Conversations(this._client);
  reviews: ReviewsAPI.Reviews = new ReviewsAPI.Reviews(this._client);

  /** Classify up to 50 inbox messages with Workers AI. */
  classify(body: InboxClassifyParams, options?: RequestOptions): APIPromise<InboxClassifyResponse> {
    return this._client.post('/v1/inbox/classify', { body, ...options });
  }

  /** Generate candidate replies for a persisted conversation. */
  suggestReply(
    body: InboxSuggestReplyParams,
    options?: RequestOptions,
  ): APIPromise<InboxSuggestReplyResponse> {
    return this._client.post('/v1/inbox/suggest-reply', { body, ...options });
  }

  /** Summarize a persisted conversation. */
  summarize(body: InboxSummarizeParams, options?: RequestOptions): APIPromise<InboxSummarizeResponse> {
    return this._client.post('/v1/inbox/summarize', { body, ...options });
  }

  /** List conversations ordered by their calculated priority score. */
  priorities(
    query: InboxPrioritiesParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<InboxPrioritiesResponse> {
    return this._client.get('/v1/inbox/priorities', { query, ...options });
  }

  /** Search across persisted inbox messages. */
  search(
    query: InboxSearchParams,
    options?: RequestOptions,
  ): APIPromise<InboxSearchResponse> {
    return this._client.get('/v1/inbox/search', { query, ...options });
  }

  /** Retrieve aggregate inbox metrics. */
  stats(
    query: InboxStatsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<InboxStatsResponse> {
    return this._client.get('/v1/inbox/stats', { query, ...options });
  }
}

export type InboxPlatform =
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
  | 'sms'
  | 'beehiiv'
  | 'convertkit'
  | 'mailchimp'
  | 'listmonk';

export type InboxConversationType = 'comment_thread' | 'dm' | 'review';
export type InboxConversationStatus = 'open' | 'archived' | 'snoozed';

export interface InboxClassifyParams {
  messages: Array<{ id?: string; text: string }>;
}

export type InboxClassifyResponse = Array<{
  id?: string;
  sentiment: { score: number; label: 'positive' | 'neutral' | 'negative' };
  intent: 'question' | 'complaint' | 'compliment' | 'spam' | 'feedback' | 'general';
  urgency: 'high' | 'medium' | 'low';
  requires_response: boolean;
}>;

export interface InboxSuggestReplyParams {
  conversation_id: string;
  tone?: string;
  max_suggestions?: number;
  context?: string;
}

export interface InboxSuggestReplyResponse {
  suggestions: Array<{ text: string; tone: string; confidence: number }>;
}

export interface InboxSummarizeParams {
  conversation_id: string;
}

export interface InboxSummarizeResponse {
  summary: string;
  key_topics: string[];
  action_needed: string;
  message_count: number;
  timespan: string;
}

export interface InboxFeedConversation {
  id: string;
  platform: InboxPlatform;
  type: InboxConversationType;
  account_id: string;
  participant_name: string | null;
  participant_avatar: string | null;
  participant_metadata?: unknown;
  status: InboxConversationStatus;
  assigned_user_id: string | null;
  priority: string | null;
  labels: string[];
  unread_count: number;
  message_count: number;
  last_message_text: string | null;
  last_message_at: string | null;
  last_message_direction: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxPrioritiesParams {
  type?: InboxConversationType;
  platform?: InboxPlatform;
  account_id?: string;
  status?: InboxConversationStatus;
  labels?: string;
  cursor?: string;
  limit?: number;
}

export interface InboxPrioritiesResponse {
  data: Array<InboxFeedConversation & { priority_score: number }>;
  next_cursor: string | null;
  has_more: boolean;
}

export interface InboxSearchParams {
  q: string;
  platform?: InboxPlatform;
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
}

export interface InboxSearchResponse {
  data: Array<{
    id: string;
    conversation_id: string;
    author_name: string | null;
    author_avatar_url: string | null;
    text: string | null;
    direction: string;
    attachments: unknown;
    created_at: string;
  }>;
  next_cursor: string | null;
  has_more: boolean;
}

export interface InboxStatsParams {
  platform?: InboxPlatform;
  account_id?: string;
}

export interface InboxStatsResponse {
  total_conversations: number;
  open_conversations: number;
  unread_messages: number;
  by_platform: Record<string, { conversations: number; unread: number }>;
}

Inbox.Comments = Comments;
Inbox.Conversations = Conversations;
Inbox.Reviews = Reviews;

export declare namespace Inbox {
  export {
    Comments as Comments,
    type CommentRetrieveResponse as CommentRetrieveResponse,
    type CommentListResponse as CommentListResponse,
    type CommentDeleteResponse as CommentDeleteResponse,
    type CommentPrivateReplyResponse as CommentPrivateReplyResponse,
    type CommentReplyResponse as CommentReplyResponse,
    type CommentRetrieveParams as CommentRetrieveParams,
    type CommentListParams as CommentListParams,
    type CommentPrivateReplyParams as CommentPrivateReplyParams,
    type CommentReplyParams as CommentReplyParams,
  };

  export {
    Conversations as Conversations,
    type ConversationGetResponse as ConversationGetResponse,
    type ConversationListResponse as ConversationListResponse,
    type ConversationUpdateResponse as ConversationUpdateResponse,
    type MessageSendResponse as MessageSendResponse,
    type MessageActionResponse as MessageActionResponse,
    type InboxNote as InboxNote,
    type NoteListResponse as NoteListResponse,
    type NoteResponse as NoteResponse,
    type NoteDeleteResponse as NoteDeleteResponse,
    type ConversationListParams as ConversationListParams,
    type ConversationUpdateParams as ConversationUpdateParams,
    type MessageSendParams as MessageSendParams,
    type MessageSendTypingParams as MessageSendTypingParams,
    type MessageAddReactionParams as MessageAddReactionParams,
    type MessageRemoveReactionParams as MessageRemoveReactionParams,
    type MessageDeleteParams as MessageDeleteParams,
    type NoteCreateParams as NoteCreateParams,
    type NoteUpdateParams as NoteUpdateParams,
  };

  export {
    Reviews as Reviews,
    type ReviewListResponse as ReviewListResponse,
    type ReviewListParams as ReviewListParams,
  };

  export {
    type InboxPlatform as InboxPlatform,
    type InboxConversationType as InboxConversationType,
    type InboxConversationStatus as InboxConversationStatus,
    type InboxClassifyParams as InboxClassifyParams,
    type InboxClassifyResponse as InboxClassifyResponse,
    type InboxSuggestReplyParams as InboxSuggestReplyParams,
    type InboxSuggestReplyResponse as InboxSuggestReplyResponse,
    type InboxSummarizeParams as InboxSummarizeParams,
    type InboxSummarizeResponse as InboxSummarizeResponse,
    type InboxFeedConversation as InboxFeedConversation,
    type InboxPrioritiesParams as InboxPrioritiesParams,
    type InboxPrioritiesResponse as InboxPrioritiesResponse,
    type InboxSearchParams as InboxSearchParams,
    type InboxSearchResponse as InboxSearchResponse,
    type InboxStatsParams as InboxStatsParams,
    type InboxStatsResponse as InboxStatsResponse,
  };
}
