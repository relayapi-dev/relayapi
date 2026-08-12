// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from "../../core/resource";
import * as ConversationsAPI from "./conversations";
import {
  ConversationGetResponse,
  ConversationListParams,
  ConversationListResponse,
  ConversationUpdateParams,
  ConversationUpdateResponse,
  Conversations,
  InboxMessagePlatformData,
  InboxNote,
  InboxSocialMutationOperation,
  MessageActionResponse,
  MessageAddReactionParams,
  MessageDeleteParams,
  MessageEditParams,
  MessageReadReceiptParams,
  MessageRemoveReactionParams,
  MessageSendParams,
  MessageSendResponse,
  MessageSendTypingParams,
  NoteCreateParams,
  NoteDeleteResponse,
  NoteListResponse,
  NoteResponse,
  NoteUpdateParams,
} from "./conversations";
import * as CommentsAPI from "./comments/comments";
import {
  CommentDeleteResponse,
  CommentEditParams,
  CommentListParams,
  CommentListResponse,
  CommentPrivateReplyParams,
  CommentPrivateReplyResponse,
  CommentModerateParams,
  CommentReplyParams,
  CommentReplyResponse,
  CommentRetrieveParams,
  CommentRetrieveResponse,
  Comments,
} from "./comments/comments";
import * as ReviewsAPI from "./reviews/reviews";
import {
  ReviewListParams,
  ReviewListResponse,
  Reviews,
} from "./reviews/reviews";
import { APIPromise } from "../../core/api-promise";
import { buildHeaders } from "../../internal/headers";
import { RequestOptions } from "../../internal/request-options";
import { path } from "../../internal/utils/path";

export class Inbox extends APIResource {
  comments: CommentsAPI.Comments = new CommentsAPI.Comments(this._client);
  conversations: ConversationsAPI.Conversations =
    new ConversationsAPI.Conversations(this._client);
  reviews: ReviewsAPI.Reviews = new ReviewsAPI.Reviews(this._client);

  /** Classify up to 50 inbox messages with Workers AI. */
  classify(
    body: InboxClassifyParams,
    options?: RequestOptions,
  ): APIPromise<InboxClassifyResponse> {
    return this._client.post("/v1/inbox/classify", { body, ...options });
  }

  /** Generate candidate replies for a persisted conversation. */
  suggestReply(
    body: InboxSuggestReplyParams,
    options?: RequestOptions,
  ): APIPromise<InboxSuggestReplyResponse> {
    return this._client.post("/v1/inbox/suggest-reply", { body, ...options });
  }

  /** Summarize a persisted conversation. */
  summarize(
    body: InboxSummarizeParams,
    options?: RequestOptions,
  ): APIPromise<InboxSummarizeResponse> {
    return this._client.post("/v1/inbox/summarize", { body, ...options });
  }

  /** List conversations ordered by their calculated priority score. */
  priorities(
    query: InboxPrioritiesParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<InboxPrioritiesResponse> {
    return this._client.get("/v1/inbox/priorities", { query, ...options });
  }

  /** Search across persisted inbox messages. */
  search(
    query: InboxSearchParams,
    options?: RequestOptions,
  ): APIPromise<InboxSearchResponse> {
    return this._client.get("/v1/inbox/search", { query, ...options });
  }

  /** Retrieve aggregate inbox metrics. */
  stats(
    query: InboxStatsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<InboxStatsResponse> {
    return this._client.get("/v1/inbox/stats", { query, ...options });
  }

  /** Set a provider-native reaction, vote, or rating on a post. */
  engagePost(
    providerPostID: string,
    params: InboxEngagePostParams,
    options?: RequestOptions,
  ): APIPromise<InboxSocialMutationOperation> {
    const { idempotency_key, ...body } = params;
    return this._client.put(
      path`/v1/inbox/posts/${providerPostID}/engagement`,
      {
        body,
        ...options,
        headers: buildHeaders([
          { "Idempotency-Key": idempotency_key },
          options?.headers,
        ]),
      },
    );
  }

  /** List normalized story and post mentions for one exact account. */
  listMentions(
    query: InboxMentionListParams,
    options?: RequestOptions,
  ): APIPromise<InboxMentionListResponse> {
    return this._client.get("/v1/inbox/mentions", { query, ...options });
  }

  /** Retrieve a durable message, comment, read-receipt, or engagement mutation. */
  getSocialMutation(
    operationID: string,
    query: InboxSocialMutationGetParams,
    options?: RequestOptions,
  ): APIPromise<InboxSocialMutationOperation> {
    return this._client.get(path`/v1/inbox/operations/${operationID}`, {
      query,
      ...options,
    });
  }
}

export type InboxPlatform =
  | "twitter"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "tiktok"
  | "youtube"
  | "pinterest"
  | "reddit"
  | "bluesky"
  | "threads"
  | "telegram"
  | "snapchat"
  | "googlebusiness"
  | "whatsapp"
  | "mastodon"
  | "discord"
  | "sms"
  | "beehiiv"
  | "convertkit"
  | "mailchimp"
  | "listmonk"
  | "slack";

export type InboxConversationType = "comment_thread" | "dm" | "review";
export type InboxConversationStatus = "open" | "archived" | "snoozed";
export type InboxDirection = "inbound" | "outbound";

export interface InboxClassifyParams {
  messages: Array<{ id?: string; text: string }>;
}

export type InboxClassifyResponse = Array<{
  id?: string;
  sentiment: { score: number; label: "positive" | "neutral" | "negative" };
  intent:
    | "question"
    | "complaint"
    | "compliment"
    | "spam"
    | "feedback"
    | "general";
  urgency: "high" | "medium" | "low";
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
  last_message_direction: InboxDirection | null;
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
    direction: InboxDirection;
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

export interface InboxEngagePostParams {
  idempotency_key: string;
  account_id: string;
  action:
    | "like"
    | "unlike"
    | "upvote"
    | "downvote"
    | "clear_vote"
    | "dislike"
    | "clear_rating";
}

export interface InboxMentionListParams {
  account_id: string;
  cursor?: string;
  limit?: number;
}

export interface InboxMention {
  id: string;
  conversation_id: string;
  account_id: string;
  platform: InboxPlatform;
  provider_message_id: string;
  author_name: string | null;
  author_platform_id: string | null;
  text: string | null;
  type: "story_mention" | "post_mention";
  created_at: string;
}

export interface InboxMentionListResponse {
  data: InboxMention[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface InboxSocialMutationGetParams {
  account_id: string;
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
    type CommentEditParams as CommentEditParams,
    type CommentModerateParams as CommentModerateParams,
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
    type InboxSocialMutationOperation as InboxSocialMutationOperation,
    type InboxMessagePlatformData as InboxMessagePlatformData,
    type InboxNote as InboxNote,
    type NoteListResponse as NoteListResponse,
    type NoteResponse as NoteResponse,
    type NoteDeleteResponse as NoteDeleteResponse,
    type ConversationListParams as ConversationListParams,
    type ConversationUpdateParams as ConversationUpdateParams,
    type MessageSendParams as MessageSendParams,
    type MessageEditParams as MessageEditParams,
    type MessageReadReceiptParams as MessageReadReceiptParams,
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
    type InboxDirection as InboxDirection,
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
    type InboxEngagePostParams as InboxEngagePostParams,
    type InboxMentionListParams as InboxMentionListParams,
    type InboxMention as InboxMention,
    type InboxMentionListResponse as InboxMentionListResponse,
    type InboxSocialMutationGetParams as InboxSocialMutationGetParams,
  };
}
