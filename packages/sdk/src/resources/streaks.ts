import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class Streaks extends APIResource {
  /**
   * Returns the current posting streak status for the organization, including
   * streak length, best streak, and time remaining.
   */
  retrieve(options?: RequestOptions): APIPromise<StreakRetrieveResponse> {
    return this._client.get('/v1/streak', options);
  }
}

export interface StreakRetrieveResponse {
  /**
   * Whether there is an active posting streak
   */
  active: boolean;

  /**
   * Current streak length in days
   */
  current_streak_days: number;

  /**
   * When the current streak started
   */
  streak_started_at: string | null;

  /**
   * When the last post was published
   */
  last_post_at: string | null;

  /**
   * Longest streak ever achieved
   */
  best_streak_days: number;

  /**
   * Total number of streaks that have ended
   */
  total_streaks_broken: number;

  /**
   * Hours remaining before the current streak expires (null if no active streak)
   */
  hours_remaining: number | null;
}

export declare namespace Streaks {
  export { type StreakRetrieveResponse as StreakRetrieveResponse };
}
