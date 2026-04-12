// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as BroadcastsAPI from './broadcasts';
import {
  BroadcastCreateParams,
  BroadcastCreateResponse,
  BroadcastListParams,
  BroadcastListResponse,
  BroadcastRetrieveResponse,
  BroadcastScheduleResponse,
  BroadcastSendResponse,
  Broadcasts,
} from './broadcasts';
import * as BusinessProfileAPI from './business-profile';
import {
  BusinessProfile,
  BusinessProfileDisplayNameResponse,
  BusinessProfileGetDisplayNameParams,
  BusinessProfileRetrieveParams,
  BusinessProfileRetrieveResponse,
  BusinessProfileUpdateDisplayNameParams,
  BusinessProfileUpdateDisplayNameResponse,
  BusinessProfileUpdateParams,
  BusinessProfileUpdateResponse,
  BusinessProfileUploadPhotoParams,
  BusinessProfileUploadPhotoResponse,
} from './business-profile';
import * as FlowsAPI from './flows';
import {
  FlowCreateParams,
  FlowCreateResponse,
  FlowDeleteParams,
  FlowDeleteResponse,
  FlowDeprecateParams,
  FlowDeprecateResponse,
  FlowGetJsonParams,
  FlowGetJsonResponse,
  FlowListParams,
  FlowListResponse,
  FlowPublishParams,
  FlowPublishResponse,
  FlowResource,
  FlowRetrieveParams,
  FlowRetrieveResponse,
  FlowSendParams,
  FlowSendResponse,
  FlowUpdateParams,
  FlowUpdateResponse,
  FlowUploadJsonParams,
  FlowUploadJsonResponse,
  Flows,
} from './flows';
import * as GroupsAPI from './groups';
import { GroupCreateParams, GroupCreateResponse, GroupListParams, GroupListResponse, Groups } from './groups';
import * as PhoneNumbersAPI from './phone-numbers';
import {
  PhoneNumberListParams,
  PhoneNumberListResponse,
  PhoneNumberPurchaseParams,
  PhoneNumberPurchaseResponse,
  PhoneNumberRequestCodeParams,
  PhoneNumberRequestCodeResponse,
  PhoneNumberReleaseResponse,
  PhoneNumberResource,
  PhoneNumberRetrieveResponse,
  PhoneNumberVerifyParams,
  PhoneNumberVerifyResponse,
  PhoneNumbers,
} from './phone-numbers';
import * as TemplatesAPI from './templates';
import {
  TemplateCreateParams,
  TemplateCreateResponse,
  TemplateDeleteParams,
  TemplateListParams,
  TemplateListResponse,
  TemplateRetrieveParams,
  TemplateRetrieveResponse,
  Templates,
} from './templates';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Whatsapp extends APIResource {
  broadcasts: BroadcastsAPI.Broadcasts = new BroadcastsAPI.Broadcasts(this._client);
  templates: TemplatesAPI.Templates = new TemplatesAPI.Templates(this._client);
  groups: GroupsAPI.Groups = new GroupsAPI.Groups(this._client);
  flows: FlowsAPI.Flows = new FlowsAPI.Flows(this._client);
  businessProfile: BusinessProfileAPI.BusinessProfile = new BusinessProfileAPI.BusinessProfile(this._client);
  phoneNumbers: PhoneNumbersAPI.PhoneNumbers = new PhoneNumbersAPI.PhoneNumbers(this._client);

  /**
   * Send bulk WhatsApp messages via template
   */
  bulkSend(body: WhatsappBulkSendParams, options?: RequestOptions): APIPromise<WhatsappBulkSendResponse> {
    return this._client.post('/v1/whatsapp/bulk-send', { body, ...options });
  }

  /**
   * List registered phone numbers
   */
  listPhoneNumbers(
    query: WhatsappListPhoneNumbersParams,
    options?: RequestOptions,
  ): APIPromise<WhatsappListPhoneNumbersResponse> {
    return this._client.get('/v1/whatsapp/phone-numbers', { query, ...options });
  }
}

export interface WhatsappBulkSendResponse {
  results: Array<WhatsappBulkSendResponse.Result>;

  summary: WhatsappBulkSendResponse.Summary;
}

export namespace WhatsappBulkSendResponse {
  export interface Result {
    /**
     * Recipient phone number
     */
    phone: string;

    /**
     * Send status
     */
    status: 'sent' | 'failed';

    /**
     * Error message if failed
     */
    error?: string | null;
  }

  export interface Summary {
    /**
     * Failed count
     */
    failed: number;

    /**
     * Successfully sent count
     */
    sent: number;
  }
}

export interface WhatsappListPhoneNumbersResponse {
  data: Array<WhatsappListPhoneNumbersResponse.Data>;
}

export namespace WhatsappListPhoneNumbersResponse {
  export interface Data {
    /**
     * Phone number ID
     */
    id: string;

    /**
     * Phone number
     */
    phone_number: string;

    /**
     * Registration status
     */
    status: 'active' | 'inactive' | 'pending';

    /**
     * Display name
     */
    display_name?: string | null;
  }
}

export interface WhatsappBulkSendParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;

  /**
   * Recipients
   */
  recipients: Array<WhatsappBulkSendParams.Recipient>;

  template: WhatsappBulkSendParams.Template;
}

export namespace WhatsappBulkSendParams {
  export interface Recipient {
    /**
     * Phone number in E.164 format
     */
    phone: string;

    /**
     * Template variable substitutions
     */
    variables?: { [key: string]: string };
  }

  export interface Template {
    /**
     * Template language code
     */
    language: string;

    /**
     * Template name
     */
    name: string;

    /**
     * Template components
     */
    components?: Array<Template.Component>;
  }

  export namespace Template {
    export interface Component {
      /**
       * Component type
       */
      type: 'header' | 'body' | 'button';

      /**
       * Component parameters
       */
      parameters?: Array<{ [key: string]: unknown }>;
    }
  }
}

export interface WhatsappListPhoneNumbersParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;
}

Whatsapp.Broadcasts = Broadcasts;
Whatsapp.Templates = Templates;
Whatsapp.Groups = Groups;
Whatsapp.BusinessProfile = BusinessProfile;
Whatsapp.PhoneNumbers = PhoneNumbers;

export declare namespace Whatsapp {
  export {
    type WhatsappBulkSendResponse as WhatsappBulkSendResponse,
    type WhatsappListPhoneNumbersResponse as WhatsappListPhoneNumbersResponse,
    type WhatsappBulkSendParams as WhatsappBulkSendParams,
    type WhatsappListPhoneNumbersParams as WhatsappListPhoneNumbersParams,
  };

  export {
    Broadcasts as Broadcasts,
    type BroadcastCreateResponse as BroadcastCreateResponse,
    type BroadcastRetrieveResponse as BroadcastRetrieveResponse,
    type BroadcastListResponse as BroadcastListResponse,
    type BroadcastScheduleResponse as BroadcastScheduleResponse,
    type BroadcastSendResponse as BroadcastSendResponse,
    type BroadcastCreateParams as BroadcastCreateParams,
    type BroadcastListParams as BroadcastListParams,
  };

  export {
    Templates as Templates,
    type TemplateCreateResponse as TemplateCreateResponse,
    type TemplateRetrieveResponse as TemplateRetrieveResponse,
    type TemplateListResponse as TemplateListResponse,
    type TemplateCreateParams as TemplateCreateParams,
    type TemplateRetrieveParams as TemplateRetrieveParams,
    type TemplateListParams as TemplateListParams,
    type TemplateDeleteParams as TemplateDeleteParams,
  };

  export {
    Groups as Groups,
    type GroupCreateResponse as GroupCreateResponse,
    type GroupListResponse as GroupListResponse,
    type GroupCreateParams as GroupCreateParams,
    type GroupListParams as GroupListParams,
  };

  export {
    BusinessProfile as BusinessProfile,
    type BusinessProfileRetrieveResponse as BusinessProfileRetrieveResponse,
    type BusinessProfileUpdateResponse as BusinessProfileUpdateResponse,
    type BusinessProfileDisplayNameResponse as BusinessProfileDisplayNameResponse,
    type BusinessProfileUpdateDisplayNameResponse as BusinessProfileUpdateDisplayNameResponse,
    type BusinessProfileUploadPhotoResponse as BusinessProfileUploadPhotoResponse,
    type BusinessProfileRetrieveParams as BusinessProfileRetrieveParams,
    type BusinessProfileUpdateParams as BusinessProfileUpdateParams,
    type BusinessProfileGetDisplayNameParams as BusinessProfileGetDisplayNameParams,
    type BusinessProfileUpdateDisplayNameParams as BusinessProfileUpdateDisplayNameParams,
    type BusinessProfileUploadPhotoParams as BusinessProfileUploadPhotoParams,
  };

  export {
    Flows as Flows,
    type FlowResource as FlowResource,
    type FlowListResponse as FlowListResponse,
    type FlowCreateResponse as FlowCreateResponse,
    type FlowRetrieveResponse as FlowRetrieveResponse,
    type FlowUpdateResponse as FlowUpdateResponse,
    type FlowDeleteResponse as FlowDeleteResponse,
    type FlowPublishResponse as FlowPublishResponse,
    type FlowDeprecateResponse as FlowDeprecateResponse,
    type FlowGetJsonResponse as FlowGetJsonResponse,
    type FlowUploadJsonResponse as FlowUploadJsonResponse,
    type FlowSendResponse as FlowSendResponse,
    type FlowListParams as FlowListParams,
    type FlowCreateParams as FlowCreateParams,
    type FlowRetrieveParams as FlowRetrieveParams,
    type FlowUpdateParams as FlowUpdateParams,
    type FlowDeleteParams as FlowDeleteParams,
    type FlowPublishParams as FlowPublishParams,
    type FlowDeprecateParams as FlowDeprecateParams,
    type FlowGetJsonParams as FlowGetJsonParams,
    type FlowUploadJsonParams as FlowUploadJsonParams,
    type FlowSendParams as FlowSendParams,
  };

  export {
    PhoneNumbers as PhoneNumbers,
    type PhoneNumberResource as PhoneNumberResource,
    type PhoneNumberListResponse as PhoneNumberListResponse,
    type PhoneNumberPurchaseResponse as PhoneNumberPurchaseResponse,
    type PhoneNumberRetrieveResponse as PhoneNumberRetrieveResponse,
    type PhoneNumberRequestCodeResponse as PhoneNumberRequestCodeResponse,
    type PhoneNumberVerifyResponse as PhoneNumberVerifyResponse,
    type PhoneNumberReleaseResponse as PhoneNumberReleaseResponse,
    type PhoneNumberListParams as PhoneNumberListParams,
    type PhoneNumberPurchaseParams as PhoneNumberPurchaseParams,
    type PhoneNumberRequestCodeParams as PhoneNumberRequestCodeParams,
    type PhoneNumberVerifyParams as PhoneNumberVerifyParams,
  };
}
