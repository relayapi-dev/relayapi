// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as BoardsAPI from './boards';
import { BoardListResponse, BoardSelectParams, BoardSelectResponse, Boards } from './boards';

export class Pinterest extends APIResource {
  boards: BoardsAPI.Boards = new BoardsAPI.Boards(this._client);
}

Pinterest.Boards = Boards;

export declare namespace Pinterest {
  export {
    Boards as Boards,
    type BoardListResponse as BoardListResponse,
    type BoardSelectResponse as BoardSelectResponse,
    type BoardSelectParams as BoardSelectParams,
  };
}
