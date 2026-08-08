// Hand-written scaffold matching /v1/ai-agents routes. Superseded by
// Stainless regeneration on the next OpenAPI pass.

import { APIPromise } from '../core/api-promise';
import { APIResource } from '../core/resource';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class AiAgents extends APIResource {
  create(body: AiAgentCreateParams, options?: RequestOptions): APIPromise<AiAgentResponse> {
    return this._client.post('/v1/ai-agents', { body, ...options });
  }

  list(
    query: AiAgentListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AiAgentListResponse> {
    return this._client.get('/v1/ai-agents', { query, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<AiAgentResponse> {
    return this._client.get(path`/v1/ai-agents/${id}`, options);
  }

  update(
    id: string,
    body: AiAgentUpdateParams,
    options?: RequestOptions,
  ): APIPromise<AiAgentResponse> {
    return this._client.patch(path`/v1/ai-agents/${id}`, { body, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ai-agents/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  respond(
    id: string,
    body: AiAgentRespondParams,
    options?: RequestOptions,
  ): APIPromise<AiAgentRespondResponse> {
    return this._client.post(path`/v1/ai-agents/${id}/respond`, {
      body,
      ...options,
    });
  }
}

export interface AiAgentGuardrails {
  version?: 1;
  blocked_topics?: string[];
  fallback_message?: string;
}

export interface AiAgentHandoff {
  version?: 1;
  keywords?: string[];
  confidence_threshold?: number;
  principal_id?: string | null;
}

export interface AiAgentCreateParams {
  name: string;
  workspace_id?: string;
  persona?: string | null;
  guardrails?: AiAgentGuardrails;
  handoff?: AiAgentHandoff;
  knowledge_base_id?: string | null;
  temperature?: number;
  max_tokens?: number;
  enabled?: boolean;
}

export interface AiAgentUpdateParams {
  name?: string;
  persona?: string | null;
  guardrails?: AiAgentGuardrails;
  handoff?: AiAgentHandoff;
  knowledge_base_id?: string | null;
  temperature?: number;
  max_tokens?: number;
  enabled?: boolean;
}

export interface AiAgentListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
}

export interface AiAgentResponse {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  name: string;
  persona: string | null;
  provider: 'workers_ai';
  model: '@cf/zai-org/glm-4.7-flash';
  guardrails: Required<AiAgentGuardrails>;
  handoff: Required<AiAgentHandoff>;
  knowledge_base_id: string | null;
  temperature: number;
  max_tokens: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AiAgentListResponse {
  data: AiAgentResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface AiAgentTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiAgentRespondParams {
  message: string;
  conversation_context?: AiAgentTurn[];
}

export type AiAgentHandoffReason =
  | 'guardrail'
  | 'keyword'
  | 'low_confidence'
  | 'model_request';

export interface AiAgentRespondResponse {
  message: string;
  confidence: number;
  handoff_required: boolean;
  handoff_reason: AiAgentHandoffReason | null;
  handoff_principal_id: string | null;
  knowledge: Array<{
    document_id: string;
    similarity: number;
  }>;
}
