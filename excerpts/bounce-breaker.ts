/**
 * EXCERPT — bounce circuit breaker decision (original module: _shared/bounce-breaker)
 *
 * What it is: the pure predicate the campaign scheduler calls before sending.
 * When it returns true, the scheduler pauses the campaign and writes a
 * high-severity row to system_alerts (see campaign-scheduler.ts).
 *
 * Removed: incident notes naming specific campaigns and their bounce counts.
 * Logic and thresholds are unchanged from the production module.
 *
 * Background: the first version tripped at >5% once a campaign had a small
 * number of recent sends. On samples that small, two unlucky bounces paused a
 * healthy campaign repeatedly. The 5% rate is kept (above a few percent the big
 * mailbox providers start filtering the shared sender) but the breaker now only
 * judges a meaningful sample with a minimum bounce count.
 */

/** Pause when recent bounces exceed this share of recent sends. */
export const BOUNCE_BREAKER_RATE = 0.05;
/** The rate is not judged until the window holds at least this many sends. */
export const BOUNCE_BREAKER_MIN_SENDS = 50;
/** ...and at least this many bounces, so 2-3 stray failures never pause a campaign. */
export const BOUNCE_BREAKER_MIN_BOUNCES = 4;

/**
 * Whether a campaign's recent bounce record should auto-pause it.
 *
 * @param recentSent - sends in the breaker window (since the later of the
 *   rolling window start and the campaign's bounce_baseline_at).
 * @param recentBounced - enrollments marked bounced in the same window.
 * @returns true only when the sample is large enough (>= MIN_SENDS sends and
 *   >= MIN_BOUNCES bounces) AND the bounce rate is strictly above RATE.
 */
export function shouldTripBounceBreaker(recentSent: number, recentBounced: number): boolean {
  if (recentSent < BOUNCE_BREAKER_MIN_SENDS) return false;
  if (recentBounced < BOUNCE_BREAKER_MIN_BOUNCES) return false;
  return recentBounced / recentSent > BOUNCE_BREAKER_RATE;
}
