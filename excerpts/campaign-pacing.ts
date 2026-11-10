/**
 * EXCERPT — campaign pacing (original module: _shared/campaign-pacing)
 *
 * What it is: the two pure functions the campaign scheduler uses to decide how
 * many cold emails a campaign may send on this cron tick.
 *   - fairShareCap: divides a per-user global daily cap between campaigns.
 *   - pacedRunQuota: spreads a campaign's daily allowance evenly over its send
 *     window instead of draining it in the first tick.
 *
 * Removed: incident notes naming specific campaigns and their volumes.
 * Logic is unchanged from the production module.
 *
 * Background: every campaign used to draw from one shared global pool, first
 * come first served. Campaigns run in their own timezone windows, so windows
 * that open earlier in the UTC day (Australia, UK) used the whole pool before
 * the New York window opened, and US campaigns sent close to nothing.
 */

/**
 * The most a campaign may send today under the global cap.
 *
 * @param campaignLimit - this campaign's daily_send_limit.
 * @param activeLimits - daily_send_limit of every ACTIVE campaign of the same
 *   user (including this one). Paused campaigns are excluded, so resuming one
 *   re-divides the cap automatically.
 * @param globalCap - the per-user daily ceiling (GLOBAL_DAILY_CAP).
 * @returns the campaign's guaranteed share: its own limit when all limits fit
 *   under the cap, otherwise its proportional slice (floored, minimum 1). The
 *   global cap is still enforced separately, so the minimum-1 rounding can never
 *   push total sends past it.
 */
export function fairShareCap(campaignLimit: number, activeLimits: number[], globalCap: number): number {
  if (campaignLimit <= 0) return 0;
  const total = activeLimits.reduce((sum, limit) => sum + Math.max(0, limit), 0);
  if (total <= globalCap) return campaignLimit;
  const share = Math.floor((globalCap * campaignLimit) / total);
  return Math.min(campaignLimit, Math.max(1, share));
}

/**
 * How many sends this tick may make so a campaign's allowance spreads evenly over
 * its window, instead of draining in the first hour.
 *
 * Follows a straight line from 0 at the window's start to the full allowance at
 * its end, and sends whatever brings today's total up to that line. Being measured
 * against what was actually sent, a tick that sent nothing catches up later.
 *
 * @param input.dailyAllowance This campaign's allowance today (limit and fair share applied).
 * @param input.sentToday Sends already made today.
 * @param input.remainingToday Most it may still send (also reflects the global cap).
 * @param input.minutesLeftInWindow Minutes until the window closes.
 * @param input.windowMinutes Full length of the window.
 * @param input.tickMinutes Scheduler interval.
 * @param input.runCap Sends this run may still make.
 * @param input.mailboxHourlyLeft Sends the mailbox may still make in the trailing hour.
 * @returns Sends allowed now, never negative.
 */
export function pacedRunQuota(input: {
  dailyAllowance: number;
  sentToday: number;
  remainingToday: number;
  minutesLeftInWindow: number;
  windowMinutes: number;
  tickMinutes: number;
  runCap: number;
  mailboxHourlyLeft: number;
}): number {
  const { dailyAllowance, sentToday, remainingToday, minutesLeftInWindow, windowMinutes, tickMinutes, runCap, mailboxHourlyLeft } = input;
  const totalTicks = Math.max(1, Math.ceil(windowMinutes / tickMinutes));
  const ticksElapsed = Math.floor((windowMinutes - minutesLeftInWindow) / tickMinutes) + 1;
  const dueByNow = Math.ceil((dailyAllowance * Math.min(ticksElapsed, totalTicks)) / totalTicks);
  return Math.max(0, Math.min(dueByNow - sentToday, remainingToday, runCap, mailboxHourlyLeft));
}
