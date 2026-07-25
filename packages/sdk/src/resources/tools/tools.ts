// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as InstagramAPI from './instagram';
import {
  Instagram,
  InstagramCheckHashtagSafetyParams,
  InstagramCheckHashtagSafetyResponse,
} from './instagram';
import * as ValidateAPI from './validate';
import {
  Validate,
  ValidateCheckPostLengthParams,
  ValidateCheckPostLengthResponse,
  ValidateRetrieveSubredditParams,
  ValidateRetrieveSubredditResponse,
  ValidateValidateMediaParams,
  ValidateValidateMediaResponse,
  ValidateValidatePostParams,
  ValidateValidatePostResponse,
} from './validate';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Tools extends APIResource {
  validate: ValidateAPI.Validate = new ValidateAPI.Validate(this._client);
  instagram: InstagramAPI.Instagram = new InstagramAPI.Instagram(this._client);

  resolveLinkedInMention(
    body: ToolsResolveLinkedInMentionParams,
    options?: RequestOptions,
  ): APIPromise<ToolsResolveLinkedInMentionResponse> {
    return this._client.post('/v1/tools/linkedin/resolve-mention', { body, ...options });
  }

  downloadYoutube(body: ToolsDownloadParams, options?: RequestOptions): APIPromise<ToolsDownloadResponse> {
    return this._client.post('/v1/tools/youtube/download', { body, ...options });
  }

  downloadTiktok(body: ToolsDownloadParams, options?: RequestOptions): APIPromise<ToolsDownloadResponse> {
    return this._client.post('/v1/tools/tiktok/download', { body, ...options });
  }

  downloadInstagram(body: ToolsDownloadParams, options?: RequestOptions): APIPromise<ToolsDownloadResponse> {
    return this._client.post('/v1/tools/instagram/download', { body, ...options });
  }

  downloadTwitter(body: ToolsDownloadParams, options?: RequestOptions): APIPromise<ToolsDownloadResponse> {
    return this._client.post('/v1/tools/twitter/download', { body, ...options });
  }

  downloadFacebook(body: ToolsDownloadParams, options?: RequestOptions): APIPromise<ToolsDownloadResponse> {
    return this._client.post('/v1/tools/facebook/download', { body, ...options });
  }

  downloadLinkedin(body: ToolsDownloadParams, options?: RequestOptions): APIPromise<ToolsDownloadResponse> {
    return this._client.post('/v1/tools/linkedin/download', { body, ...options });
  }

  downloadBluesky(body: ToolsDownloadParams, options?: RequestOptions): APIPromise<ToolsDownloadResponse> {
    return this._client.post('/v1/tools/bluesky/download', { body, ...options });
  }

  getYoutubeTranscript(
    body: ToolsYoutubeTranscriptParams,
    options?: RequestOptions,
  ): APIPromise<ToolsYoutubeTranscriptResponse> {
    return this._client.post('/v1/tools/youtube/transcript', { body, ...options });
  }

  getJobStatus(jobID: string, options?: RequestOptions): APIPromise<ToolsJobStatusResponse> {
    return this._client.get(path`/v1/tools/jobs/${jobID}`, options);
  }

}

export type ToolsDownloadPlatform =
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'twitter'
  | 'facebook'
  | 'linkedin'
  | 'bluesky';

export interface ToolsResolveLinkedInMentionParams {
  account_id: string;
  type: 'organization' | 'person';
  vanity_name?: string;
  url?: string;
}

export interface ToolsResolveLinkedInMentionResponse {
  resolved: boolean;
  urn?: string;
  name?: string;
  mention_syntax?: string;
  error?: string;
}

export interface ToolsDownloadParams {
  url: string;
  format?: 'best' | 'audio' | '720p' | '1080p' | '4k';
}

export interface ToolsJobAcceptedResponse {
  job_id: string;
  status: 'processing';
  poll_url: string;
}

export interface ToolsDownloadResult {
  success: true;
  platform: string;
  title: string | null;
  duration: number | null;
  thumbnail: string | null;
  author: string | null;
  formats: Array<{
    format_id: string;
    ext: string;
    resolution: string | null;
    filesize: number | null;
    url: string;
  }>;
  download_url: string | null;
}

export type ToolsDownloadResponse = ToolsDownloadResult | ToolsJobAcceptedResponse;

export interface ToolsYoutubeTranscriptParams {
  url: string;
  lang?: string;
}

export interface ToolsYoutubeTranscriptResult {
  success: true;
  video_id: string;
  language: string | null;
  is_auto_generated: boolean | null;
  segments: Array<{ text: string; start: number; duration: number }>;
  full_text: string;
}

export type ToolsYoutubeTranscriptResponse = ToolsYoutubeTranscriptResult | ToolsJobAcceptedResponse;

export interface ToolsJobStatusResponse {
  job_id: string;
  status: 'processing' | 'completed' | 'failed';
  type?: 'download' | 'transcript';
  created_at?: string;
  completed_at?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  error_code?: string | null;
}

Tools.Validate = Validate;
Tools.Instagram = Instagram;

export declare namespace Tools {
  export {
    Validate as Validate,
    type ValidateCheckPostLengthResponse as ValidateCheckPostLengthResponse,
    type ValidateRetrieveSubredditResponse as ValidateRetrieveSubredditResponse,
    type ValidateValidateMediaResponse as ValidateValidateMediaResponse,
    type ValidateValidatePostResponse as ValidateValidatePostResponse,
    type ValidateCheckPostLengthParams as ValidateCheckPostLengthParams,
    type ValidateRetrieveSubredditParams as ValidateRetrieveSubredditParams,
    type ValidateValidateMediaParams as ValidateValidateMediaParams,
    type ValidateValidatePostParams as ValidateValidatePostParams,
  };

  export {
    Instagram as Instagram,
    type InstagramCheckHashtagSafetyResponse as InstagramCheckHashtagSafetyResponse,
    type InstagramCheckHashtagSafetyParams as InstagramCheckHashtagSafetyParams,
  };

  export {
    type ToolsDownloadPlatform as ToolsDownloadPlatform,
    type ToolsResolveLinkedInMentionParams as ToolsResolveLinkedInMentionParams,
    type ToolsResolveLinkedInMentionResponse as ToolsResolveLinkedInMentionResponse,
    type ToolsDownloadParams as ToolsDownloadParams,
    type ToolsJobAcceptedResponse as ToolsJobAcceptedResponse,
    type ToolsDownloadResult as ToolsDownloadResult,
    type ToolsDownloadResponse as ToolsDownloadResponse,
    type ToolsYoutubeTranscriptParams as ToolsYoutubeTranscriptParams,
    type ToolsYoutubeTranscriptResult as ToolsYoutubeTranscriptResult,
    type ToolsYoutubeTranscriptResponse as ToolsYoutubeTranscriptResponse,
    type ToolsJobStatusResponse as ToolsJobStatusResponse,
  };
}
