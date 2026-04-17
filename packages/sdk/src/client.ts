// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import type { RequestInit, RequestInfo, BodyInit } from './internal/builtin-types';
import type { HTTPMethod, PromiseOrValue, MergedRequestInit, FinalizedRequestInit } from './internal/types';
import { uuid4 } from './internal/utils/uuid';
import { validatePositiveInteger, isAbsoluteURL, safeJSON } from './internal/utils/values';
import { sleep } from './internal/utils/sleep';
export type { Logger, LogLevel } from './internal/utils/log';
import { castToError, isAbortError } from './internal/errors';
import type { APIResponseProps } from './internal/parse';
import { getPlatformHeaders } from './internal/detect-platform';
import * as Shims from './internal/shims';
import * as Opts from './internal/request-options';
import { stringifyQuery } from './internal/utils/query';
import { VERSION } from './version';
import * as Errors from './core/error';
import * as Uploads from './core/uploads';
import * as API from './resources/index';
import { APIPromise } from './core/api-promise';
import {
  AutoPostRules,
  AutoPostRuleResponse,
  AutoPostRuleListResponse,
  AutoPostRuleCreateParams,
  AutoPostRuleUpdateParams,
  AutoPostRuleListParams,
  AutoPostRuleTestFeedParams,
  AutoPostRuleTestFeedResponse,
} from './resources/auto-post-rules';
import {
  Ads,
  AdAccountResponse,
  AdAccountListResponse,
  AdCampaignResponse,
  AdCampaignListResponse,
  AdResponse,
  AdListResponse,
  AdAnalyticsResponse,
  AdInterestResponse,
  AdInterestListResponse,
  AdAudienceResponse,
  AdAudienceListResponse,
  AdAddAudienceUsersResponse,
  AdUpdateCampaignResponse,
  AdSyncResponse,
  AdListAccountsParams,
  AdCreateCampaignParams,
  AdUpdateCampaignParams,
  AdListCampaignsParams,
  AdCreateParams,
  AdBoostParams,
  AdUpdateParams,
  AdListParams,
  AdGetAnalyticsParams,
  AdSearchInterestsParams,
  AdCreateAudienceParams,
  AdListAudiencesParams,
  AdAddAudienceUsersParams,
} from './resources/ads';
import {
  WorkspaceCreateParams,
  WorkspaceCreateResponse,
  WorkspaceListResponse,
  WorkspaceUpdateParams,
  WorkspaceUpdateResponse,
  Workspaces,
} from './resources/workspaces';
import {
  Broadcasts,
  BroadcastResponse,
  BroadcastListResponse,
  BroadcastAddRecipientsResponse,
  BroadcastRecipientResponse,
  BroadcastListRecipientsResponse,
  BroadcastCreateParams,
  BroadcastUpdateParams,
  BroadcastListParams,
  BroadcastAddRecipientsParams,
  BroadcastScheduleParams,
  BroadcastListRecipientsParams,
} from './resources/broadcasts';
import {
  Automations,
  AutomationTemplates,
  AutomationResponse,
  AutomationNodeResponse,
  AutomationEdgeResponse,
  AutomationWithGraphResponse,
  AutomationListResponse,
  AutomationEnrollmentResponse,
  AutomationEnrollmentListResponse,
  AutomationRunLogResponse,
  AutomationRunListResponse,
  AutomationSchemaResponse,
  AutomationSimulateParams,
  AutomationSimulateResponse,
  AutomationSimulateStep,
  AutomationCreateParams,
  AutomationUpdateParams,
  AutomationListParams,
  AutomationListEnrollmentsParams,
  AutomationTriggerSpec,
  AutomationNodeSpec,
  AutomationEdgeSpec,
  AutomationChannel,
  AutomationStatus,
  AutomationEnrollmentStatus,
  CommentToDmTemplateParams,
  WelcomeDmTemplateParams,
  KeywordReplyTemplateParams,
  FollowToDmTemplateParams,
  StoryReplyTemplateParams,
  GiveawayTemplateParams,
} from './resources/automations';
import {
  Segments,
  SegmentCreateParams,
  SegmentUpdateParams,
  SegmentListParams,
  SegmentResponse,
  SegmentListResponse,
  SegmentFilter,
  SegmentFilterPredicate,
} from './resources/segments';
import {
  AiKnowledge,
  AiKnowledgeDocuments,
  KnowledgeBaseCreateParams,
  KnowledgeBaseUpdateParams,
  KnowledgeBaseListParams,
  KnowledgeBaseResponse,
  KnowledgeBaseListResponse,
  KnowledgeDocumentCreateParams,
  KnowledgeDocumentListParams,
  KnowledgeDocumentResponse,
  KnowledgeDocumentListResponse,
} from './resources/ai-knowledge';
import {
  RefUrls,
  RefUrlCreateParams,
  RefUrlUpdateParams,
  RefUrlListParams,
  RefUrlResponse,
  RefUrlListResponse,
} from './resources/ref-urls';
import {
  APIKeyCreateParams,
  APIKeyCreateResponse,
  APIKeyListParams,
  APIKeyListResponse,
  APIKeys,
} from './resources/api-keys';
import {
  InviteTokenCreateParams,
  InviteTokenCreateResponse,
  InviteTokenListParams,
  InviteTokenListResponse,
  InviteTokens,
} from './resources/invite-tokens';
import { ConnectionListLogsParams, ConnectionListLogsResponse, Connections } from './resources/connections';
import {
  Contacts,
  ContactChannel,
  ContactCreateResponse,
  ContactRetrieveResponse,
  ContactListResponse,
  ContactUpdateResponse,
  ContactBulkCreateResponse,
  ContactBulkOperationsResponse,
  ContactMergeResponse,
  ContactListChannelsResponse,
  ContactAddChannelResponse,
  ContactSetFieldResponse,
  ContactCreateParams,
  ContactListParams,
  ContactUpdateParams,
  ContactBulkCreateParams,
  ContactBulkOperationsParams,
  ContactMergeParams,
  ContactAddChannelParams,
  ContactSetFieldParams,
} from './resources/contacts';
import {
  CrossPostActions,
  CrossPostActionResponse,
  CrossPostActionListResponse,
  CrossPostActionInput,
  CrossPostActionListParams,
} from './resources/cross-post-actions';
import {
  ContentTemplates,
  ContentTemplateCreateParams,
  ContentTemplateCreateResponse,
  ContentTemplateUpdateParams,
  ContentTemplateUpdateResponse,
  ContentTemplateGetResponse,
  ContentTemplateListParams,
  ContentTemplateListResponse,
} from './resources/content-templates';
import {
  Tags,
  TagResponse,
  TagCreateResponse,
  TagUpdateResponse,
  TagListResponse,
  TagCreateParams,
  TagUpdateParams,
  TagListParams,
} from './resources/tags';
import {
  IdeaGroups,
  IdeaGroupResponse,
  IdeaGroupCreateResponse,
  IdeaGroupUpdateResponse,
  IdeaGroupListResponse,
  IdeaGroupCreateParams,
  IdeaGroupUpdateParams,
  IdeaGroupListParams,
  IdeaGroupReorderParams,
} from './resources/idea-groups';
import {
  Ideas,
  IdeaMediaResponse,
  IdeaResponse,
  IdeaListResponse,
  IdeaConvertResponse,
  IdeaCommentResponse,
  IdeaCommentListResponse,
  IdeaActivityResponse,
  IdeaActivityListResponse,
  IdeaListParams,
  IdeaCreateParams,
  IdeaUpdateParams,
  IdeaMoveParams,
  IdeaConvertParams,
  IdeaUploadMediaParams,
  IdeaCommentListParams,
  IdeaCommentCreateParams,
  IdeaCommentUpdateParams,
  IdeaActivityListParams,
} from './resources/ideas';
import {
  Signatures,
  SignatureCreateParams,
  SignatureCreateResponse,
  SignatureUpdateParams,
  SignatureUpdateResponse,
  SignatureGetResponse,
  SignatureGetDefaultResponse,
  SignatureSetDefaultResponse,
  SignatureListParams,
  SignatureListResponse,
} from './resources/signatures';
import {
  Media,
  MediaGetPresignURLParams,
  MediaGetPresignURLResponse,
  MediaListParams,
  MediaListResponse,
  MediaRetrieveResponse,
  MediaUploadParams,
  MediaUploadResponse,
} from './resources/media';
import {
  Reddit,
  RedditGetFeedParams,
  RedditGetFeedResponse,
  RedditSearchParams,
  RedditSearchResponse,
} from './resources/reddit';
import { Streaks, StreakRetrieveResponse } from './resources/streaks';
import {
  OrgSettings,
  OrgSettingsData,
  OrgSettingsRetrieveResponse,
  OrgSettingsUpdateParams,
  OrgSettingsUpdateResponse,
} from './resources/org-settings';
import { Usage, UsageListLogsParams, UsageListLogsResponse, UsageRetrieveResponse } from './resources/usage';
import { WsTicket, WsTicketRetrieveResponse } from './resources/ws-ticket';
import {
  WebhookCreateParams,
  WebhookCreateResponse,
  WebhookListLogsParams,
  WebhookListLogsResponse,
  WebhookListParams,
  WebhookListResponse,
  WebhookSendTestParams,
  WebhookSendTestResponse,
  WebhookUpdateParams,
  WebhookUpdateResponse,
  Webhooks,
} from './resources/webhooks';
import {
  AccountListParams,
  AccountListResponse,
  AccountRetrieveResponse,
  AccountSyncAllParams,
  AccountSyncAllResponse,
  AccountUpdateParams,
  AccountUpdateResponse,
  Accounts,
} from './resources/accounts/accounts';
import {
  Analytics,
  AnalyticsGetBestTimeParams,
  AnalyticsGetBestTimeResponse,
  AnalyticsGetContentDecayParams,
  AnalyticsGetContentDecayResponse,
  AnalyticsGetPlatformAudienceParams,
  AnalyticsGetPlatformAudienceResponse,
  AnalyticsGetPlatformDailyParams,
  AnalyticsGetPlatformDailyResponse,
  AnalyticsGetPlatformOverviewParams,
  AnalyticsGetPlatformOverviewResponse,
  AnalyticsGetPostTimelineParams,
  AnalyticsGetPostTimelineResponse,
  AnalyticsGetPostingFrequencyParams,
  AnalyticsGetPostingFrequencyResponse,
  AnalyticsListChannelsParams,
  AnalyticsListChannelsResponse,
  AnalyticsListDailyMetricsParams,
  AnalyticsListDailyMetricsResponse,
  AnalyticsListPlatformPostsParams,
  AnalyticsListPlatformPostsResponse,
  AnalyticsRetrieveParams,
  AnalyticsRetrieveResponse,
} from './resources/analytics/analytics';
import {
  Connect,
  ConnectCompleteOAuthCallbackParams,
  ConnectCompleteOAuthCallbackResponse,
  ConnectCreateBlueskyConnectionParams,
  ConnectCreateBlueskyConnectionResponse,
  ConnectFetchPendingDataParams,
  ConnectFetchPendingDataResponse,
  ConnectStartOAuthFlowParams,
  ConnectStartOAuthFlowResponse,
} from './resources/connect/connect';
import { Inbox } from './resources/inbox/inbox';
import {
  PostBulkCreateParams,
  PostBulkCreateResponse,
  PostCreateParams,
  PostCreateResponse,
  PostListParams,
  PostListResponse,
  PostRetrieveResponse,
  PostRetryResponse,
  PostUnpublishResponse,
  PostUpdateParams,
  PostUpdateResponse,
  Posts,
} from './resources/posts/posts';
import {
  Queue,
  QueueGetNextSlotResponse,
  QueuePreviewParams,
  QueuePreviewResponse,
  QueueFindSlotParams,
  QueueFindSlotResponse,
} from './resources/queue/queue';
import {
  Threads,
  ThreadCreateParams,
  ThreadResponse,
  ThreadListParams,
  ThreadListResponse,
} from './resources/threads';
import {
  ShortLinks,
  ShortLinkConfigResponse,
  ShortLinkTestResponse,
  ShortLinkResponse,
  ShortLinkListResponse,
  ShortLinkListByPostResponse,
  ShortLinkShortenResponse,
  ShortLinkStatsResponse,
  ShortLinkUpdateConfigParams,
  ShortLinkListParams,
  ShortLinkShortenParams,
} from './resources/short-links';
import { Tools } from './resources/tools/tools';
import { Twitter } from './resources/twitter/twitter';
import {
  Whatsapp,
  WhatsappBulkSendParams,
  WhatsappBulkSendResponse,
  WhatsappListPhoneNumbersParams,
  WhatsappListPhoneNumbersResponse,
} from './resources/whatsapp/whatsapp';
import { type Fetch } from './internal/builtin-types';
import { HeadersLike, NullableHeaders, buildHeaders } from './internal/headers';
import { FinalRequestOptions, RequestOptions } from './internal/request-options';
import { readEnv } from './internal/utils/env';
import {
  type LogLevel,
  type Logger,
  formatRequestDetails,
  loggerFor,
  parseLogLevel,
} from './internal/utils/log';
import { isEmptyObj } from './internal/utils/values';

export interface ClientOptions {
  /**
   * API key (rlay_live_* or rlay_test_*)
   */
  apiKey?: string | undefined;

  /**
   * Override the default base URL for the API, e.g., "https://api.example.com/v2/"
   *
   * Defaults to process.env['RELAY_BASE_URL'].
   */
  baseURL?: string | null | undefined;

  /**
   * The maximum amount of time (in milliseconds) that the client should wait for a response
   * from the server before timing out a single request.
   *
   * Note that request timeouts are retried by default, so in a worst-case scenario you may wait
   * much longer than this timeout before the promise succeeds or fails.
   *
   * @unit milliseconds
   */
  timeout?: number | undefined;
  /**
   * Additional `RequestInit` options to be passed to `fetch` calls.
   * Properties will be overridden by per-request `fetchOptions`.
   */
  fetchOptions?: MergedRequestInit | undefined;

  /**
   * Specify a custom `fetch` function implementation.
   *
   * If not provided, we expect that `fetch` is defined globally.
   */
  fetch?: Fetch | undefined;

  /**
   * The maximum number of times that the client will retry a request in case of a
   * temporary failure, like a network error or a 5XX error from the server.
   *
   * @default 2
   */
  maxRetries?: number | undefined;

  /**
   * Default headers to include with every request to the API.
   *
   * These can be removed in individual requests by explicitly setting the
   * header to `null` in request options.
   */
  defaultHeaders?: HeadersLike | undefined;

  /**
   * Default query parameters to include with every request to the API.
   *
   * These can be removed in individual requests by explicitly setting the
   * param to `undefined` in request options.
   */
  defaultQuery?: Record<string, string | undefined> | undefined;

  /**
   * Set the log level.
   *
   * Defaults to process.env['RELAY_LOG'] or 'warn' if it isn't set.
   */
  logLevel?: LogLevel | undefined;

  /**
   * Set the logger.
   *
   * Defaults to globalThis.console.
   */
  logger?: Logger | undefined;
}

/**
 * API Client for interfacing with the Relay API.
 */
export class Relay {
  apiKey: string;

  baseURL: string;
  maxRetries: number;
  timeout: number;
  logger: Logger;
  logLevel: LogLevel | undefined;
  fetchOptions: MergedRequestInit | undefined;

  private fetch: Fetch;
  #encoder: Opts.RequestEncoder;
  protected idempotencyHeader?: string;
  private _options: ClientOptions;

  /**
   * API Client for interfacing with the Relay API.
   *
   * @param {string | undefined} [opts.apiKey=process.env['RELAY_API_KEY'] ?? undefined]
   * @param {string} [opts.baseURL=process.env['RELAY_BASE_URL'] ?? https://api.relayapi.dev] - Override the default base URL for the API.
   * @param {number} [opts.timeout=1 minute] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
   * @param {MergedRequestInit} [opts.fetchOptions] - Additional `RequestInit` options to be passed to `fetch` calls.
   * @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
   * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
   * @param {HeadersLike} opts.defaultHeaders - Default headers to include with every request to the API.
   * @param {Record<string, string | undefined>} opts.defaultQuery - Default query parameters to include with every request to the API.
   */
  constructor({
    baseURL = readEnv('RELAY_BASE_URL'),
    apiKey = readEnv('RELAY_API_KEY'),
    ...opts
  }: ClientOptions = {}) {
    if (apiKey === undefined) {
      throw new Errors.RelayError(
        "The RELAY_API_KEY environment variable is missing or empty; either provide it, or instantiate the Relay client with an apiKey option, like new Relay({ apiKey: 'My API Key' }).",
      );
    }

    const options: ClientOptions = {
      apiKey,
      ...opts,
      baseURL: baseURL || `https://api.relayapi.dev`,
    };

    this.baseURL = options.baseURL!;
    this.timeout = options.timeout ?? Relay.DEFAULT_TIMEOUT /* 1 minute */;
    this.logger = options.logger ?? console;
    const defaultLogLevel = 'warn';
    // Set default logLevel early so that we can log a warning in parseLogLevel.
    this.logLevel = defaultLogLevel;
    this.logLevel =
      parseLogLevel(options.logLevel, 'ClientOptions.logLevel', this) ??
      parseLogLevel(readEnv('RELAY_LOG'), "process.env['RELAY_LOG']", this) ??
      defaultLogLevel;
    this.fetchOptions = options.fetchOptions;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetch = options.fetch ?? Shims.getDefaultFetch();
    this.#encoder = Opts.FallbackEncoder;

    this._options = options;

    this.apiKey = apiKey;
  }

  /**
   * Create a new client instance re-using the same options given to the current client with optional overriding.
   */
  withOptions(options: Partial<ClientOptions>): this {
    const client = new (this.constructor as any as new (props: ClientOptions) => typeof this)({
      ...this._options,
      baseURL: this.baseURL,
      maxRetries: this.maxRetries,
      timeout: this.timeout,
      logger: this.logger,
      logLevel: this.logLevel,
      fetch: this.fetch,
      fetchOptions: this.fetchOptions,
      apiKey: this.apiKey,
      ...options,
    });
    return client;
  }

  /**
   * Check whether the base URL is set to its default.
   */
  #baseURLOverridden(): boolean {
    return this.baseURL !== 'https://api.relayapi.dev';
  }

  protected defaultQuery(): Record<string, string | undefined> | undefined {
    return this._options.defaultQuery;
  }

  protected validateHeaders({ values, nulls }: NullableHeaders) {
    return;
  }

  protected async authHeaders(opts: FinalRequestOptions): Promise<NullableHeaders | undefined> {
    return buildHeaders([{ Authorization: `Bearer ${this.apiKey}` }]);
  }

  /**
   * Basic re-implementation of `qs.stringify` for primitive types.
   */
  protected stringifyQuery(query: object | Record<string, unknown>): string {
    return stringifyQuery(query);
  }

  private getUserAgent(): string {
    return `${this.constructor.name}/JS ${VERSION}`;
  }

  protected defaultIdempotencyKey(): string {
    return `stainless-node-retry-${uuid4()}`;
  }

  protected makeStatusError(
    status: number,
    error: Object,
    message: string | undefined,
    headers: Headers,
  ): Errors.APIError {
    return Errors.APIError.generate(status, error, message, headers);
  }

  buildURL(
    path: string,
    query: Record<string, unknown> | null | undefined,
    defaultBaseURL?: string | undefined,
  ): string {
    const baseURL = (!this.#baseURLOverridden() && defaultBaseURL) || this.baseURL;
    const url =
      isAbsoluteURL(path) ?
        new URL(path)
      : new URL(baseURL + (baseURL.endsWith('/') && path.startsWith('/') ? path.slice(1) : path));

    const defaultQuery = this.defaultQuery();
    const pathQuery = Object.fromEntries(url.searchParams);
    if (!isEmptyObj(defaultQuery) || !isEmptyObj(pathQuery)) {
      query = { ...pathQuery, ...defaultQuery, ...query };
    }

    if (typeof query === 'object' && query && !Array.isArray(query)) {
      url.search = this.stringifyQuery(query);
    }

    return url.toString();
  }

  /**
   * Used as a callback for mutating the given `FinalRequestOptions` object.
   */
  protected async prepareOptions(options: FinalRequestOptions): Promise<void> {}

  /**
   * Used as a callback for mutating the given `RequestInit` object.
   *
   * This is useful for cases where you want to add certain headers based off of
   * the request properties, e.g. `method` or `url`.
   */
  protected async prepareRequest(
    request: RequestInit,
    { url, options }: { url: string; options: FinalRequestOptions },
  ): Promise<void> {}

  get<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp> {
    return this.methodRequest('get', path, opts);
  }

  post<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp> {
    return this.methodRequest('post', path, opts);
  }

  patch<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp> {
    return this.methodRequest('patch', path, opts);
  }

  put<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp> {
    return this.methodRequest('put', path, opts);
  }

  delete<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp> {
    return this.methodRequest('delete', path, opts);
  }

  private methodRequest<Rsp>(
    method: HTTPMethod,
    path: string,
    opts?: PromiseOrValue<RequestOptions>,
  ): APIPromise<Rsp> {
    return this.request(
      Promise.resolve(opts).then((opts) => {
        return { method, path, ...opts };
      }),
    );
  }

  request<Rsp>(
    options: PromiseOrValue<FinalRequestOptions>,
    remainingRetries: number | null = null,
  ): APIPromise<Rsp> {
    return new APIPromise(this, this.makeRequest(options, remainingRetries, undefined));
  }

  private async makeRequest(
    optionsInput: PromiseOrValue<FinalRequestOptions>,
    retriesRemaining: number | null,
    retryOfRequestLogID: string | undefined,
  ): Promise<APIResponseProps> {
    const options = await optionsInput;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    if (retriesRemaining == null) {
      retriesRemaining = maxRetries;
    }

    await this.prepareOptions(options);

    const { req, url, timeout } = await this.buildRequest(options, {
      retryCount: maxRetries - retriesRemaining,
    });

    await this.prepareRequest(req, { url, options });

    /** Not an API request ID, just for correlating local log entries. */
    const requestLogID = 'log_' + ((Math.random() * (1 << 24)) | 0).toString(16).padStart(6, '0');
    const retryLogStr = retryOfRequestLogID === undefined ? '' : `, retryOf: ${retryOfRequestLogID}`;
    const startTime = Date.now();

    loggerFor(this).debug(
      `[${requestLogID}] sending request`,
      formatRequestDetails({
        retryOfRequestLogID,
        method: options.method,
        url,
        options,
        headers: req.headers,
      }),
    );

    if (options.signal?.aborted) {
      throw new Errors.APIUserAbortError();
    }

    const controller = new AbortController();
    const response = await this.fetchWithTimeout(url, req, timeout, controller).catch(castToError);
    const headersTime = Date.now();

    if (response instanceof globalThis.Error) {
      const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
      if (options.signal?.aborted) {
        throw new Errors.APIUserAbortError();
      }
      // detect native connection timeout errors
      // deno throws "TypeError: error sending request for url (https://example/): client error (Connect): tcp connect error: Operation timed out (os error 60): Operation timed out (os error 60)"
      // undici throws "TypeError: fetch failed" with cause "ConnectTimeoutError: Connect Timeout Error (attempted address: example:443, timeout: 1ms)"
      // others do not provide enough information to distinguish timeouts from other connection errors
      const isTimeout =
        isAbortError(response) ||
        /timed? ?out/i.test(String(response) + ('cause' in response ? String(response.cause) : ''));
      if (retriesRemaining) {
        loggerFor(this).info(
          `[${requestLogID}] connection ${isTimeout ? 'timed out' : 'failed'} - ${retryMessage}`,
        );
        loggerFor(this).debug(
          `[${requestLogID}] connection ${isTimeout ? 'timed out' : 'failed'} (${retryMessage})`,
          formatRequestDetails({
            retryOfRequestLogID,
            url,
            durationMs: headersTime - startTime,
            message: response.message,
          }),
        );
        return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID);
      }
      loggerFor(this).info(
        `[${requestLogID}] connection ${isTimeout ? 'timed out' : 'failed'} - error; no more retries left`,
      );
      loggerFor(this).debug(
        `[${requestLogID}] connection ${isTimeout ? 'timed out' : 'failed'} (error; no more retries left)`,
        formatRequestDetails({
          retryOfRequestLogID,
          url,
          durationMs: headersTime - startTime,
          message: response.message,
        }),
      );
      if (isTimeout) {
        throw new Errors.APIConnectionTimeoutError();
      }
      throw new Errors.APIConnectionError({ cause: response });
    }

    const responseInfo = `[${requestLogID}${retryLogStr}] ${req.method} ${url} ${
      response.ok ? 'succeeded' : 'failed'
    } with status ${response.status} in ${headersTime - startTime}ms`;

    if (!response.ok) {
      const shouldRetry = await this.shouldRetry(response);
      if (retriesRemaining && shouldRetry) {
        const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;

        // We don't need the body of this response.
        await Shims.CancelReadableStream(response.body);
        loggerFor(this).info(`${responseInfo} - ${retryMessage}`);
        loggerFor(this).debug(
          `[${requestLogID}] response error (${retryMessage})`,
          formatRequestDetails({
            retryOfRequestLogID,
            url: response.url,
            status: response.status,
            headers: response.headers,
            durationMs: headersTime - startTime,
          }),
        );
        return this.retryRequest(
          options,
          retriesRemaining,
          retryOfRequestLogID ?? requestLogID,
          response.headers,
        );
      }

      const retryMessage = shouldRetry ? `error; no more retries left` : `error; not retryable`;

      loggerFor(this).info(`${responseInfo} - ${retryMessage}`);

      const errText = await response.text().catch((err: any) => castToError(err).message);
      const errJSON = safeJSON(errText) as any;
      const errMessage = errJSON ? undefined : errText;

      loggerFor(this).debug(
        `[${requestLogID}] response error (${retryMessage})`,
        formatRequestDetails({
          retryOfRequestLogID,
          url: response.url,
          status: response.status,
          headers: response.headers,
          message: errMessage,
          durationMs: Date.now() - startTime,
        }),
      );

      const err = this.makeStatusError(response.status, errJSON, errMessage, response.headers);
      throw err;
    }

    loggerFor(this).info(responseInfo);
    loggerFor(this).debug(
      `[${requestLogID}] response start`,
      formatRequestDetails({
        retryOfRequestLogID,
        url: response.url,
        status: response.status,
        headers: response.headers,
        durationMs: headersTime - startTime,
      }),
    );

    return { response, options, controller, requestLogID, retryOfRequestLogID, startTime };
  }

  async fetchWithTimeout(
    url: RequestInfo,
    init: RequestInit | undefined,
    ms: number,
    controller: AbortController,
  ): Promise<Response> {
    const { signal, method, ...options } = init || {};
    const abort = this._makeAbort(controller);
    if (signal) signal.addEventListener('abort', abort, { once: true });

    const timeout = setTimeout(abort, ms);

    const isReadableBody =
      ((globalThis as any).ReadableStream && options.body instanceof (globalThis as any).ReadableStream) ||
      (typeof options.body === 'object' && options.body !== null && Symbol.asyncIterator in options.body);

    const fetchOptions: RequestInit = {
      signal: controller.signal as any,
      ...(isReadableBody ? { duplex: 'half' } : {}),
      method: 'GET',
      ...options,
    };
    if (method) {
      // Custom methods like 'patch' need to be uppercased
      // See https://github.com/nodejs/undici/issues/2294
      fetchOptions.method = method.toUpperCase();
    }

    try {
      // use undefined this binding; fetch errors if bound to something else in browser/cloudflare
      return await this.fetch.call(undefined, url, fetchOptions);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async shouldRetry(response: Response): Promise<boolean> {
    // Note this is not a standard header.
    const shouldRetryHeader = response.headers.get('x-should-retry');

    // If the server explicitly says whether or not to retry, obey.
    if (shouldRetryHeader === 'true') return true;
    if (shouldRetryHeader === 'false') return false;

    // Retry on request timeouts.
    if (response.status === 408) return true;

    // Retry on lock timeouts.
    if (response.status === 409) return true;

    // Retry on rate limits.
    if (response.status === 429) return true;

    // Retry internal errors.
    if (response.status >= 500) return true;

    return false;
  }

  private async retryRequest(
    options: FinalRequestOptions,
    retriesRemaining: number,
    requestLogID: string,
    responseHeaders?: Headers | undefined,
  ): Promise<APIResponseProps> {
    let timeoutMillis: number | undefined;

    // Note the `retry-after-ms` header may not be standard, but is a good idea and we'd like proactive support for it.
    const retryAfterMillisHeader = responseHeaders?.get('retry-after-ms');
    if (retryAfterMillisHeader) {
      const timeoutMs = parseFloat(retryAfterMillisHeader);
      if (!Number.isNaN(timeoutMs)) {
        timeoutMillis = timeoutMs;
      }
    }

    // About the Retry-After header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After
    const retryAfterHeader = responseHeaders?.get('retry-after');
    if (retryAfterHeader && !timeoutMillis) {
      const timeoutSeconds = parseFloat(retryAfterHeader);
      if (!Number.isNaN(timeoutSeconds)) {
        timeoutMillis = timeoutSeconds * 1000;
      } else {
        timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
      }
    }

    // If the API asks us to wait a certain amount of time, just do what it
    // says, but otherwise calculate a default
    if (timeoutMillis === undefined) {
      const maxRetries = options.maxRetries ?? this.maxRetries;
      timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
    }
    await sleep(timeoutMillis);

    return this.makeRequest(options, retriesRemaining - 1, requestLogID);
  }

  private calculateDefaultRetryTimeoutMillis(retriesRemaining: number, maxRetries: number): number {
    const initialRetryDelay = 0.5;
    const maxRetryDelay = 8.0;

    const numRetries = maxRetries - retriesRemaining;

    // Apply exponential backoff, but not more than the max.
    const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay);

    // Apply some jitter, take up to at most 25 percent of the retry time.
    const jitter = 1 - Math.random() * 0.25;

    return sleepSeconds * jitter * 1000;
  }

  async buildRequest(
    inputOptions: FinalRequestOptions,
    { retryCount = 0 }: { retryCount?: number } = {},
  ): Promise<{ req: FinalizedRequestInit; url: string; timeout: number }> {
    const options = { ...inputOptions };
    const { method, path, query, defaultBaseURL } = options;

    const url = this.buildURL(path!, query as Record<string, unknown>, defaultBaseURL);
    if ('timeout' in options) validatePositiveInteger('timeout', options.timeout);
    options.timeout = options.timeout ?? this.timeout;
    const { bodyHeaders, body } = this.buildBody({ options });
    const reqHeaders = await this.buildHeaders({ options: inputOptions, method, bodyHeaders, retryCount });

    const req: FinalizedRequestInit = {
      method,
      headers: reqHeaders,
      ...(options.signal && { signal: options.signal }),
      ...((globalThis as any).ReadableStream &&
        body instanceof (globalThis as any).ReadableStream && { duplex: 'half' }),
      ...(body && { body }),
      ...((this.fetchOptions as any) ?? {}),
      ...((options.fetchOptions as any) ?? {}),
    };

    return { req, url, timeout: options.timeout };
  }

  private async buildHeaders({
    options,
    method,
    bodyHeaders,
    retryCount,
  }: {
    options: FinalRequestOptions;
    method: HTTPMethod;
    bodyHeaders: HeadersLike;
    retryCount: number;
  }): Promise<Headers> {
    let idempotencyHeaders: HeadersLike = {};
    if (this.idempotencyHeader && method !== 'get') {
      if (!options.idempotencyKey) options.idempotencyKey = this.defaultIdempotencyKey();
      idempotencyHeaders[this.idempotencyHeader] = options.idempotencyKey;
    }

    const headers = buildHeaders([
      idempotencyHeaders,
      {
        Accept: 'application/json',
        'User-Agent': this.getUserAgent(),
        'X-Stainless-Retry-Count': String(retryCount),
        ...(options.timeout ? { 'X-Stainless-Timeout': String(Math.trunc(options.timeout / 1000)) } : {}),
        ...getPlatformHeaders(),
      },
      await this.authHeaders(options),
      this._options.defaultHeaders,
      bodyHeaders,
      options.headers,
    ]);

    this.validateHeaders(headers);

    return headers.values;
  }

  private _makeAbort(controller: AbortController) {
    // note: we can't just inline this method inside `fetchWithTimeout()` because then the closure
    //       would capture all request options, and cause a memory leak.
    return () => controller.abort();
  }

  private buildBody({ options: { body, headers: rawHeaders } }: { options: FinalRequestOptions }): {
    bodyHeaders: HeadersLike;
    body: BodyInit | undefined;
  } {
    if (!body) {
      return { bodyHeaders: undefined, body: undefined };
    }
    const headers = buildHeaders([rawHeaders]);
    if (
      // Pass raw type verbatim
      ArrayBuffer.isView(body) ||
      body instanceof ArrayBuffer ||
      body instanceof DataView ||
      (typeof body === 'string' &&
        // Preserve legacy string encoding behavior for now
        headers.values.has('content-type')) ||
      // `Blob` is superset of `File`
      ((globalThis as any).Blob && body instanceof (globalThis as any).Blob) ||
      // `FormData` -> `multipart/form-data`
      body instanceof FormData ||
      // `URLSearchParams` -> `application/x-www-form-urlencoded`
      body instanceof URLSearchParams ||
      // Send chunked stream (each chunk has own `length`)
      ((globalThis as any).ReadableStream && body instanceof (globalThis as any).ReadableStream)
    ) {
      return { bodyHeaders: undefined, body: body as BodyInit };
    } else if (
      typeof body === 'object' &&
      (Symbol.asyncIterator in body ||
        (Symbol.iterator in body && 'next' in body && typeof body.next === 'function'))
    ) {
      return { bodyHeaders: undefined, body: Shims.ReadableStreamFrom(body as AsyncIterable<Uint8Array>) };
    } else if (
      typeof body === 'object' &&
      headers.values.get('content-type') === 'application/x-www-form-urlencoded'
    ) {
      return {
        bodyHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
        body: this.stringifyQuery(body),
      };
    } else {
      return this.#encoder({ body, headers });
    }
  }

  static Relay = this;
  static DEFAULT_TIMEOUT = 60000; // 1 minute

  static RelayError = Errors.RelayError;
  static APIError = Errors.APIError;
  static APIConnectionError = Errors.APIConnectionError;
  static APIConnectionTimeoutError = Errors.APIConnectionTimeoutError;
  static APIUserAbortError = Errors.APIUserAbortError;
  static NotFoundError = Errors.NotFoundError;
  static ConflictError = Errors.ConflictError;
  static RateLimitError = Errors.RateLimitError;
  static BadRequestError = Errors.BadRequestError;
  static AuthenticationError = Errors.AuthenticationError;
  static InternalServerError = Errors.InternalServerError;
  static PermissionDeniedError = Errors.PermissionDeniedError;
  static UnprocessableEntityError = Errors.UnprocessableEntityError;

  static toFile = Uploads.toFile;

  ads: API.Ads = new API.Ads(this);
  autoPostRules: API.AutoPostRules = new API.AutoPostRules(this);
  broadcasts: API.Broadcasts = new API.Broadcasts(this);
  automations: API.Automations = new API.Automations(this);
  segments: API.Segments = new API.Segments(this);
  aiKnowledge: API.AiKnowledge = new API.AiKnowledge(this);
  refUrls: API.RefUrls = new API.RefUrls(this);
  shortLinks: API.ShortLinks = new API.ShortLinks(this);
  contentTemplates: API.ContentTemplates = new API.ContentTemplates(this);
  tags: API.Tags = new API.Tags(this);
  ideaGroups: API.IdeaGroups = new API.IdeaGroups(this);
  ideas: API.Ideas = new API.Ideas(this);
  crossPostActions: API.CrossPostActions = new API.CrossPostActions(this);
  posts: API.Posts = new API.Posts(this);
  accounts: API.Accounts = new API.Accounts(this);
  media: API.Media = new API.Media(this);
  webhooks: API.Webhooks = new API.Webhooks(this);
  apiKeys: API.APIKeys = new API.APIKeys(this);
  inviteTokens: API.InviteTokens = new API.InviteTokens(this);
  streaks: API.Streaks = new API.Streaks(this);
  usage: API.Usage = new API.Usage(this);
  orgSettings: API.OrgSettings = new API.OrgSettings(this);
  workspaces: API.Workspaces = new API.Workspaces(this);
  connect: API.Connect = new API.Connect(this);
  connections: API.Connections = new API.Connections(this);
  analytics: API.Analytics = new API.Analytics(this);
  tools: API.Tools = new API.Tools(this);
  queue: API.Queue = new API.Queue(this);
  threads: API.Threads = new API.Threads(this);
  twitter: API.Twitter = new API.Twitter(this);
  inbox: API.Inbox = new API.Inbox(this);
  reddit: API.Reddit = new API.Reddit(this);
  signatures: API.Signatures = new API.Signatures(this);
  contacts: API.Contacts = new API.Contacts(this);
  whatsapp: API.Whatsapp = new API.Whatsapp(this);
  wsTicket: API.WsTicket = new API.WsTicket(this);
}

Relay.Ads = Ads;
Relay.AutoPostRules = AutoPostRules;
Relay.Broadcasts = Broadcasts;
Relay.Automations = Automations;
Relay.Segments = Segments;
Relay.AiKnowledge = AiKnowledge;
Relay.RefUrls = RefUrls;
Relay.ContentTemplates = ContentTemplates;
Relay.Tags = Tags;
Relay.IdeaGroups = IdeaGroups;
Relay.Ideas = Ideas;
Relay.CrossPostActions = CrossPostActions;
Relay.Posts = Posts;
Relay.Accounts = Accounts;
Relay.Media = Media;
Relay.Webhooks = Webhooks;
Relay.APIKeys = APIKeys;
Relay.InviteTokens = InviteTokens;
Relay.Streaks = Streaks;
Relay.Usage = Usage;
Relay.Workspaces = Workspaces;
Relay.Connect = Connect;
Relay.Connections = Connections;
Relay.Analytics = Analytics;
Relay.Tools = Tools;
Relay.Queue = Queue;
Relay.Threads = Threads;
Relay.Twitter = Twitter;
Relay.Inbox = Inbox;
Relay.Reddit = Reddit;
Relay.ShortLinks = ShortLinks;
Relay.Signatures = Signatures;
Relay.Contacts = Contacts;
Relay.Whatsapp = Whatsapp;
Relay.WsTicket = WsTicket;

export declare namespace Relay {
  export type RequestOptions = Opts.RequestOptions;

  export {
    Ads as Ads,
    type AdAccountResponse as AdAccountResponse,
    type AdAccountListResponse as AdAccountListResponse,
    type AdCampaignResponse as AdCampaignResponse,
    type AdCampaignListResponse as AdCampaignListResponse,
    type AdResponse as AdResponse,
    type AdListResponse as AdListResponse,
    type AdAnalyticsResponse as AdAnalyticsResponse,
    type AdInterestResponse as AdInterestResponse,
    type AdInterestListResponse as AdInterestListResponse,
    type AdAudienceResponse as AdAudienceResponse,
    type AdAudienceListResponse as AdAudienceListResponse,
    type AdAddAudienceUsersResponse as AdAddAudienceUsersResponse,
    type AdUpdateCampaignResponse as AdUpdateCampaignResponse,
    type AdSyncResponse as AdSyncResponse,
    type AdListAccountsParams as AdListAccountsParams,
    type AdCreateCampaignParams as AdCreateCampaignParams,
    type AdUpdateCampaignParams as AdUpdateCampaignParams,
    type AdListCampaignsParams as AdListCampaignsParams,
    type AdCreateParams as AdCreateParams,
    type AdBoostParams as AdBoostParams,
    type AdUpdateParams as AdUpdateParams,
    type AdListParams as AdListParams,
    type AdGetAnalyticsParams as AdGetAnalyticsParams,
    type AdSearchInterestsParams as AdSearchInterestsParams,
    type AdCreateAudienceParams as AdCreateAudienceParams,
    type AdListAudiencesParams as AdListAudiencesParams,
    type AdAddAudienceUsersParams as AdAddAudienceUsersParams,
  };

  export {
    AutoPostRules as AutoPostRules,
    type AutoPostRuleResponse as AutoPostRuleResponse,
    type AutoPostRuleListResponse as AutoPostRuleListResponse,
    type AutoPostRuleCreateParams as AutoPostRuleCreateParams,
    type AutoPostRuleUpdateParams as AutoPostRuleUpdateParams,
    type AutoPostRuleListParams as AutoPostRuleListParams,
    type AutoPostRuleTestFeedParams as AutoPostRuleTestFeedParams,
    type AutoPostRuleTestFeedResponse as AutoPostRuleTestFeedResponse,
  };

  export {
    Broadcasts as Broadcasts,
    type BroadcastResponse as BroadcastResponse,
    type BroadcastListResponse as BroadcastListResponse,
    type BroadcastAddRecipientsResponse as BroadcastAddRecipientsResponse,
    type BroadcastRecipientResponse as BroadcastRecipientResponse,
    type BroadcastListRecipientsResponse as BroadcastListRecipientsResponse,
    type BroadcastCreateParams as BroadcastCreateParams,
    type BroadcastUpdateParams as BroadcastUpdateParams,
    type BroadcastListParams as BroadcastListParams,
    type BroadcastAddRecipientsParams as BroadcastAddRecipientsParams,
    type BroadcastScheduleParams as BroadcastScheduleParams,
    type BroadcastListRecipientsParams as BroadcastListRecipientsParams,
  };

  export {
    Automations as Automations,
    AutomationTemplates as AutomationTemplates,
    type AutomationResponse as AutomationResponse,
    type AutomationNodeResponse as AutomationNodeResponse,
    type AutomationEdgeResponse as AutomationEdgeResponse,
    type AutomationWithGraphResponse as AutomationWithGraphResponse,
    type AutomationListResponse as AutomationListResponse,
    type AutomationEnrollmentResponse as AutomationEnrollmentResponse,
    type AutomationEnrollmentListResponse as AutomationEnrollmentListResponse,
    type AutomationRunLogResponse as AutomationRunLogResponse,
    type AutomationRunListResponse as AutomationRunListResponse,
    type AutomationSchemaResponse as AutomationSchemaResponse,
    type AutomationCreateParams as AutomationCreateParams,
    type AutomationUpdateParams as AutomationUpdateParams,
    type AutomationListParams as AutomationListParams,
    type AutomationListEnrollmentsParams as AutomationListEnrollmentsParams,
    type AutomationTriggerSpec as AutomationTriggerSpec,
    type AutomationNodeSpec as AutomationNodeSpec,
    type AutomationEdgeSpec as AutomationEdgeSpec,
    type AutomationChannel as AutomationChannel,
    type AutomationStatus as AutomationStatus,
    type AutomationEnrollmentStatus as AutomationEnrollmentStatus,
    type CommentToDmTemplateParams as CommentToDmTemplateParams,
    type WelcomeDmTemplateParams as WelcomeDmTemplateParams,
    type KeywordReplyTemplateParams as KeywordReplyTemplateParams,
    type FollowToDmTemplateParams as FollowToDmTemplateParams,
    type StoryReplyTemplateParams as StoryReplyTemplateParams,
    type GiveawayTemplateParams as GiveawayTemplateParams,
    type AutomationSimulateParams as AutomationSimulateParams,
    type AutomationSimulateResponse as AutomationSimulateResponse,
    type AutomationSimulateStep as AutomationSimulateStep,
  };

  export {
    Segments as Segments,
    type SegmentCreateParams as SegmentCreateParams,
    type SegmentUpdateParams as SegmentUpdateParams,
    type SegmentListParams as SegmentListParams,
    type SegmentResponse as SegmentResponse,
    type SegmentListResponse as SegmentListResponse,
    type SegmentFilter as SegmentFilter,
    type SegmentFilterPredicate as SegmentFilterPredicate,
  };

  export {
    AiKnowledge as AiKnowledge,
    AiKnowledgeDocuments as AiKnowledgeDocuments,
    type KnowledgeBaseCreateParams as KnowledgeBaseCreateParams,
    type KnowledgeBaseUpdateParams as KnowledgeBaseUpdateParams,
    type KnowledgeBaseListParams as KnowledgeBaseListParams,
    type KnowledgeBaseResponse as KnowledgeBaseResponse,
    type KnowledgeBaseListResponse as KnowledgeBaseListResponse,
    type KnowledgeDocumentCreateParams as KnowledgeDocumentCreateParams,
    type KnowledgeDocumentListParams as KnowledgeDocumentListParams,
    type KnowledgeDocumentResponse as KnowledgeDocumentResponse,
    type KnowledgeDocumentListResponse as KnowledgeDocumentListResponse,
  };

  export {
    RefUrls as RefUrls,
    type RefUrlCreateParams as RefUrlCreateParams,
    type RefUrlUpdateParams as RefUrlUpdateParams,
    type RefUrlListParams as RefUrlListParams,
    type RefUrlResponse as RefUrlResponse,
    type RefUrlListResponse as RefUrlListResponse,
  };

  export {
    CrossPostActions as CrossPostActions,
    type CrossPostActionResponse as CrossPostActionResponse,
    type CrossPostActionListResponse as CrossPostActionListResponse,
    type CrossPostActionInput as CrossPostActionInput,
    type CrossPostActionListParams as CrossPostActionListParams,
  };

  export {
    ContentTemplates as ContentTemplates,
    type ContentTemplateCreateResponse as ContentTemplateCreateResponse,
    type ContentTemplateUpdateResponse as ContentTemplateUpdateResponse,
    type ContentTemplateGetResponse as ContentTemplateGetResponse,
    type ContentTemplateListResponse as ContentTemplateListResponse,
    type ContentTemplateCreateParams as ContentTemplateCreateParams,
    type ContentTemplateUpdateParams as ContentTemplateUpdateParams,
    type ContentTemplateListParams as ContentTemplateListParams,
  };

  export {
    Tags as Tags,
    type TagResponse as TagResponse,
    type TagCreateResponse as TagCreateResponse,
    type TagUpdateResponse as TagUpdateResponse,
    type TagListResponse as TagListResponse,
    type TagCreateParams as TagCreateParams,
    type TagUpdateParams as TagUpdateParams,
    type TagListParams as TagListParams,
  };

  export {
    IdeaGroups as IdeaGroups,
    type IdeaGroupResponse as IdeaGroupResponse,
    type IdeaGroupCreateResponse as IdeaGroupCreateResponse,
    type IdeaGroupUpdateResponse as IdeaGroupUpdateResponse,
    type IdeaGroupListResponse as IdeaGroupListResponse,
    type IdeaGroupCreateParams as IdeaGroupCreateParams,
    type IdeaGroupUpdateParams as IdeaGroupUpdateParams,
    type IdeaGroupListParams as IdeaGroupListParams,
    type IdeaGroupReorderParams as IdeaGroupReorderParams,
  };

  export {
    Ideas as Ideas,
    type IdeaMediaResponse as IdeaMediaResponse,
    type IdeaResponse as IdeaResponse,
    type IdeaListResponse as IdeaListResponse,
    type IdeaConvertResponse as IdeaConvertResponse,
    type IdeaCommentResponse as IdeaCommentResponse,
    type IdeaCommentListResponse as IdeaCommentListResponse,
    type IdeaActivityResponse as IdeaActivityResponse,
    type IdeaActivityListResponse as IdeaActivityListResponse,
    type IdeaListParams as IdeaListParams,
    type IdeaCreateParams as IdeaCreateParams,
    type IdeaUpdateParams as IdeaUpdateParams,
    type IdeaMoveParams as IdeaMoveParams,
    type IdeaConvertParams as IdeaConvertParams,
    type IdeaUploadMediaParams as IdeaUploadMediaParams,
    type IdeaCommentListParams as IdeaCommentListParams,
    type IdeaCommentCreateParams as IdeaCommentCreateParams,
    type IdeaCommentUpdateParams as IdeaCommentUpdateParams,
    type IdeaActivityListParams as IdeaActivityListParams,
  };

  export {
    Posts as Posts,
    type PostCreateResponse as PostCreateResponse,
    type PostRetrieveResponse as PostRetrieveResponse,
    type PostUpdateResponse as PostUpdateResponse,
    type PostListResponse as PostListResponse,
    type PostBulkCreateResponse as PostBulkCreateResponse,
    type PostRetryResponse as PostRetryResponse,
    type PostUnpublishResponse as PostUnpublishResponse,
    type PostCreateParams as PostCreateParams,
    type PostUpdateParams as PostUpdateParams,
    type PostListParams as PostListParams,
    type PostBulkCreateParams as PostBulkCreateParams,
  };

  export {
    Accounts as Accounts,
    type AccountRetrieveResponse as AccountRetrieveResponse,
    type AccountUpdateResponse as AccountUpdateResponse,
    type AccountListResponse as AccountListResponse,
    type AccountSyncAllResponse as AccountSyncAllResponse,
    type AccountUpdateParams as AccountUpdateParams,
    type AccountListParams as AccountListParams,
    type AccountSyncAllParams as AccountSyncAllParams,
  };

  export {
    Media as Media,
    type MediaListResponse as MediaListResponse,
    type MediaRetrieveResponse as MediaRetrieveResponse,
    type MediaGetPresignURLResponse as MediaGetPresignURLResponse,
    type MediaUploadResponse as MediaUploadResponse,
    type MediaListParams as MediaListParams,
    type MediaGetPresignURLParams as MediaGetPresignURLParams,
    type MediaUploadParams as MediaUploadParams,
  };

  export {
    Webhooks as Webhooks,
    type WebhookCreateResponse as WebhookCreateResponse,
    type WebhookUpdateResponse as WebhookUpdateResponse,
    type WebhookListResponse as WebhookListResponse,
    type WebhookListLogsResponse as WebhookListLogsResponse,
    type WebhookSendTestResponse as WebhookSendTestResponse,
    type WebhookCreateParams as WebhookCreateParams,
    type WebhookUpdateParams as WebhookUpdateParams,
    type WebhookListParams as WebhookListParams,
    type WebhookListLogsParams as WebhookListLogsParams,
    type WebhookSendTestParams as WebhookSendTestParams,
  };

  export {
    APIKeys as APIKeys,
    type APIKeyCreateResponse as APIKeyCreateResponse,
    type APIKeyListResponse as APIKeyListResponse,
    type APIKeyCreateParams as APIKeyCreateParams,
    type APIKeyListParams as APIKeyListParams,
  };

  export {
    InviteTokens as InviteTokens,
    type InviteTokenCreateResponse as InviteTokenCreateResponse,
    type InviteTokenListResponse as InviteTokenListResponse,
    type InviteTokenCreateParams as InviteTokenCreateParams,
    type InviteTokenListParams as InviteTokenListParams,
  };

  export { Streaks as Streaks, type StreakRetrieveResponse as StreakRetrieveResponse };

  export {
    Usage as Usage,
    type UsageRetrieveResponse as UsageRetrieveResponse,
    type UsageListLogsResponse as UsageListLogsResponse,
    type UsageListLogsParams as UsageListLogsParams,
  };

  export {
    WsTicket as WsTicket,
    type WsTicketRetrieveResponse as WsTicketRetrieveResponse,
  };

  export {
    OrgSettings as OrgSettings,
    type OrgSettingsData as OrgSettingsData,
    type OrgSettingsRetrieveResponse as OrgSettingsRetrieveResponse,
    type OrgSettingsUpdateResponse as OrgSettingsUpdateResponse,
    type OrgSettingsUpdateParams as OrgSettingsUpdateParams,
  };

  export {
    Workspaces as Workspaces,
    type WorkspaceCreateResponse as WorkspaceCreateResponse,
    type WorkspaceUpdateResponse as WorkspaceUpdateResponse,
    type WorkspaceListResponse as WorkspaceListResponse,
    type WorkspaceCreateParams as WorkspaceCreateParams,
    type WorkspaceUpdateParams as WorkspaceUpdateParams,
  };

  export {
    Connect as Connect,
    type ConnectCompleteOAuthCallbackResponse as ConnectCompleteOAuthCallbackResponse,
    type ConnectCreateBlueskyConnectionResponse as ConnectCreateBlueskyConnectionResponse,
    type ConnectFetchPendingDataResponse as ConnectFetchPendingDataResponse,
    type ConnectStartOAuthFlowResponse as ConnectStartOAuthFlowResponse,
    type ConnectCompleteOAuthCallbackParams as ConnectCompleteOAuthCallbackParams,
    type ConnectCreateBlueskyConnectionParams as ConnectCreateBlueskyConnectionParams,
    type ConnectFetchPendingDataParams as ConnectFetchPendingDataParams,
    type ConnectStartOAuthFlowParams as ConnectStartOAuthFlowParams,
  };

  export {
    Connections as Connections,
    type ConnectionListLogsResponse as ConnectionListLogsResponse,
    type ConnectionListLogsParams as ConnectionListLogsParams,
  };

  export {
    Analytics as Analytics,
    type AnalyticsRetrieveResponse as AnalyticsRetrieveResponse,
    type AnalyticsGetBestTimeResponse as AnalyticsGetBestTimeResponse,
    type AnalyticsGetContentDecayResponse as AnalyticsGetContentDecayResponse,
    type AnalyticsGetPostTimelineResponse as AnalyticsGetPostTimelineResponse,
    type AnalyticsGetPostingFrequencyResponse as AnalyticsGetPostingFrequencyResponse,
    type AnalyticsListDailyMetricsResponse as AnalyticsListDailyMetricsResponse,
    type AnalyticsListChannelsResponse as AnalyticsListChannelsResponse,
    type AnalyticsGetPlatformOverviewResponse as AnalyticsGetPlatformOverviewResponse,
    type AnalyticsListPlatformPostsResponse as AnalyticsListPlatformPostsResponse,
    type AnalyticsGetPlatformAudienceResponse as AnalyticsGetPlatformAudienceResponse,
    type AnalyticsGetPlatformDailyResponse as AnalyticsGetPlatformDailyResponse,
    type AnalyticsRetrieveParams as AnalyticsRetrieveParams,
    type AnalyticsGetBestTimeParams as AnalyticsGetBestTimeParams,
    type AnalyticsGetContentDecayParams as AnalyticsGetContentDecayParams,
    type AnalyticsGetPostTimelineParams as AnalyticsGetPostTimelineParams,
    type AnalyticsGetPostingFrequencyParams as AnalyticsGetPostingFrequencyParams,
    type AnalyticsListDailyMetricsParams as AnalyticsListDailyMetricsParams,
    type AnalyticsListChannelsParams as AnalyticsListChannelsParams,
    type AnalyticsGetPlatformOverviewParams as AnalyticsGetPlatformOverviewParams,
    type AnalyticsListPlatformPostsParams as AnalyticsListPlatformPostsParams,
    type AnalyticsGetPlatformAudienceParams as AnalyticsGetPlatformAudienceParams,
    type AnalyticsGetPlatformDailyParams as AnalyticsGetPlatformDailyParams,
  };

  export { Tools as Tools };

  export {
    Queue as Queue,
    type QueueGetNextSlotResponse as QueueGetNextSlotResponse,
    type QueuePreviewResponse as QueuePreviewResponse,
    type QueuePreviewParams as QueuePreviewParams,
    type QueueFindSlotParams as QueueFindSlotParams,
    type QueueFindSlotResponse as QueueFindSlotResponse,
  };

  export {
    Threads as Threads,
    type ThreadCreateParams as ThreadCreateParams,
    type ThreadResponse as ThreadResponse,
    type ThreadListParams as ThreadListParams,
    type ThreadListResponse as ThreadListResponse,
  };

  export { Twitter as Twitter };

  export { Inbox as Inbox };

  export {
    Reddit as Reddit,
    type RedditGetFeedResponse as RedditGetFeedResponse,
    type RedditSearchResponse as RedditSearchResponse,
    type RedditGetFeedParams as RedditGetFeedParams,
    type RedditSearchParams as RedditSearchParams,
  };

  export {
    ShortLinks as ShortLinks,
    type ShortLinkConfigResponse as ShortLinkConfigResponse,
    type ShortLinkTestResponse as ShortLinkTestResponse,
    type ShortLinkResponse as ShortLinkResponse,
    type ShortLinkListResponse as ShortLinkListResponse,
    type ShortLinkListByPostResponse as ShortLinkListByPostResponse,
    type ShortLinkShortenResponse as ShortLinkShortenResponse,
    type ShortLinkStatsResponse as ShortLinkStatsResponse,
    type ShortLinkUpdateConfigParams as ShortLinkUpdateConfigParams,
    type ShortLinkListParams as ShortLinkListParams,
    type ShortLinkShortenParams as ShortLinkShortenParams,
  };

  export {
    Signatures as Signatures,
    type SignatureCreateResponse as SignatureCreateResponse,
    type SignatureUpdateResponse as SignatureUpdateResponse,
    type SignatureGetResponse as SignatureGetResponse,
    type SignatureGetDefaultResponse as SignatureGetDefaultResponse,
    type SignatureSetDefaultResponse as SignatureSetDefaultResponse,
    type SignatureListResponse as SignatureListResponse,
    type SignatureCreateParams as SignatureCreateParams,
    type SignatureUpdateParams as SignatureUpdateParams,
    type SignatureListParams as SignatureListParams,
  };

  export {
    Contacts as Contacts,
    type ContactChannel as ContactChannel,
    type ContactCreateResponse as ContactCreateResponse,
    type ContactRetrieveResponse as ContactRetrieveResponse,
    type ContactListResponse as ContactListResponse,
    type ContactUpdateResponse as ContactUpdateResponse,
    type ContactBulkCreateResponse as ContactBulkCreateResponse,
    type ContactBulkOperationsResponse as ContactBulkOperationsResponse,
    type ContactMergeResponse as ContactMergeResponse,
    type ContactListChannelsResponse as ContactListChannelsResponse,
    type ContactAddChannelResponse as ContactAddChannelResponse,
    type ContactSetFieldResponse as ContactSetFieldResponse,
    type ContactCreateParams as ContactCreateParams,
    type ContactListParams as ContactListParams,
    type ContactUpdateParams as ContactUpdateParams,
    type ContactBulkCreateParams as ContactBulkCreateParams,
    type ContactBulkOperationsParams as ContactBulkOperationsParams,
    type ContactMergeParams as ContactMergeParams,
    type ContactAddChannelParams as ContactAddChannelParams,
    type ContactSetFieldParams as ContactSetFieldParams,
  };

  export {
    Whatsapp as Whatsapp,
    type WhatsappBulkSendResponse as WhatsappBulkSendResponse,
    type WhatsappListPhoneNumbersResponse as WhatsappListPhoneNumbersResponse,
    type WhatsappBulkSendParams as WhatsappBulkSendParams,
    type WhatsappListPhoneNumbersParams as WhatsappListPhoneNumbersParams,
  };
}
