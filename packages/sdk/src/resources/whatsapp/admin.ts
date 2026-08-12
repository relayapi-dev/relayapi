// Hand-maintained companion to the generated WhatsApp resources.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

function mutationHeaders(idempotencyKey: string, options?: RequestOptions) {
  return buildHeaders([
    { 'Idempotency-Key': idempotencyKey },
    options?.headers,
  ]);
}

export class Admin extends APIResource {
  capabilities(
    query: WhatsAppAccountParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminCapabilities> {
    return this._client.get('/v1/whatsapp/admin/capabilities', {
      query,
      ...options,
    });
  }

  listGroups(
    query: WhatsAppGroupListParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppGroupListResponse> {
    return this._client.get('/v1/whatsapp/admin/groups', {
      query,
      ...options,
    });
  }

  createGroup(
    params: WhatsAppGroupCreateParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.post('/v1/whatsapp/admin/groups', {
      body,
      ...options,
      headers: mutationHeaders(idempotency_key, options),
    });
  }

  retrieveGroup(
    groupID: string,
    query: WhatsAppGroupRetrieveParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppGroup> {
    return this._client.get(path`/v1/whatsapp/admin/groups/${groupID}`, {
      query,
      ...options,
    });
  }

  updateGroup(
    groupID: string,
    params: WhatsAppGroupUpdateParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.patch(path`/v1/whatsapp/admin/groups/${groupID}`, {
      body,
      ...options,
      headers: mutationHeaders(idempotency_key, options),
    });
  }

  deleteGroup(
    groupID: string,
    params: WhatsAppGroupDeleteParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, account_id } = params;
    return this._client.delete(path`/v1/whatsapp/admin/groups/${groupID}`, {
      query: { account_id },
      ...options,
      headers: mutationHeaders(idempotency_key, options),
    });
  }

  getInviteLink(
    groupID: string,
    query: WhatsAppAccountParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppInviteLinkResponse> {
    return this._client.get(
      path`/v1/whatsapp/admin/groups/${groupID}/invite-link`,
      { query, ...options },
    );
  }

  resetInviteLink(
    groupID: string,
    params: WhatsAppAccountMutationParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.post(
      path`/v1/whatsapp/admin/groups/${groupID}/invite-link`,
      {
        body,
        ...options,
        headers: mutationHeaders(idempotency_key, options),
      },
    );
  }

  listJoinRequests(
    groupID: string,
    query: WhatsAppJoinRequestListParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppJoinRequestListResponse> {
    return this._client.get(
      path`/v1/whatsapp/admin/groups/${groupID}/join-requests`,
      { query, ...options },
    );
  }

  approveJoinRequests(
    groupID: string,
    params: WhatsAppResolveJoinRequestsParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    return this.resolveJoinRequests(groupID, 'approve', params, options);
  }

  rejectJoinRequests(
    groupID: string,
    params: WhatsAppResolveJoinRequestsParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    return this.resolveJoinRequests(groupID, 'reject', params, options);
  }

  private resolveJoinRequests(
    groupID: string,
    action: 'approve' | 'reject',
    params: WhatsAppResolveJoinRequestsParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.post(
      path`/v1/whatsapp/admin/groups/${groupID}/join-requests/${action}`,
      {
        body,
        ...options,
        headers: mutationHeaders(idempotency_key, options),
      },
    );
  }

  removeParticipants(
    groupID: string,
    params: WhatsAppRemoveParticipantsParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.post(
      path`/v1/whatsapp/admin/groups/${groupID}/participants/remove`,
      {
        body,
        ...options,
        headers: mutationHeaders(idempotency_key, options),
      },
    );
  }

  sendGroupMessage(
    groupID: string,
    params: WhatsAppGroupMessageParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.post(
      path`/v1/whatsapp/admin/groups/${groupID}/messages`,
      {
        body,
        ...options,
        headers: mutationHeaders(idempotency_key, options),
      },
    );
  }

  pinGroupMessage(
    groupID: string,
    params: WhatsAppGroupPinParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.post(
      path`/v1/whatsapp/admin/groups/${groupID}/pins`,
      {
        body,
        ...options,
        headers: mutationHeaders(idempotency_key, options),
      },
    );
  }

  listBlockedUsers(
    query: WhatsAppBlockedUserListParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppBlockedUserListResponse> {
    return this._client.get('/v1/whatsapp/admin/block-users', {
      query,
      ...options,
    });
  }

  blockUsers(
    params: WhatsAppBlockUsersParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    return this.mutateBlockedUsers('post', params, options);
  }

  unblockUsers(
    params: WhatsAppBlockUsersParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    return this.mutateBlockedUsers('delete', params, options);
  }

  private mutateBlockedUsers(
    method: 'post' | 'delete',
    params: WhatsAppBlockUsersParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client[method]('/v1/whatsapp/admin/block-users', {
      body,
      ...options,
      headers: mutationHeaders(idempotency_key, options),
    });
  }

  getUsername(
    query: WhatsAppAccountParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppBusinessUsernameResponse> {
    return this._client.get('/v1/whatsapp/admin/username', {
      query,
      ...options,
    });
  }

  setUsername(
    params: WhatsAppSetUsernameParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.put('/v1/whatsapp/admin/username', {
      body,
      ...options,
      headers: mutationHeaders(idempotency_key, options),
    });
  }

  deleteUsername(
    params: WhatsAppAccountMutationParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, account_id } = params;
    return this._client.delete('/v1/whatsapp/admin/username', {
      query: { account_id },
      ...options,
      headers: mutationHeaders(idempotency_key, options),
    });
  }

  usernameSuggestions(
    query: WhatsAppAccountParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppUsernameSuggestionsResponse> {
    return this._client.get('/v1/whatsapp/admin/username/suggestions', {
      query,
      ...options,
    });
  }

  templateLibrary(
    query: WhatsAppTemplateLibraryParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppTemplateLibraryResponse> {
    return this._client.get('/v1/whatsapp/admin/template-library', {
      query,
      ...options,
    });
  }

  createTemplateFromLibrary(
    params: WhatsAppTemplateLibraryCreateParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.post('/v1/whatsapp/admin/templates/from-library', {
      body,
      ...options,
      headers: mutationHeaders(idempotency_key, options),
    });
  }

  editTemplate(
    templateID: string,
    params: WhatsAppTemplateEditParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    const { idempotency_key, ...body } = params;
    return this._client.patch(
      path`/v1/whatsapp/admin/templates/${templateID}`,
      {
        body,
        ...options,
        headers: mutationHeaders(idempotency_key, options),
      },
    );
  }

  getOperation(
    operationID: string,
    query: WhatsAppAccountParams,
    options?: RequestOptions,
  ): APIPromise<WhatsAppAdminMutation> {
    return this._client.get(
      path`/v1/whatsapp/admin/operations/${operationID}`,
      { query, ...options },
    );
  }
}

export interface WhatsAppAdminMutation {
  id: string;
  target_id: string;
  account_id: string;
  platform: string;
  kind: string;
  status: 'pending' | 'processing' | 'request_may_have_been_sent' | 'unknown' | 'completed' | 'failed';
  provider_operation_id: string | null;
  provider_post_id: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WhatsAppAccountParams {
  account_id: string;
}

export interface WhatsAppAccountMutationParams extends WhatsAppAccountParams {
  idempotency_key: string;
}

export interface WhatsAppAdminCapabilities {
  account_id: string;
  capabilities: {
    groups: WhatsAppAdminCapabilityState;
    block_users: WhatsAppAdminCapabilityState;
    business_username: WhatsAppAdminCapabilityState;
    template_library: WhatsAppAdminCapabilityState;
    template_edit: WhatsAppAdminCapabilityState;
    bsuid_webhooks: WhatsAppAdminCapabilityState;
    bsuid_outbound: WhatsAppAdminCapabilityState;
  };
  requirements: string[];
  checked_at: string;
}

export type WhatsAppAdminCapabilityState =
  | 'supported'
  | 'requires_eligibility'
  | 'unavailable'
  | 'unverified'
  | 'not_yet_available';

export interface WhatsAppGroup {
  relay_group_id?: string;
  id: string;
  messaging_product?: string;
  subject?: string;
  description?: string | null;
  join_approval_mode?: 'auto_approve' | 'approval_required';
  participants?: Array<{
    wa_id?: string;
    user_id?: string;
    username?: string;
    country_code?: string;
  }>;
  total_participant_count?: number;
  creation_timestamp?: number | string;
  created_at?: number | string;
  suspended?: boolean;
  invite_link?: string;
  request_id?: string;
}

export interface WhatsAppGroupListParams extends WhatsAppAccountParams {
  limit?: number;
  after?: string;
  before?: string;
}

export interface WhatsAppGroupListResponse {
  data: WhatsAppGroup[];
  paging?: Record<string, unknown>;
}

export interface WhatsAppGroupCreateParams extends WhatsAppAccountMutationParams {
  subject: string;
  description?: string;
  join_approval_mode?: 'auto_approve' | 'approval_required';
}

export interface WhatsAppGroupRetrieveParams extends WhatsAppAccountParams {
  fields?: string;
}

export interface WhatsAppGroupUpdateParams extends WhatsAppAccountMutationParams {
  subject?: string;
  description?: string;
}

export type WhatsAppGroupDeleteParams = WhatsAppAccountMutationParams;

export interface WhatsAppInviteLinkResponse {
  messaging_product?: string;
  invite_link: string;
}

export interface WhatsAppJoinRequestListParams extends WhatsAppGroupListParams {}

export interface WhatsAppJoinRequestListResponse {
  data: Array<{
    join_request_id: string;
    wa_id?: string;
    user_id?: string;
    username?: string;
    country_code?: string;
    creation_timestamp: string | number;
  }>;
  paging?: Record<string, unknown>;
}

export interface WhatsAppResolveJoinRequestsParams extends WhatsAppAccountMutationParams {
  join_request_ids: string[];
}

export interface WhatsAppRemoveParticipantsParams extends WhatsAppAccountMutationParams {
  participants: Array<{ user: string }>;
}

type WhatsAppMessageBase = WhatsAppAccountMutationParams;

type WhatsAppMediaReference =
  | { id: string; link?: never }
  | { id?: never; link: string };

export type WhatsAppGroupMessageParams =
  | (WhatsAppMessageBase & {
      type: 'text';
      text: { body: string; preview_url?: boolean };
    })
  | (WhatsAppMessageBase & {
      type: 'image' | 'video';
      media: WhatsAppMediaReference & { caption?: string };
    })
  | (WhatsAppMessageBase & {
      type: 'document';
      media: WhatsAppMediaReference & {
        caption?: string;
        filename?: string;
      };
    })
  | (WhatsAppMessageBase & {
      type: 'audio';
      media: WhatsAppMediaReference;
    })
  | (WhatsAppMessageBase & {
      type: 'template';
      template: {
        name: string;
        language: { code: string };
        components?: Array<Record<string, unknown>>;
      };
    });

export type WhatsAppGroupPinParams = WhatsAppAccountMutationParams &
  (
    | { message_id: string; action: 'pin'; expiration_days: number }
    | { message_id: string; action: 'unpin'; expiration_days?: never }
  );

export interface WhatsAppBlockedUserListParams extends WhatsAppAccountParams {
  limit?: number;
  after?: string;
  before?: string;
}

export interface WhatsAppBlockedUserListResponse {
  data: Array<{
    wa_id?: string;
    user_id?: string;
    username?: string;
    country_code?: string;
  }>;
  paging?: Record<string, unknown>;
}

export interface WhatsAppBlockUsersParams extends WhatsAppAccountMutationParams {
  users: Array<{ user: string }>;
}

export interface WhatsAppBusinessUsernameResponse {
  username?: string;
  status?: 'ACTIVE' | 'RESERVED';
  requested_username?: string;
  success?: boolean;
}

export interface WhatsAppSetUsernameParams extends WhatsAppAccountMutationParams {
  username: string;
}

export interface WhatsAppUsernameSuggestionsResponse {
  data: Array<{ username_suggestions: string[] }>;
}

export interface WhatsAppTemplateLibraryParams extends WhatsAppAccountParams {
  name_or_content?: string;
  category?: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  topic?: string;
  usecase?: string;
  industry?: string;
  language?: string;
  limit?: number;
  after?: string;
  before?: string;
}

export interface WhatsAppTemplateLibraryResponse {
  data: Array<Record<string, unknown>>;
  paging?: Record<string, unknown>;
}

export interface WhatsAppTemplateLibraryCreateParams extends WhatsAppAccountMutationParams {
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  library_template_name: string;
  library_template_button_inputs?: Array<Record<string, unknown>>;
  library_template_body_inputs?: Array<Record<string, unknown>>;
}

export interface WhatsAppTemplateEditParams extends WhatsAppAccountMutationParams {
  components?: Array<Record<string, unknown>>;
  category?: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  parameter_format?: 'POSITIONAL' | 'NAMED';
  message_send_ttl_seconds?: number;
  cta_url_link_tracking_opted_out?: boolean;
}
