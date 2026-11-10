/**
 * EXCERPT — sender pinning and follow-up threading (original module: _shared/sender-account)
 *
 * What it is: the two pure functions that decide which Gmail mailbox a campaign
 * sends from, and whether a follow-up step may reply into the existing thread.
 *
 * Removed: the incident note (which mailbox leaked and how many emails).
 * Logic is unchanged from the production module.
 *
 * Background: the scheduler used to send from "the most recently updated
 * connected account". Every connected account refreshes its OAuth token hourly,
 * a fraction of a second apart, so the sender flipped between the business
 * mailbox and a personal mailbox at random, and cold mail went out from the
 * wrong address. The flip also broke follow-ups, because a Gmail threadId only
 * exists in the mailbox that created it (404 Not Found from another mailbox).
 */

export interface SenderAccountRow {
  id: string;
  google_connected_email: string | null;
}

/**
 * Pick the mailbox to send campaign mail from.
 *
 * @param rows - the owner's CONNECTED accounts, newest `updated_at` first.
 * @param pinnedEmail - CAMPAIGN_SENDER_EMAIL. When set, only that mailbox may
 *   send; if it is not connected we return null (fail closed) rather than fall
 *   back to another account, so cold mail never leaks onto a personal address.
 *   When empty/undefined, keeps the legacy behaviour (first row).
 * @returns the chosen account row, or null when nothing may send.
 */
export function pickSenderAccount<T extends SenderAccountRow>(
  rows: T[],
  pinnedEmail: string | undefined,
): T | null {
  const pin = (pinnedEmail ?? '').trim().toLowerCase();
  if (!pin) return rows[0] ?? null;
  return rows.find((r) => (r.google_connected_email ?? '').toLowerCase() === pin) ?? null;
}

export interface FollowUpInput {
  stepNumber: number;
  /** The step's own rendered subject ('' means "thread on step 1"). */
  renderedSubject: string;
  /** Rendered subject of step 1. */
  step1Subject: string;
  /** The enrollment's stored Gmail thread id, if any. */
  threadId: string | null;
  /** Account that sent the enrollment's last successful step (owns threadId). */
  threadAccountId: string | null;
  /** Account this send will go out from. */
  senderAccountId: string | null;
}

export interface FollowUpPlan {
  /** Thread to reply into, or undefined to start a new conversation. */
  threadId: string | undefined;
  subject: string;
  /** True when a follow-up starts a new thread (enrollment must store the new id). */
  fresh: boolean;
}

/**
 * Decide the subject and thread for one send.
 *
 * Step 1 always starts its own thread. A follow-up replies into the existing
 * thread ("Re: <step 1>") only when that thread belongs to the sending mailbox;
 * otherwise it goes as a fresh email under the plain step-1 subject, since a
 * "Re:" with no visible earlier message reads as a trick.
 */
export function planFollowUp(input: FollowUpInput): FollowUpPlan {
  if (input.stepNumber <= 1) {
    return { threadId: undefined, subject: input.renderedSubject, fresh: false };
  }
  const sameMailbox = !!input.threadId && !!input.senderAccountId &&
    input.threadAccountId === input.senderAccountId;
  if (sameMailbox) {
    return {
      threadId: input.threadId!,
      subject: input.renderedSubject || `Re: ${input.step1Subject}`,
      fresh: false,
    };
  }
  return {
    threadId: undefined,
    subject: input.renderedSubject || input.step1Subject,
    fresh: true,
  };
}
