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
  NoteDeleteParams,
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

export class Inbox extends APIResource {
  comments: CommentsAPI.Comments = new CommentsAPI.Comments(this._client);
  conversations: ConversationsAPI.Conversations = new ConversationsAPI.Conversations(this._client);
  reviews: ReviewsAPI.Reviews = new ReviewsAPI.Reviews(this._client);
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
    type NoteDeleteParams as NoteDeleteParams,
  };

  export {
    Reviews as Reviews,
    type ReviewListResponse as ReviewListResponse,
    type ReviewListParams as ReviewListParams,
  };
}
