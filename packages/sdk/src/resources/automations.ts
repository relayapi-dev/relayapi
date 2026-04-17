// Hand-written scaffold for the new automations API. When the OpenAPI spec is
// regenerated via Stainless, this file will be replaced by the generated
// equivalent. Until then, this shim matches the /v1/automations routes in
// apps/api/src/routes/automations.ts and automation-templates.ts.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

// ---------------------------------------------------------------------------
// Core resource
// ---------------------------------------------------------------------------

export class Automations extends APIResource {
  templates: AutomationTemplates = new AutomationTemplates(this._client);

  /**
   * Create an automation from a single-blob spec (trigger + nodes + edges).
   * Node keys are human-chosen strings and referenced by edges.
   */
  create(
    body: AutomationCreateParams,
    options?: RequestOptions,
  ): APIPromise<AutomationWithGraphResponse> {
    return this._client.post('/v1/automations', { body, ...options });
  }

  /**
   * List automations, filtered by status / channel / trigger_type.
   */
  list(
    query: AutomationListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AutomationListResponse> {
    return this._client.get('/v1/automations', { query, ...options });
  }

  /**
   * Retrieve an automation with its full graph (nodes + edges keyed by key).
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<AutomationWithGraphResponse> {
    return this._client.get(path`/v1/automations/${id}`, options);
  }

  /**
   * Update automation metadata. If `status` transitions to "active" and no
   * version has been published yet, the current graph is auto-published.
   */
  update(
    id: string,
    body: AutomationUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AutomationResponse> {
    return this._client.patch(path`/v1/automations/${id}`, { body, ...options });
  }

  /**
   * Delete an automation. Enrollments are cascade-deleted.
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/automations/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Publish the current graph as a new version snapshot. In-flight enrollments
   * continue running against the snapshot they started on.
   */
  publish(id: string, options?: RequestOptions): APIPromise<AutomationResponse> {
    return this._client.post(path`/v1/automations/${id}/publish`, options);
  }

  /**
   * Pause an active automation. Enrollments in progress complete on their
   * existing snapshot; no new enrollments are created while paused.
   */
  pause(id: string, options?: RequestOptions): APIPromise<AutomationResponse> {
    return this._client.post(path`/v1/automations/${id}/pause`, options);
  }

  /**
   * Resume a paused automation. Auto-publishes the current graph if no version
   * has ever been published.
   */
  resume(id: string, options?: RequestOptions): APIPromise<AutomationResponse> {
    return this._client.post(path`/v1/automations/${id}/resume`, options);
  }

  /**
   * Archive an automation. It remains queryable but will not accept new
   * enrollments.
   */
  archive(id: string, options?: RequestOptions): APIPromise<AutomationResponse> {
    return this._client.post(path`/v1/automations/${id}/archive`, options);
  }

  /**
   * List enrollments for an automation, filtered by status.
   */
  listEnrollments(
    id: string,
    query: AutomationListEnrollmentsParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AutomationEnrollmentListResponse> {
    return this._client.get(path`/v1/automations/${id}/enrollments`, { query, ...options });
  }

  /**
   * Get the per-node execution log for a specific enrollment. The endpoint
   * verifies ownership against the caller's org and the automation id in the
   * URL — it will not return logs that belong to another enrollment.
   */
  listRuns(
    id: string,
    enrollmentId: string,
    options?: RequestOptions,
  ): APIPromise<AutomationRunListResponse> {
    return this._client.get(
      path`/v1/automations/${id}/enrollments/${enrollmentId}/runs`,
      options,
    );
  }

  /**
   * Fetch the self-describing catalog of trigger types, node types, templates,
   * and merge tags. Primary consumer is the MCP server so AI agents can
   * construct automations without guessing enum values.
   */
  schema(options?: RequestOptions): APIPromise<AutomationSchemaResponse> {
    return this._client.get('/v1/automations/schema', options);
  }

  /**
   * Dry-run the automation graph without executing handlers or performing any
   * side effects. Returns the predicted node path based on the chosen branch
   * labels (or sensible defaults when none are supplied).
   */
  simulate(
    id: string,
    body: AutomationSimulateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AutomationSimulateResponse> {
    return this._client.post(path`/v1/automations/${id}/simulate`, { body, ...options });
  }
}

// ---------------------------------------------------------------------------
// Templates sub-resource
// ---------------------------------------------------------------------------

export class AutomationTemplates extends APIResource {
  /**
   * Quick-create: comment keyword → DM. Optionally post a public reply on the
   * comment itself.
   */
  commentToDm(
    body: CommentToDmTemplateParams,
    options?: RequestOptions,
  ): APIPromise<AutomationWithGraphResponse> {
    return this._client.post('/v1/automations/templates/comment-to-dm', { body, ...options });
  }

  /**
   * Quick-create: welcome DM when a contact starts a conversation on the
   * selected channel.
   */
  welcomeDm(
    body: WelcomeDmTemplateParams,
    options?: RequestOptions,
  ): APIPromise<AutomationWithGraphResponse> {
    return this._client.post('/v1/automations/templates/welcome-dm', { body, ...options });
  }

  /**
   * Quick-create: reply to inbound DMs matching a keyword.
   */
  keywordReply(
    body: KeywordReplyTemplateParams,
    options?: RequestOptions,
  ): APIPromise<AutomationWithGraphResponse> {
    return this._client.post('/v1/automations/templates/keyword-reply', { body, ...options });
  }

  /**
   * Quick-create: DM new followers. Currently scaffolded with a `manual`
   * trigger because Instagram does not expose a follower webhook via the
   * public Graph API — enrol new followers manually.
   */
  followToDm(
    body: FollowToDmTemplateParams,
    options?: RequestOptions,
  ): APIPromise<AutomationWithGraphResponse> {
    return this._client.post('/v1/automations/templates/follow-to-dm', { body, ...options });
  }

  /**
   * Quick-create: respond when a user replies to an Instagram story.
   */
  storyReply(
    body: StoryReplyTemplateParams,
    options?: RequestOptions,
  ): APIPromise<AutomationWithGraphResponse> {
    return this._client.post('/v1/automations/templates/story-reply', { body, ...options });
  }

  /**
   * Quick-create: giveaway. Tags the contact and sends a confirmation DM when
   * they comment an entry keyword.
   */
  giveaway(
    body: GiveawayTemplateParams,
    options?: RequestOptions,
  ): APIPromise<AutomationWithGraphResponse> {
    return this._client.post('/v1/automations/templates/giveaway', { body, ...options });
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutomationChannel =
  | 'instagram'
  | 'facebook'
  | 'whatsapp'
  | 'telegram'
  | 'discord'
  | 'sms'
  | 'twitter'
  | 'bluesky'
  | 'threads'
  | 'youtube'
  | 'linkedin'
  | 'mastodon'
  | 'reddit'
  | 'googlebusiness'
  | 'beehiiv'
  | 'kit'
  | 'mailchimp'
  | 'listmonk'
  | 'pinterest'
  | 'multi';

export type AutomationStatus = 'draft' | 'active' | 'paused' | 'archived';

export type AutomationEnrollmentStatus =
  | 'active'
  | 'waiting'
  | 'completed'
  | 'exited'
  | 'failed';

export interface AutomationTriggerSpec {
  type: string;
  account_id?: string;
  config?: Record<string, unknown>;
  filters?: {
    tags_any?: string[];
    tags_all?: string[];
    tags_none?: string[];
    segment_id?: string;
    predicates?: {
      all?: Array<{ field: string; op: string; value?: unknown }>;
      any?: Array<{ field: string; op: string; value?: unknown }>;
      none?: Array<{ field: string; op: string; value?: unknown }>;
    };
  };
}

export interface AutomationNodeSpec {
  /**
   * Discriminator for the node variant. See
   * `AUTOMATION_NODE_TYPES` in the API for the complete list.
   */
  type: string;
  /**
   * Human-chosen identifier referenced by edges. Must be unique within this
   * automation and match `[a-zA-Z][a-zA-Z0-9_]*`.
   */
  key: string;
  notes?: string;
  canvas_x?: number;
  canvas_y?: number;
  /**
   * All other fields are type-specific. Flat layout — do not wrap in
   * `{ config: {...} }`.
   */
  [field: string]: unknown;
}

export interface AutomationEdgeSpec {
  /** Source node key. Use "trigger" for the virtual entry node. */
  from: string;
  /** Target node key. */
  to: string;
  /**
   * Edge label. Defaults to "next". Common labels:
   * - `yes` / `no` for condition nodes
   * - `branch_1`, `branch_2`, ... for randomizer / split_test
   * - `captured` / `no_match` / `timeout` for user_input nodes
   * - `handoff` / `complete` for ai_agent
   */
  label?: string;
  order?: number;
  condition_expr?: unknown;
}

export interface AutomationCreateParams {
  name: string;
  description?: string;
  workspace_id?: string;
  channel: AutomationChannel;
  status?: AutomationStatus;
  trigger: AutomationTriggerSpec;
  nodes: AutomationNodeSpec[];
  edges?: AutomationEdgeSpec[];
  exit_on_reply?: boolean;
  allow_reentry?: boolean;
  /** Minutes a contact must wait before being re-enrolled. Requires `allow_reentry`. */
  reentry_cooldown_min?: number;
}

export interface AutomationUpdateParams extends Partial<AutomationCreateParams> {}

export interface AutomationListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
  status?: AutomationStatus;
  channel?: AutomationChannel;
  trigger_type?: string;
}

export interface AutomationListEnrollmentsParams {
  cursor?: string;
  limit?: number;
  status?: AutomationEnrollmentStatus;
}

export interface AutomationResponse {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  status: AutomationStatus;
  channel: AutomationChannel;
  trigger_type: string;
  trigger_config: unknown;
  trigger_filters: unknown;
  social_account_id: string | null;
  entry_node_id: string | null;
  version: number;
  published_version: number | null;
  exit_on_reply: boolean;
  allow_reentry: boolean;
  reentry_cooldown_min: number | null;
  total_enrolled: number;
  total_completed: number;
  total_exited: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationNodeResponse {
  id: string;
  key: string;
  type: string;
  config: unknown;
  canvas_x: number | null;
  canvas_y: number | null;
  notes: string | null;
}

export interface AutomationEdgeResponse {
  id: string;
  from_node_key: string;
  to_node_key: string;
  label: string;
  order: number;
  condition_expr: unknown;
}

export interface AutomationWithGraphResponse extends AutomationResponse {
  nodes: AutomationNodeResponse[];
  edges: AutomationEdgeResponse[];
}

export interface AutomationListResponse {
  data: AutomationResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AutomationEnrollmentResponse {
  id: string;
  automation_id: string;
  automation_version: number;
  contact_id: string | null;
  conversation_id: string | null;
  current_node_id: string | null;
  state: unknown;
  status: AutomationEnrollmentStatus;
  next_run_at: string | null;
  enrolled_at: string;
  completed_at: string | null;
  exited_at: string | null;
  exit_reason: string | null;
}

export interface AutomationEnrollmentListResponse {
  data: AutomationEnrollmentResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AutomationRunLogResponse {
  id: string;
  enrollment_id: string;
  node_id: string | null;
  node_type: string | null;
  executed_at: string;
  outcome: string;
  branch_label: string | null;
  duration_ms: number | null;
  error: string | null;
  payload: unknown;
}

export interface AutomationRunListResponse {
  data: AutomationRunLogResponse[];
}

export interface AutomationSimulateParams {
  version?: number;
  branch_choices?: Record<string, string>;
  max_steps?: number;
}

export interface AutomationSimulateStep {
  node_id: string;
  node_key: string;
  node_type: string;
  branch_label: string | null;
  note: string | null;
}

export interface AutomationSimulateResponse {
  automation_id: string;
  version: number;
  path: AutomationSimulateStep[];
  terminated: {
    kind: 'complete' | 'exit' | 'step_cap' | 'dead_end' | 'cycle' | 'unknown_node';
    reason?: string;
    node_key?: string;
  };
}

export interface AutomationSchemaResponse {
  triggers: Array<{
    type: string;
    description: string;
    channel: AutomationChannel;
    tier: number;
    transport: 'webhook' | 'polling' | 'streaming';
    config_schema: unknown;
    output_labels: string[];
  }>;
  nodes: Array<{
    type: string;
    description: string;
    category: 'content' | 'input' | 'logic' | 'ai' | 'action' | 'ops' | 'platform_send';
    fields_schema: unknown;
    output_labels: string[];
  }>;
  templates: Array<{
    id: string;
    name: string;
    description: string;
    input_schema: unknown;
  }>;
  merge_tags: string[];
}

// Template params — mirror the Zod schemas in apps/api/src/schemas/automations.ts

export interface CommentToDmTemplateParams {
  name: string;
  workspace_id?: string;
  account_id: string;
  post_id?: string | null;
  keywords: string[];
  match_mode?: 'contains' | 'exact';
  dm_message: string;
  public_reply?: string;
  once_per_user?: boolean;
}

export interface WelcomeDmTemplateParams {
  name: string;
  workspace_id?: string;
  account_id: string;
  channel: 'instagram' | 'facebook' | 'whatsapp';
  welcome_message: string;
}

export interface KeywordReplyTemplateParams {
  name: string;
  workspace_id?: string;
  account_id: string;
  channel: AutomationChannel;
  keywords: string[];
  match_mode?: 'contains' | 'exact';
  reply_message: string;
}

export interface FollowToDmTemplateParams {
  name: string;
  workspace_id?: string;
  account_id: string;
  welcome_message: string;
}

export interface StoryReplyTemplateParams {
  name: string;
  workspace_id?: string;
  account_id: string;
  dm_message: string;
}

export interface GiveawayTemplateParams {
  name: string;
  workspace_id?: string;
  account_id: string;
  channel: 'instagram' | 'facebook';
  post_id?: string;
  entry_keywords: string[];
  entry_tag?: string;
  confirmation_dm: string;
}
