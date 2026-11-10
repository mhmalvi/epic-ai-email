/**
 * EXCERPT — campaign scheduler send loop (original module: campaign-scheduler edge function)
 *
 * What it is: the per-campaign gate sequence of the Deno edge function that
 * pg_cron invokes on a short interval to send the next step of each cold-email
 * sequence. Shows, in order: send window -> bounce circuit breaker -> warm-up
 * ramp -> fair-share daily cap -> sender pinning -> mailbox backoff -> even
 * pacing -> atomic lease-based claim of each due enrollment -> rate-limit release.
 *
 * Removed (marked "... trimmed ..."): the HTTP handler wrapper, the summary
 * counters, template merge, the suppression / role-mailbox / MX checks, the
 * email-sender call and List-Unsubscribe construction, and the post-send
 * enrollment bookkeeping. Incident notes and log text naming campaigns were
 * removed. Not runnable on its own: it needs a Supabase client and the
 * project's shared modules (three of which are in this folder).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { pickSenderAccount } from "./sender-account.ts";
import { fairShareCap, pacedRunQuota } from "./campaign-pacing.ts";
import { shouldTripBounceBreaker } from "./bounce-breaker.ts";
// ... trimmed: localDayStartUtc, mailbox-backoff helpers, role-mailbox check ...
declare function localDayStartUtc(tz: string): Date;
declare function getMailboxBackoff(db: SupabaseClient, accountId: string): Promise<unknown>;
declare function isBackoffActive(backoff: unknown): boolean;
declare function sentToday(db: SupabaseClient, userId: string, since: Date, campaignId?: string): Promise<number>;

// Max send ATTEMPTS per run across all campaigns. A failed attempt counts, so a
// run that keeps failing cannot walk on down the due queue.
const MAX_SENDS_PER_RUN = 10;
// The cron interval, used to divide what is left of a window into ticks.
const TICK_MINUTES = 15;
// Most a mailbox sends in any trailing hour, across all campaigns. A backstop
// against bursts, far below Gmail's limits.
const MAILBOX_HOURLY_CAP = 12;
/** How long a claimed enrollment stays invisible to a concurrent run. Matches the
 *  cron interval, so a run killed mid-send retries on the next tick rather than
 *  stranding the row or double-sending within the same window. */
const CLAIM_LEASE_MS = 15 * 60 * 1000;
// Absolute per-user daily ceiling across all campaigns, a backstop above the
// per-campaign daily_send_limit knobs.
const GLOBAL_DAILY_CAP = 100;
// Rolling window for the breaker. A cumulative lifetime rate never recovers;
// windowing lets the rate heal once bad-list sending stops.
const BOUNCE_WINDOW_DAYS = 14;
// Warmup ramp (sends/day) by campaign age in weeks since its first send.
const WARMUP_RAMP = [5, 10, 20];

interface Campaign {
  id: string;
  user_id: string;
  name: string;
  status: string;
  daily_send_limit: number;
  send_window_start: number;
  send_window_end: number;
  timezone: string;
  warmup_enabled: boolean;
  bounce_baseline_at: string | null;
}

/** Hour, minute and weekday in an IANA timezone (falls back to UTC). */
function localClock(tz: string): { hour: number; minute: number; weekday: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "numeric", hour12: false, weekday: "short",
    }).formatToParts(new Date());
    return {
      hour: parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10),
      minute: parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10),
      weekday: parts.find((p) => p.type === "weekday")?.value ?? "Mon",
    };
  } catch {
    const now = new Date();
    return { hour: now.getUTCHours(), minute: now.getUTCMinutes(), weekday: "Mon" };
  }
}

/**
 * Spintax: "{option A|option B|option C}" picks ONE variant, deterministically
 * seeded by the recipient's email — so each recipient always sees the same
 * text (consistent threads, reproducible renders) but no two recipients get
 * an identical email. Single braces only; runs AFTER {{merge}} tokens so the
 * two syntaxes never collide.
 */
export function renderSpintax(text: string, seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  let occurrence = 0;
  return text.replace(/\{([^{}|]+(?:\|[^{}|]*)+)\}/g, (_m, group: string) => {
    const options = group.split("|");
    // Mix the occurrence index in so different spins in one email vary
    // independently, still deterministic for the same recipient.
    const pick = (h + occurrence++ * 2654435761) >>> 0;
    return options[pick % options.length].trim();
  });
}

export async function runCampaigns(supabase: SupabaseClient, campaigns: Campaign[], pinnedSender: string) {
  let sendsThisRun = 0;
  const rateLimitedMailboxes = new Set<string>();

  for (const campaign of campaigns) {
    if (sendsThisRun >= MAX_SENDS_PER_RUN) break;

    // Send window: business hours, weekdays only, campaign timezone.
    const { hour, minute, weekday } = localClock(campaign.timezone);
    if (weekday === "Sat" || weekday === "Sun" ||
        hour < campaign.send_window_start || hour >= campaign.send_window_end) {
      continue;
    }

    // Bounce circuit breaker: a spiking RECENT bounce rate means a bad list
    // segment — auto-pause before it damages sender reputation. Measured from
    // the later of the rolling window and the operator's remediation marker
    // (bounce_baseline_at), so a cleaned list is judged on post-cleanup evidence.
    const rollingStart = new Date(Date.now() - BOUNCE_WINDOW_DAYS * 86_400_000).toISOString();
    const baseline = campaign.bounce_baseline_at;
    const windowStart = baseline && baseline > rollingStart ? baseline : rollingStart;
    const [{ count: recentSent }, { count: recentBounced }, { data: firstSend }] =
      await Promise.all([
        supabase.from("campaign_sends").select("id", { count: "exact", head: true })
          .eq("campaign_id", campaign.id).eq("status", "sent")
          .gte("sent_at", windowStart),
        supabase.from("enrollments").select("id", { count: "exact", head: true })
          .eq("campaign_id", campaign.id).eq("status", "bounced")
          .gte("updated_at", windowStart),
        supabase.from("campaign_sends").select("sent_at")
          .eq("campaign_id", campaign.id).eq("status", "sent")
          .order("sent_at", { ascending: true }).limit(1),
      ]);
    if (shouldTripBounceBreaker(recentSent ?? 0, recentBounced ?? 0)) {
      await supabase.from("campaigns").update({
        status: "paused", updated_at: new Date().toISOString(),
      }).eq("id", campaign.id);
      await supabase.from("system_alerts").insert({
        alert_type: "campaign_bounce_breaker", severity: "high",
        message: `Campaign auto-paused: ${recentBounced}/${recentSent} sends bounced ` +
          `in the last ${BOUNCE_WINDOW_DAYS} days`,
        metadata: { campaign_id: campaign.id, user_id: campaign.user_id },
      });
      continue;
    }

    // Warmup ramp: young campaigns send slowly regardless of their limit.
    let effectiveLimit = campaign.daily_send_limit;
    if (campaign.warmup_enabled) {
      const firstAt = firstSend?.[0]?.sent_at;
      const weekAge = firstAt
        ? Math.floor((Date.now() - new Date(firstAt).getTime()) / (7 * 86_400_000))
        : 0;
      effectiveLimit = Math.min(effectiveLimit,
        WARMUP_RAMP[Math.min(weekAge, WARMUP_RAMP.length)] ?? effectiveLimit);
    }

    // Pacing: campaign-local day for its own limit, UTC day for the global cap.
    const [campaignSent, userSent] = await Promise.all([
      sentToday(supabase, campaign.user_id, localDayStartUtc(campaign.timezone), campaign.id),
      sentToday(supabase, campaign.user_id, localDayStartUtc("UTC")),
    ]);
    // Each campaign gets a proportional slice of the global cap, so windows
    // that open earlier in the UTC day can't starve later ones.
    const activeLimits = campaigns
      .filter((c) => c.user_id === campaign.user_id)
      .map((c) => c.daily_send_limit);
    const shareCap = fairShareCap(campaign.daily_send_limit, activeLimits, GLOBAL_DAILY_CAP);
    const quota = Math.min(
      effectiveLimit - campaignSent,
      shareCap - campaignSent,
      GLOBAL_DAILY_CAP - userSent,
      MAX_SENDS_PER_RUN - sendsThisRun,
    );
    if (quota <= 0) continue;

    // Resolve the campaign owner's sending mailbox. "Most recently updated" is
    // NOT a usable primary: hourly token refreshes reorder the accounts.
    // CAMPAIGN_SENDER_EMAIL pins the mailbox and fails closed when disconnected.
    const { data: oauthRows } = await supabase
      .from("google_oauth_webhooks")
      .select("id, google_connected_email")
      .eq("user_id", campaign.user_id)
      .in("google_connection_status", ["connected", "google_oauth"])
      .order("updated_at", { ascending: false });
    const ownerAccount = pickSenderAccount(oauthRows ?? [], pinnedSender);
    if (pinnedSender && !ownerAccount) continue;   // fail closed: skip, never fall back
    const senderAccountId = ownerAccount?.id ?? null;

    // Gmail backoff. Checked before anything is claimed, so no enrollment is
    // touched and nothing is attempted until the until-time has passed.
    const backoff = senderAccountId ? await getMailboxBackoff(supabase, senderAccountId) : null;
    if ((senderAccountId && rateLimitedMailboxes.has(senderAccountId)) || isBackoffActive(backoff)) {
      continue;
    }

    // Even pacing across the window, inside the mailbox's trailing-hour ceiling.
    const { count: mailboxLastHour } = await supabase
      .from("campaign_sends")
      .select("id", { count: "exact", head: true })
      .eq("user_id", campaign.user_id)
      .eq("status", "sent")
      .gte("sent_at", new Date(Date.now() - 3_600_000).toISOString());
    const pacedQuota = pacedRunQuota({
      dailyAllowance: Math.min(effectiveLimit, shareCap),
      sentToday: campaignSent,
      remainingToday: quota,
      minutesLeftInWindow: (campaign.send_window_end - hour) * 60 - minute,
      windowMinutes: (campaign.send_window_end - campaign.send_window_start) * 60,
      tickMinutes: TICK_MINUTES,
      runCap: MAX_SENDS_PER_RUN - sendsThisRun,
      mailboxHourlyLeft: MAILBOX_HOURLY_CAP - (mailboxLastHour ?? 0),
    });
    if (pacedQuota <= 0) continue;

    const { data: due } = await supabase
      .from("enrollments")
      .select("id, contact_id, user_id, current_step, gmail_thread_id, next_send_at")
      .eq("campaign_id", campaign.id)
      .eq("status", "active")
      .lte("next_send_at", new Date().toISOString())
      .order("next_send_at", { ascending: true })
      .limit(pacedQuota);
    if (!due?.length) continue;

    for (const enrollment of due) {
      if (sendsThisRun >= MAX_SENDS_PER_RUN) break;

      // Atomic claim. The due-set above is a plain SELECT and the enrollment is
      // not updated until AFTER the send, so two overlapping runs could both
      // select the same row and mail the same person twice (reproduced live).
      //
      // This is a compare-and-set: push next_send_at out by one lease,
      // conditional on the row still being due. Postgres serialises the two
      // UPDATEs, so the loser matches 0 rows and skips. A run that dies after
      // claiming simply retries once the lease expires -- the row is never
      // stranded, which is why this leases rather than marking a boolean.
      const claimNow = new Date().toISOString();
      const { data: claimed, error: claimErr } = await supabase
        .from("enrollments")
        .update({
          next_send_at: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
          updated_at: claimNow,
        })
        .eq("id", enrollment.id)
        .eq("status", "active")
        .lte("next_send_at", claimNow)
        .select("id");
      if (claimErr || !claimed?.length) continue;  // another concurrent run owns this row

      // ... trimmed: contact load, suppression list, role-mailbox stop,
      //     first-send MX gate, template + spintax render, planFollowUp(),
      //     List-Unsubscribe header, POST to email-sender ...
      const rateLimited = false as boolean;   // set from email-sender's response in production

      // Rate limited: this lead did nothing wrong and nothing was sent. Give the
      // row back as it was, due and on the same step, with no campaign_sends row.
      // It is not a failure and not a bounce. Stop using this mailbox for the run.
      if (rateLimited) {
        await supabase.from("enrollments").update({
          next_send_at: enrollment.next_send_at,
          updated_at: new Date().toISOString(),
        }).eq("id", enrollment.id);
        if (senderAccountId) rateLimitedMailboxes.add(senderAccountId);
        break;
      }

      // ... trimmed: insert campaign_sends audit row, advance the enrollment to
      //     the next step (delay + random jitter) or complete it, 6h backoff on failure ...
      sendsThisRun++;
    }
  }
}
