// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';
import { ContactAutomationControls } from './contact-automation-controls';

export class Contacts extends APIResource {
  automationControls: ContactAutomationControls = new ContactAutomationControls(this._client);

  /**
   * Create a contact
   */
  create(body: ContactCreateParams, options?: RequestOptions): APIPromise<ContactCreateResponse> {
    return this._client.post('/v1/contacts', { body, ...options });
  }

  /**
   * Get contact details
   */
  retrieve(contactId: string, options?: RequestOptions): APIPromise<ContactRetrieveResponse> {
    return this._client.get(path`/v1/contacts/${contactId}`, options);
  }

  /**
   * List contacts with filtering and pagination
   */
  list(
    query: ContactListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ContactListResponse> {
    return this._client.get('/v1/contacts', { query, ...options });
  }

  /**
   * Update a contact
   */
  update(
    contactId: string,
    body: ContactUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ContactUpdateResponse> {
    return this._client.patch(path`/v1/contacts/${contactId}`, { body, ...options });
  }

  /**
   * Delete a contact
   */
  delete(contactId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/contacts/${contactId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * List immutable channel/purpose consent evidence for a contact.
   */
  listConsents(
    contactId: string,
    query: ContactListConsentsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ContactListConsentsResponse> {
    return this._client.get(path`/v1/contacts/${contactId}/consents`, { query, ...options });
  }

  /**
   * Record consent or withdrawal evidence.
   */
  recordConsent(
    contactId: string,
    body: ContactRecordConsentParams,
    options?: RequestOptions,
  ): APIPromise<ContactConsent> {
    return this._client.post(path`/v1/contacts/${contactId}/consents`, { body, ...options });
  }

  /**
   * Bulk create up to 1000 contacts
   */
  bulkCreate(body: ContactBulkCreateParams, options?: RequestOptions): APIPromise<ContactBulkCreateResponse> {
    return this._client.post('/v1/contacts/bulk', { body, ...options });
  }

  /**
   * Bulk contact operations (add_tags, remove_tags, delete)
   */
  bulkOperations(
    body: ContactBulkOperationsParams,
    options?: RequestOptions,
  ): APIPromise<ContactBulkOperationsResponse> {
    return this._client.post('/v1/contacts/bulk-operations', { body, ...options });
  }

  /**
   * Merge another contact into this one
   */
  merge(
    contactId: string,
    body: ContactMergeParams,
    options?: RequestOptions,
  ): APIPromise<ContactMergeResponse> {
    return this._client.post(path`/v1/contacts/${contactId}/merge`, { body, ...options });
  }

  /**
   * List channels for a contact
   */
  listChannels(
    contactId: string,
    options?: RequestOptions,
  ): APIPromise<ContactListChannelsResponse> {
    return this._client.get(path`/v1/contacts/${contactId}/channels`, options);
  }

  /**
   * Add a channel to a contact
   */
  addChannel(
    contactId: string,
    body: ContactAddChannelParams,
    options?: RequestOptions,
  ): APIPromise<ContactAddChannelResponse> {
    return this._client.post(path`/v1/contacts/${contactId}/channels`, { body, ...options });
  }

  /**
   * Remove a channel from a contact
   */
  removeChannel(contactId: string, channelId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/contacts/${contactId}/channels/${channelId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * List static segment memberships for a contact
   */
  listSegments(
    contactId: string,
    options?: RequestOptions,
  ): APIPromise<ContactListSegmentsResponse> {
    return this._client.get(path`/v1/contacts/${contactId}/segments`, options);
  }

  /**
   * Add a contact to a static segment
   */
  addSegment(
    contactId: string,
    segmentId: string,
    options?: RequestOptions,
  ): APIPromise<ContactAddSegmentResponse> {
    return this._client.put(path`/v1/contacts/${contactId}/segments/${segmentId}`, { ...options });
  }

  /**
   * Remove a contact from a static segment
   */
  removeSegment(contactId: string, segmentId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/contacts/${contactId}/segments/${segmentId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Set a custom field value for a contact
   */
  setField(
    contactId: string,
    slug: string,
    body: ContactSetFieldParams,
    options?: RequestOptions,
  ): APIPromise<ContactSetFieldResponse> {
    return this._client.put(path`/v1/contacts/${contactId}/fields/${slug}`, { body, ...options });
  }

  /**
   * Clear a custom field value for a contact
   */
  clearField(contactId: string, slug: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/contacts/${contactId}/fields/${slug}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

// ---------------------------------------------------------------------------
// Response interfaces
// ---------------------------------------------------------------------------

export interface ContactChannel {
  /**
   * Channel ID
   */
  id: string;

  /**
   * Connected social account ID
   */
  social_account_id: string;

  /**
   * Platform name
   */
  platform: string;

  /**
   * Platform identifier (phone, username, ID)
   */
  identifier: string;

  /**
   * Created timestamp
   */
  created_at: string;
}

export interface ContactSegmentMembership {
  /**
   * Segment ID
   */
  segment_id: string;

  /**
   * Workspace ID
   */
  workspace_id: string | null;

  /**
   * Segment name
   */
  name: string;

  /**
   * Segment description
   */
  description: string | null;

  /**
   * Whether the segment is dynamically computed
   */
  is_dynamic: boolean;

  /**
   * Membership source
   */
  source: string;

  /**
   * Membership created timestamp
   */
  created_at: string;
}

export interface ContactConsent {
  /** Immutable consent event ID. */
  id: string;

  /** Contact ID; null after the operational contact is deleted. */
  contact_id: string | null;

  channel: string;

  purpose: string;

  status: 'granted' | 'denied';

  identifier_hash: string;

  identifier_masked: string | null;

  source: string;

  occurred_at: string;

  evidence: Record<string, unknown> | null;

  policy_version: string | null;

  jurisdiction: string | null;

  created_at: string;
}

export interface ContactListConsentsResponse {
  data: Array<ContactConsent>;

  next_cursor: string | null;

  has_more: boolean;
}

export interface ContactCreateResponse {
  /**
   * Contact ID
   */
  id: string;

  /** Workspace ID, or null for organization scope. */
  workspace_id: string | null;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Whether contact has opted in
   */
  opted_in: boolean;

  /**
   * Contact name
   */
  name?: string | null;

  /**
   * Email address
   */
  email?: string | null;

  /**
   * Primary phone number
   */
  phone?: string | null;

  /**
   * Tags
   */
  tags?: Array<string>;

  /**
   * Platform channels
   */
  channels?: Array<ContactChannel>;

  /**
   * Static segment memberships
   */
  segment_ids?: Array<string>;
}

export interface ContactRetrieveResponse {
  /**
   * Contact ID
   */
  id: string;

  /** Workspace ID, or null for organization scope. */
  workspace_id: string | null;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Whether contact has opted in
   */
  opted_in: boolean;

  /**
   * Contact name
   */
  name?: string | null;

  /**
   * Email address
   */
  email?: string | null;

  /**
   * Primary phone number
   */
  phone?: string | null;

  /**
   * Tags
   */
  tags?: Array<string>;

  /**
   * Platform channels
   */
  channels?: Array<ContactChannel>;

  /**
   * Static segment memberships
   */
  segment_ids?: Array<string>;
}

export interface ContactListResponse {
  data: Array<ContactListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace ContactListResponse {
  export interface Data {
    /**
     * Contact ID
     */
    id: string;

    /** Workspace ID, or null for organization scope. */
    workspace_id: string | null;

    /**
     * Created timestamp
     */
    created_at: string;

    /**
     * Whether contact has opted in
     */
    opted_in: boolean;

    /**
     * Contact name
     */
    name?: string | null;

    /**
     * Email address
     */
    email?: string | null;

    /**
     * Primary phone number
     */
    phone?: string | null;

    /**
     * Tags
     */
    tags?: Array<string>;

    /**
     * Platform channels
     */
    channels?: Array<ContactChannel>;

    /**
     * Static segment memberships
     */
    segment_ids?: Array<string>;
  }
}

export interface ContactUpdateResponse {
  /**
   * Contact ID
   */
  id: string;

  /** Workspace ID, or null for organization scope. */
  workspace_id: string | null;

  /**
   * Created timestamp
   */
  created_at: string;

  /**
   * Whether contact has opted in
   */
  opted_in: boolean;

  /**
   * Contact name
   */
  name?: string | null;

  /**
   * Email address
   */
  email?: string | null;

  /**
   * Primary phone number
   */
  phone?: string | null;

  /**
   * Tags
   */
  tags?: Array<string>;

  /**
   * Platform channels
   */
  channels?: Array<ContactChannel>;

  /**
   * Static segment memberships
   */
  segment_ids?: Array<string>;
}

export interface ContactBulkCreateResponse {
  /**
   * Successfully created count
   */
  created: number;

  /**
   * Skipped (duplicate) count
   */
  skipped: number;
}

export interface ContactBulkOperationsResponse {
  /**
   * Number of contacts affected
   */
  affected: number;
}

export interface ContactMergeResponse {
  /**
   * Number of channels moved
   */
  channels_moved: number;

  /**
   * Number of custom field values moved
   */
  fields_moved: number;

  /**
   * Number of broadcast recipients updated
   */
  recipients_updated: number;

  /**
   * Number of automation enrollments (runs) re-parented from the merged contact
   */
  enrollments_updated: number;

  /**
   * Number of inbox conversations updated
   */
  conversations_updated: number;
}

export interface ContactListChannelsResponse {
  data: Array<ContactChannel>;
}

export interface ContactAddChannelResponse {
  /**
   * Channel ID
   */
  id: string;

  /**
   * Connected social account ID
   */
  social_account_id: string;

  /**
   * Platform name
   */
  platform: string;

  /**
   * Platform identifier
   */
  identifier: string;

  /**
   * Created timestamp
   */
  created_at: string;
}

export interface ContactListSegmentsResponse {
  data: Array<ContactSegmentMembership>;
}

export interface ContactAddSegmentResponse {
  /**
   * Segment ID
   */
  segment_id: string;

  /**
   * Workspace ID
   */
  workspace_id: string | null;

  /**
   * Segment name
   */
  name: string;

  /**
   * Segment description
   */
  description: string | null;

  /**
   * Whether the segment is dynamically computed
   */
  is_dynamic: boolean;

  /**
   * Membership source
   */
  source: string;

  /**
   * Membership created timestamp
   */
  created_at: string;
}

export interface ContactSetFieldResponse {
  success: boolean;

  field: string;

  value: string;
}

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface ContactCreateParams {
  /**
   * Workspace ID. An initial channel supplies its account workspace in either
   * policy mode; without that parent, strict mode requires an explicit value.
   */
  workspace_id?: string;

  /**
   * Contact name
   */
  name?: string;

  /**
   * Email address
   */
  email?: string;

  /**
   * Primary phone number
   */
  phone?: string;

  /**
   * Tags
   */
  tags?: Array<string>;

  /**
   * Marketing preference. An explicit value is recorded for every known channel.
   */
  opted_in?: boolean;

  /**
   * Freeform metadata
   */
  metadata?: Record<string, unknown>;

  /**
   * Social account ID for initial channel
   */
  account_id?: string;

  /**
   * Platform for initial channel
   */
  platform?: string;

  /**
   * Platform identifier for initial channel
   */
  identifier?: string;
}

export interface ContactListParams {
  /**
   * Filter by workspace ID
   */
  workspace_id?: string;

  /**
   * Search by name, phone, or email
   */
  search?: string;

  /**
   * Filter by tag
   */
  tag?: string;

  /**
   * Filter by static segment membership
   */
  segment_id?: string;

  /**
   * Filter by platform
   */
  platform?: string;

  /**
   * Filter by social account ID
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
}

export interface ContactListConsentsParams {
  /** Pagination cursor. */
  cursor?: string;

  /** Number of consent events. */
  limit?: number;
}

export interface ContactUpdateParams {
  /**
   * Contact name
   */
  name?: string;

  /**
   * Email address
   */
  email?: string;

  /**
   * Primary phone number
   */
  phone?: string;

  /**
   * Tags (replaces existing)
   */
  tags?: Array<string>;

  /**
   * Marketing preference. An explicit value updates every known contact channel.
   */
  opted_in?: boolean;

  /**
   * Freeform metadata
   */
  metadata?: Record<string, unknown>;
}

export interface ContactRecordConsentParams {
  channel: string;

  purpose: string;

  status: 'granted' | 'denied';

  /** Recipient identifier; inferred from the contact when unambiguous. */
  identifier?: string;

  /** Evidence source, for example form, provider, import, or api. */
  source: string;

  /** Actual time the consent decision occurred; at most five minutes in the future. */
  occurred_at: string;

  evidence?: Record<string, unknown>;

  policy_version?: string;

  jurisdiction?: string;
}

export interface ContactBulkCreateParams {
  /**
   * Workspace ID. Channel accounts supply their shared workspace in either
   * policy mode; without those parents, strict mode requires an explicit value.
   */
  workspace_id?: string;

  /**
   * Contacts to create
   */
  contacts: Array<ContactBulkCreateParams.Contact>;
}

export namespace ContactBulkCreateParams {
  export interface Contact {
    name?: string;

    email?: string;

    phone?: string;

    tags?: Array<string>;

    account_id?: string;

    platform?: string;

    identifier?: string;
  }
}

export interface ContactBulkOperationsParams {
  /**
   * Contact IDs
   */
  contact_ids: Array<string>;

  /**
   * Action
   */
  action: 'add_tags' | 'remove_tags' | 'delete';

  /**
   * Tags (for tag actions)
   */
  tags?: Array<string>;
}

export interface ContactMergeParams {
  /**
   * ID of the contact to merge into this one (will be deleted). Must be
   * different from the target contact id; merging a contact into itself returns
   * a 400 validation error.
   */
  merge_contact_id: string;
}

export interface ContactAddChannelParams {
  /**
   * Social account ID
   */
  account_id: string;

  /**
   * Platform name
   */
  platform: string;

  /**
   * Platform identifier
   */
  identifier: string;
}

export interface ContactSetFieldParams {
  /**
   * Field value
   */
  value: string;
}

export declare namespace Contacts {
  export {
    type ContactChannel as ContactChannel,
    type ContactSegmentMembership as ContactSegmentMembership,
    type ContactConsent as ContactConsent,
    type ContactListConsentsResponse as ContactListConsentsResponse,
    type ContactCreateResponse as ContactCreateResponse,
    type ContactRetrieveResponse as ContactRetrieveResponse,
    type ContactListResponse as ContactListResponse,
    type ContactUpdateResponse as ContactUpdateResponse,
    type ContactBulkCreateResponse as ContactBulkCreateResponse,
    type ContactBulkOperationsResponse as ContactBulkOperationsResponse,
    type ContactMergeResponse as ContactMergeResponse,
    type ContactListChannelsResponse as ContactListChannelsResponse,
    type ContactAddChannelResponse as ContactAddChannelResponse,
    type ContactListSegmentsResponse as ContactListSegmentsResponse,
    type ContactAddSegmentResponse as ContactAddSegmentResponse,
    type ContactSetFieldResponse as ContactSetFieldResponse,
    type ContactCreateParams as ContactCreateParams,
    type ContactListParams as ContactListParams,
    type ContactListConsentsParams as ContactListConsentsParams,
    type ContactUpdateParams as ContactUpdateParams,
    type ContactBulkCreateParams as ContactBulkCreateParams,
    type ContactBulkOperationsParams as ContactBulkOperationsParams,
    type ContactMergeParams as ContactMergeParams,
    type ContactAddChannelParams as ContactAddChannelParams,
    type ContactRecordConsentParams as ContactRecordConsentParams,
    type ContactSetFieldParams as ContactSetFieldParams,
  };
}
