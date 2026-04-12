// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Templates extends APIResource {
  /**
   * Create a message template
   */
  create(body: TemplateCreateParams, options?: RequestOptions): APIPromise<TemplateCreateResponse> {
    return this._client.post('/v1/whatsapp/templates', { body, ...options });
  }

  /**
   * Get template details
   */
  retrieve(
    templateName: string,
    query: TemplateRetrieveParams,
    options?: RequestOptions,
  ): APIPromise<TemplateRetrieveResponse> {
    return this._client.get(path`/v1/whatsapp/templates/${templateName}`, { query, ...options });
  }

  /**
   * List message templates
   */
  list(query: TemplateListParams, options?: RequestOptions): APIPromise<TemplateListResponse> {
    return this._client.get('/v1/whatsapp/templates', { query, ...options });
  }

  /**
   * Delete a message template
   */
  delete(templateName: string, params: TemplateDeleteParams, options?: RequestOptions): APIPromise<void> {
    const { account_id } = params;
    return this._client.delete(path`/v1/whatsapp/templates/${templateName}`, {
      query: { account_id },
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface TemplateCreateResponse {
  /**
   * Template category
   */
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

  components: Array<TemplateCreateResponse.Component>;

  /**
   * Template language code
   */
  language: string;

  /**
   * Template name
   */
  name: string;

  /**
   * Approval status
   */
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
}

export namespace TemplateCreateResponse {
  export interface Component {
    /**
     * Component type
     */
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';

    buttons?: Array<Component.Button>;

    /**
     * Header format (TEXT, IMAGE, etc.)
     */
    format?: string;

    /**
     * Component text
     */
    text?: string;
  }

  export namespace Component {
    export interface Button {
      /**
       * Button text
       */
      text: string;

      /**
       * Button type
       */
      type: string;

      phone_number?: string;

      url?: string;
    }
  }
}

export interface TemplateRetrieveResponse {
  /**
   * Template category
   */
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

  components: Array<TemplateRetrieveResponse.Component>;

  /**
   * Template language code
   */
  language: string;

  /**
   * Template name
   */
  name: string;

  /**
   * Approval status
   */
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
}

export namespace TemplateRetrieveResponse {
  export interface Component {
    /**
     * Component type
     */
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';

    buttons?: Array<Component.Button>;

    /**
     * Header format (TEXT, IMAGE, etc.)
     */
    format?: string;

    /**
     * Component text
     */
    text?: string;
  }

  export namespace Component {
    export interface Button {
      /**
       * Button text
       */
      text: string;

      /**
       * Button type
       */
      type: string;

      phone_number?: string;

      url?: string;
    }
  }
}

export interface TemplateListResponse {
  data: Array<TemplateListResponse.Data>;
}

export namespace TemplateListResponse {
  export interface Data {
    /**
     * Template category
     */
    category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

    components: Array<Data.Component>;

    /**
     * Template language code
     */
    language: string;

    /**
     * Template name
     */
    name: string;

    /**
     * Approval status
     */
    status: 'APPROVED' | 'PENDING' | 'REJECTED';
  }

  export namespace Data {
    export interface Component {
      /**
       * Component type
       */
      type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';

      buttons?: Array<Component.Button>;

      /**
       * Header format (TEXT, IMAGE, etc.)
       */
      format?: string;

      /**
       * Component text
       */
      text?: string;
    }

    export namespace Component {
      export interface Button {
        /**
         * Button text
         */
        text: string;

        /**
         * Button type
         */
        type: string;

        phone_number?: string;

        url?: string;
      }
    }
  }
}

export interface TemplateCreateParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;

  /**
   * Template category
   */
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

  /**
   * Template components
   */
  components: Array<TemplateCreateParams.Component>;

  /**
   * Template language code
   */
  language: string;

  /**
   * Template name
   */
  name: string;
}

export namespace TemplateCreateParams {
  export interface Component {
    /**
     * Component type
     */
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';

    buttons?: Array<Component.Button>;

    /**
     * Header format (TEXT, IMAGE, etc.)
     */
    format?: string;

    /**
     * Component text
     */
    text?: string;
  }

  export namespace Component {
    export interface Button {
      /**
       * Button text
       */
      text: string;

      /**
       * Button type
       */
      type: string;

      phone_number?: string;

      url?: string;
    }
  }
}

export interface TemplateRetrieveParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;
}

export interface TemplateListParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;
}

export interface TemplateDeleteParams {
  /**
   * WhatsApp account ID
   */
  account_id: string;
}

export declare namespace Templates {
  export {
    type TemplateCreateResponse as TemplateCreateResponse,
    type TemplateRetrieveResponse as TemplateRetrieveResponse,
    type TemplateListResponse as TemplateListResponse,
    type TemplateCreateParams as TemplateCreateParams,
    type TemplateRetrieveParams as TemplateRetrieveParams,
    type TemplateListParams as TemplateListParams,
    type TemplateDeleteParams as TemplateDeleteParams,
  };
}
