// Hand-written scaffold matching /v1/admin routes. Superseded by Stainless
// regeneration on the next OpenAPI pass.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Admin extends APIResource {
  listOrganizations(
    query: AdminOrganizationListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdminOrganizationListResponse> {
    return this._client.get('/v1/admin/organizations', { query, ...options });
  }

  /** Live system-administrator authority is held through database commit. */
  updateOrganization(
    id: string,
    body: AdminOrganizationUpdateParams,
    options?: RequestOptions,
  ): APIPromise<AdminMutationResponse> {
    return this._client.patch(path`/v1/admin/organizations/${id}`, {
      body,
      ...options,
    });
  }

  listSubscriptions(options?: RequestOptions): APIPromise<AdminSubscriptionListResponse> {
    return this._client.get('/v1/admin/subscriptions', options);
  }

  /** Live system-administrator authority is held through database commit. */
  updateSubscription(
    id: string,
    body: AdminSubscriptionUpdateParams,
    options?: RequestOptions,
  ): APIPromise<AdminMutationResponse> {
    return this._client.patch(path`/v1/admin/subscriptions/${id}`, {
      body,
      ...options,
    });
  }

  listErasureHolds(
    query: AdminErasureHoldListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdminErasureHoldListResponse> {
    return this._client.get('/v1/admin/erasure-holds', {
      query,
      ...options,
    });
  }

  listErasureJobs(
    query: AdminErasureJobListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdminErasureJobListResponse> {
    return this._client.get('/v1/admin/erasure-jobs', {
      query,
      ...options,
    });
  }

  listAutomationWebhookFailures(
    query: AdminAutomationWebhookFailureListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdminAutomationWebhookFailureListResponse> {
    return this._client.get('/v1/admin/automation-webhook-failures', {
      query,
      ...options,
    });
  }

  listOperatorResolutions(
    query: AdminOperatorResolutionListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdminOperatorResolutionListResponse> {
    return this._client.get('/v1/admin/operator-resolutions', {
      query,
      ...options,
    });
  }

  listOperatorResolutionEvidence(
    query: AdminOperatorResolutionEvidenceListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AdminOperatorResolutionEvidenceListResponse> {
    return this._client.get('/v1/admin/operator-resolution-evidence', {
      query,
      ...options,
    });
  }

  /** Live system-administrator authority is held through database commit. */
  resolveOperatorResolution(
    targetType: AdminOperatorResolutionTargetType,
    targetId: string,
    body: AdminOperatorResolutionRequest,
    options?: RequestOptions,
  ): APIPromise<AdminOperatorResolutionResponse> {
    return this._client.post(
      path`/v1/admin/operator-resolutions/${targetType}/${targetId}`,
      {
        body,
        ...options,
      },
    );
  }

  /** Live system-administrator authority is held through database commit. */
  createErasureHold(
    body: AdminErasureHoldCreateParams,
    options?: RequestOptions,
  ): APIPromise<AdminErasureHold> {
    return this._client.post('/v1/admin/erasure-holds', {
      body,
      ...options,
    });
  }

  /** Live system-administrator authority is held through database commit. */
  releaseErasureHold(
    id: string,
    body: AdminErasureHoldReleaseParams,
    options?: RequestOptions,
  ): APIPromise<AdminErasureHold> {
    return this._client.post(path`/v1/admin/erasure-holds/${id}/release`, {
      body,
      ...options,
    });
  }
}

export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: string;
  memberCount: number;
  plan: 'free' | 'pro';
  subscriptionStatus: string | null;
  basePriceCents: number;
  apiCallsUsed: number;
  apiCallsIncluded: number;
  aiEnabled: boolean;
  dailyToolLimit: number;
  dailyToolLimitOverride: number | null;
}

export interface AdminOrganizationListParams {
  limit?: number;
  offset?: number;
  search?: string;
}

export interface AdminOrganizationListResponse {
  organizations: AdminOrganization[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminOrganizationUpdateParams {
  name?: string;
  slug?: string;
  plan?: 'free' | 'pro';
  aiEnabled?: boolean;
  /**
   * Per-organization daily tools allowance. Null restores the plan default;
   * zero disables cost-bearing tools for the organization.
   */
  dailyToolLimitOverride?: number | null;
}

export interface AdminSubscription {
  id: string;
  organizationId: string;
  status: string;
  source: 'stripe' | 'complimentary';
  basePriceCents: number;
  delinquentAt: string | null;
  graceEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  createdAt: string;
  orgName: string | null;
  orgSlug: string | null;
  apiCallsUsed: number;
  apiCallsIncluded: number;
  overageCalls: number;
  overageCostCents: number;
}

export interface AdminSubscriptionListResponse {
  subscriptions: AdminSubscription[];
}

export interface AdminSubscriptionUpdateParams {
  status?: 'active' | 'cancelled';
}

export interface AdminMutationResponse {
  ok: true;
}

export interface AdminAutomationWebhookFailure {
  occurrenceId: string;
  organizationId: string;
  automationId: string;
  entrypointId: string;
  channel: string;
  socialAccountId: string | null;
  reason:
    | 'missing_secret'
    | 'missing_signature'
    | 'credential_unavailable'
    | 'invalid_timestamp'
    | 'stale_timestamp'
    | 'bad_signature'
    | 'bad_payload'
    | 'contact_lookup_failed'
    | 'enrollment_blocked'
    | 'enrollment_failed'
    | 'invalid_payload';
  requestDigest: string | null;
  receivedAt: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'unknown';
  attempts: number;
  error: string | null;
  manualReviewRequired: boolean;
  resolutionMode: 'evidence_only';
  createdAt: string;
}

export interface AdminAutomationWebhookFailureListParams {
  limit?: number;
  offset?: number;
  organizationId?: string;
  status?: AdminAutomationWebhookFailure['status'];
  review?: 'all' | 'required';
}

export interface AdminAutomationWebhookFailureListResponse {
  failures: AdminAutomationWebhookFailure[];
  total: number;
  limit: number;
  offset: number;
}

export type AdminOperatorResolutionTargetType =
  | 'automation_effect'
  | 'automation_binding'
  | 'automation_conversion_event'
  | 'stripe_event'
  | 'billing_operation'
  | 'tenant_erasure_job'
  | 'workspace_erasure_job'
  | 'account_revocation_job'
  | 'external_subject_cleanup_job'
  | 'short_link_creation'
  | 'customer_webhook_delivery'
  | 'tool_job'
  | 'whatsapp_phone_provisioning_operation'
  | 'whatsapp_phone_release_operation'
  | 'whatsapp_phone_billing_operation'
  | 'ad_creation_operation'
  | 'ad_mutation_operation';

export type AdminOperatorResolutionAction =
  | 'mark_succeeded'
  | 'mark_not_applied'
  | 'retry'
  | 'abandon';

export interface AdminOperatorResolutionItem {
  targetType: AdminOperatorResolutionTargetType;
  targetId: string;
  organizationId: string | null;
  status: string;
  reasonCode: string;
  allowedActions: AdminOperatorResolutionAction[];
  detectedAt: string;
  updatedAt: string;
}

export interface AdminOperatorResolutionListParams {
  limit?: number;
  offset?: number;
  organizationId?: string;
  targetType?: AdminOperatorResolutionTargetType;
}

export interface AdminOperatorResolutionListResponse {
  items: AdminOperatorResolutionItem[];
  total: number;
  limit: number;
  offset: number;
}

export type AdminOperatorResolutionState = Record<
  string,
  string | number | boolean | null
>;

export interface AdminOperatorResolutionEvidence {
  id: string;
  organizationId: string | null;
  targetType: AdminOperatorResolutionTargetType;
  targetId: string;
  action: AdminOperatorResolutionAction;
  reason: string | null;
  reasonCode:
    | 'operator_asserted_succeeded'
    | 'operator_asserted_not_applied'
    | 'operator_requested_retry'
    | 'operator_abandoned';
  reasonDigest: string;
  actorUserId: string;
  beforeState: AdminOperatorResolutionState;
  afterState: AdminOperatorResolutionState;
  targetUpdatedAtBefore: string;
  targetUpdatedAtAfter: string;
  resolvedAt: string;
}

export interface AdminOperatorResolutionEvidenceListParams {
  limit?: number;
  cursor?: string;
  organizationId?: string;
  targetType?: AdminOperatorResolutionTargetType;
  targetId?: string;
  action?: AdminOperatorResolutionAction;
}

export interface AdminOperatorResolutionEvidenceListResponse {
  evidence: AdminOperatorResolutionEvidence[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AdminOperatorResolutionRequest {
  action: AdminOperatorResolutionAction;
  reason: string;
  providerReference?: string;
}

export interface AdminOperatorResolutionResponse {
  evidence: AdminOperatorResolutionEvidence;
}

export interface AdminErasureHold {
  id: string;
  subjectKind: 'organization' | 'workspace';
  subjectId: string;
  organizationId: string;
  reasonCode: string;
  reasonSummary: string;
  legalAuthorityRef: string;
  placedBy: string;
  placedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReasonSummary: string | null;
  hasEvidence: boolean;
  evidenceRedactedAt: string | null;
}

export interface AdminErasureHoldListParams {
  limit?: number;
  offset?: number;
  organizationId?: string;
  subjectKind?: 'organization' | 'workspace';
  active?: 'true' | 'false';
}

export interface AdminErasureHoldListResponse {
  holds: AdminErasureHold[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminErasureJob {
  kind: 'organization' | 'workspace';
  jobId: string;
  organizationId: string;
  workspaceId: string | null;
  status:
    | 'pending'
    | 'processing'
    | 'tombstoned'
    | 'waiting_external'
    | 'held'
    | 'manual_review'
    | 'failed'
    | 'purged';
  activeHoldId: string | null;
  requestedAt: string;
  updatedAt: string;
  agedAlertedAt: string | null;
  completedAt: string | null;
}

export interface AdminErasureJobListParams {
  limit?: number;
  offset?: number;
  organizationId?: string;
  status?: AdminErasureJob['status'];
  aged?: 'all' | 'true' | 'false';
}

export interface AdminErasureJobListResponse {
  jobs: AdminErasureJob[];
  total: number;
  limit: number;
  offset: number;
}

export type AdminErasureHoldCreateParams =
  | {
      subjectKind: 'organization';
      organizationId: string;
      reasonCode: string;
      reasonSummary: string;
      legalAuthorityRef: string;
      evidence?: string;
    }
  | {
      subjectKind: 'workspace';
      organizationId: string;
      workspaceId: string;
      reasonCode: string;
      reasonSummary: string;
      legalAuthorityRef: string;
      evidence?: string;
    };

export interface AdminErasureHoldReleaseParams {
  releaseReasonSummary: string;
}
