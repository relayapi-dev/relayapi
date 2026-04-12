// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as BookmarkAPI from './bookmark';
import {
  Bookmark,
  BookmarkCreateParams,
  BookmarkCreateResponse,
  BookmarkRemoveParams,
  BookmarkRemoveResponse,
} from './bookmark';
import * as FollowAPI from './follow';
import {
  Follow,
  FollowCreateParams,
  FollowCreateResponse,
  FollowUnfollowParams,
  FollowUnfollowResponse,
} from './follow';
import * as RetweetAPI from './retweet';
import {
  Retweet,
  RetweetCreateParams,
  RetweetCreateResponse,
  RetweetUndoParams,
  RetweetUndoResponse,
} from './retweet';

export class Twitter extends APIResource {
  retweet: RetweetAPI.Retweet = new RetweetAPI.Retweet(this._client);
  bookmark: BookmarkAPI.Bookmark = new BookmarkAPI.Bookmark(this._client);
  follow: FollowAPI.Follow = new FollowAPI.Follow(this._client);
}

Twitter.Retweet = Retweet;
Twitter.Bookmark = Bookmark;
Twitter.Follow = Follow;

export declare namespace Twitter {
  export {
    Retweet as Retweet,
    type RetweetCreateResponse as RetweetCreateResponse,
    type RetweetUndoResponse as RetweetUndoResponse,
    type RetweetCreateParams as RetweetCreateParams,
    type RetweetUndoParams as RetweetUndoParams,
  };

  export {
    Bookmark as Bookmark,
    type BookmarkCreateResponse as BookmarkCreateResponse,
    type BookmarkRemoveResponse as BookmarkRemoveResponse,
    type BookmarkCreateParams as BookmarkCreateParams,
    type BookmarkRemoveParams as BookmarkRemoveParams,
  };

  export {
    Follow as Follow,
    type FollowCreateResponse as FollowCreateResponse,
    type FollowUnfollowResponse as FollowUnfollowResponse,
    type FollowCreateParams as FollowCreateParams,
    type FollowUnfollowParams as FollowUnfollowParams,
  };
}
