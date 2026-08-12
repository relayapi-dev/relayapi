import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class SubscriptionListMembers extends APIResource {
  /**
   * List current and/or unsubscribed members. Membership does not imply consent.
   */
  list(
    listID: string,
    query: SubscriptionListMemberListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SubscriptionListMemberListResponse> {
    return this._client.get(path`/v1/subscription-lists/${listID}/members`, {
      query,
      ...options,
    });
  }

  /**
   * Add or re-add a member without granting channel or purpose consent.
   */
  add(
    listID: string,
    body: SubscriptionListMemberAddParams,
    options?: RequestOptions,
  ): APIPromise<SubscriptionListMember> {
    return this._client.post(path`/v1/subscription-lists/${listID}/members`, {
      body,
      ...options,
    });
  }

  /**
   * Mark a member unsubscribed while preserving transition history.
   */
  unsubscribe(listID: string, contactID: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/subscription-lists/${listID}/members/${contactID}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export class SubscriptionLists extends APIResource {
  members: SubscriptionListMembers = new SubscriptionListMembers(this._client);

  create(
    body: SubscriptionListCreateParams,
    options?: RequestOptions,
  ): APIPromise<SubscriptionList> {
    return this._client.post('/v1/subscription-lists', { body, ...options });
  }

  list(
    query: SubscriptionListListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SubscriptionListListResponse> {
    return this._client.get('/v1/subscription-lists', { query, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<SubscriptionList> {
    return this._client.get(path`/v1/subscription-lists/${id}`, options);
  }

  update(
    id: string,
    body: SubscriptionListUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<SubscriptionList> {
    return this._client.patch(path`/v1/subscription-lists/${id}`, { body, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/subscription-lists/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export type SubscriptionListChannel = 'instagram' | 'facebook' | 'whatsapp' | 'telegram' | 'tiktok';

export interface SubscriptionList {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  name: string;
  channel: SubscriptionListChannel;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionListCreateParams {
  name: string;
  channel: SubscriptionListChannel;
  description?: string;
  workspace_id?: string;
}

export interface SubscriptionListUpdateParams {
  name?: string;
  description?: string | null;
}

export interface SubscriptionListListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
  channel?: SubscriptionListChannel;
}

export interface SubscriptionListListResponse {
  data: SubscriptionList[];
  next_cursor: string | null;
  has_more: boolean;
}

export type SubscriptionListMemberStatus = 'active' | 'unsubscribed';
export type SubscriptionListMemberSource = 'automation' | 'manual' | 'import' | 'api';

export interface SubscriptionListMember {
  list_id: string;
  channel: SubscriptionListChannel;
  contact_id: string;
  contact: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  status: SubscriptionListMemberStatus;
  source: SubscriptionListMemberSource;
  subscribed_at: string;
  unsubscribed_at: string | null;
  updated_at: string;
}

export interface SubscriptionListMemberAddParams {
  contact_id: string;
}

export interface SubscriptionListMemberListParams {
  cursor?: string;
  limit?: number;
  status?: SubscriptionListMemberStatus | 'all';
}

export interface SubscriptionListMemberListResponse {
  data: SubscriptionListMember[];
  next_cursor: string | null;
  has_more: boolean;
}
