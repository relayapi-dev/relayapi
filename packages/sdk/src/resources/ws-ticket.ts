import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class WsTicket extends APIResource {
  /**
   * Issues a short-lived ticket the client uses to open an authenticated
   * WebSocket connection without exposing the raw API key.
   */
  retrieve(options?: RequestOptions): APIPromise<WsTicketRetrieveResponse> {
    return this._client.get('/v1/ws-ticket', options);
  }
}

export interface WsTicketRetrieveResponse {
  ticket: string;

  expires_at: string;

  ws_url: string;
}

export declare namespace WsTicket {
  export {
    type WsTicketRetrieveResponse as WsTicketRetrieveResponse,
  };
}
