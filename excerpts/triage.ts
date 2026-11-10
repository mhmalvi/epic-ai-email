/**
 * EXCERPT — deterministic pre-LLM triage gate (original module: _shared/triage)
 *
 * What it is: the rule gate that runs BEFORE any model call on an inbound
 * email. A skipped email costs nothing; a passed email earns a classification
 * call. Pure by design (no network, no database) so it is unit-testable.
 *
 * Removed: per-bucket percentages and row counts from the cost audit that
 * motivated it. Rules, rule order and the domain list are unchanged.
 *
 * Background: a cost audit joined the LLM usage ledger to the emails table and
 * found most of the spend went on mail no human needed to read: our own
 * outbound mail synced back from the Sent folder, newsletters, social-platform
 * notifications, monitoring alerts and bounce notices. The existing rules
 * engine ran AFTER the model, so a rule could label an email but never prevent
 * the spend that produced the label. This gate moves the decision in front.
 */

/** Env var holding a comma-separated list of mailboxes we own. */
export const OWNER_MAILBOXES_ENV = 'EPIC_OWNER_MAILBOXES';

/** Marker stamped into every notification EPiC sends itself. */
export const EPIC_NOTIFICATION_MARKER = '[epic-auto-notification]';

export interface TriageInput {
  senderEmail: string;
  /** Mailboxes we own. Mail from these is our own outbound copy. */
  ownerEmails: string[];
  /** True when the sender already exists in contacts/enrollments. */
  isKnownContact?: boolean;
  subject?: string;
  bodyText?: string;
  /** Gmail label ids, e.g. SENT, INBOX, CATEGORY_PROMOTIONS. */
  labels?: string[];
  /** Lower-cased RFC822 headers, if available. */
  headers?: Record<string, string>;
}

export interface TriageVerdict {
  /** True when the message earns a model call. */
  classify: boolean;
  /** Machine-readable rule that decided it. */
  reason: TriageReason;
  /** Category to record when skipping, so the UI still shows something useful. */
  category: string;
  leadScore: number;
  leadTemperature: 'none';
  requiresResponse: boolean;
}

export type TriageReason =
  | 'own_sent_mail'
  | 'auto_notification'
  | 'bounce_notice'
  | 'known_contact_reply'
  | 'monitoring_alert'
  | 'platform_noise'
  | 'no_reply_sender'
  | 'bulk_mail'
  | 'needs_classification';

/**
 * Domains whose mail is, in practice, always machine-generated notification
 * traffic. Kept narrow on purpose — a domain here can never reach the model,
 * so it must never hold a domain a customer might write from.
 */
const PLATFORM_NOISE_DOMAINS = [
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'facebookmail.com',
  'instagram.com',
  'quora.com',
  'medium.com',
  'pinterest.com',
  'reddit.com',
  'tiktok.com',
];

const NO_REPLY_LOCALPARTS = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce|bounces|notifications?-no-?reply)$/i;

const BOUNCE_SUBJECT =
  /(delivery status notification|undelivered mail|mail delivery (failed|subsystem)|returned mail|delivery has failed|address not found)/i;

const MONITORING_SUBJECT =
  /(\u{1F534}|\u{1F7E2}|\[uptime kuma\]|\bmonitor\b.*\b(down|up)\b|\b(down|up)\b\s*[—-].*\bmonitor\b)/iu;

const BULK_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_SOCIAL',
  'CATEGORY_FORUMS',
]);

/**
 * Pull a bare address out of anything Gmail might hand us:
 * "Name <a@b.com>", " A@B.com ", or a raw address.
 */
export function normalizeAddr(raw: string | undefined | null): string {
  if (!raw) return '';
  const angled = String(raw).match(/<([^>]+)>/);
  return (angled ? angled[1] : String(raw)).trim().toLowerCase();
}

/** Read the owner mailbox list out of the environment. */
export function ownerMailboxesFromEnv(get: (k: string) => string | undefined): string[] {
  return (get(OWNER_MAILBOXES_ENV) ?? '')
    .split(',')
    .map((s) => normalizeAddr(s))
    .filter(Boolean);
}

function skip(reason: TriageReason, category: string): TriageVerdict {
  return { classify: false, reason, category, leadScore: 0, leadTemperature: 'none', requiresResponse: false };
}

function pass(reason: TriageReason): TriageVerdict {
  return { classify: true, reason, category: 'unclassified', leadScore: 0, leadTemperature: 'none', requiresResponse: false };
}

/**
 * Decide whether an email is worth a model call.
 *
 * Rule order matters and is load-bearing:
 *   1. our own outbound mail — unconditional, it can never be an inbound lead
 *   2. our own automated notifications — a self-notification feedback loop
 *   3. bounce notices — always mechanical
 *   4. known contacts — an outreach reply outranks every remaining skip rule
 *   5..8. machine traffic (monitoring, platform noise, no-reply, bulk)
 *
 * @param input  message facts; see TriageInput
 * @returns      a verdict carrying the deciding rule, for logging and metrics
 */
export function triage(input: TriageInput): TriageVerdict {
  const sender = normalizeAddr(input.senderEmail);
  const owners = new Set(input.ownerEmails.map((e) => normalizeAddr(e)));
  const labels = input.labels ?? [];
  const subject = input.subject ?? '';
  const headers = input.headers ?? {};

  // 1. Our own outbound mail. Two independent signals, because the stored
  //    `direction` column was wrong on many rows while the SENT label was right.
  if (labels.includes('SENT') || owners.has(sender)) {
    return skip('own_sent_mail', 'sent');
  }

  // 2. Notifications EPiC sent itself.
  if ((input.bodyText ?? '').includes(EPIC_NOTIFICATION_MARKER) ||
      (subject).includes(EPIC_NOTIFICATION_MARKER)) {
    return skip('auto_notification', 'notification');
  }

  // 3. Bounces. Recorded by the campaign bounce gate, never by the model.
  const localPart = sender.split('@')[0] ?? '';
  if (BOUNCE_SUBJECT.test(subject) || /^(mailer-daemon|postmaster)$/i.test(localPart)) {
    return skip('bounce_notice', 'bounce');
  }

  // 4. Somebody we are already talking to. Deliberately outranks the machine
  //    filters below: missing one outreach reply costs more than every model
  //    call this gate saves in a month.
  if (input.isKnownContact) {
    return { ...pass('known_contact_reply'), category: 'unclassified' };
  }

  // 5. Our own infrastructure alerting.
  if (MONITORING_SUBJECT.test(subject)) {
    return skip('monitoring_alert', 'notification');
  }

  // 6. Social/professional platform notification traffic.
  const domain = sender.split('@')[1] ?? '';
  if (PLATFORM_NOISE_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) {
    return skip('platform_noise', 'notification');
  }

  // 7. Senders that cannot receive a reply.
  if (NO_REPLY_LOCALPARTS.test(localPart)) {
    return skip('no_reply_sender', 'notification');
  }

  // 8. Anything that advertises its own unsubscribe route is bulk by definition.
  if (headers['list-unsubscribe'] || labels.some((l) => BULK_LABELS.has(l))) {
    return skip('bulk_mail', 'newsletter');
  }

  return pass('needs_classification');
}

/**
 * Decide whether a synced Gmail message is ours or theirs.
 *
 * The sync function took `direction` as a caller argument and both history-sync
 * paths passed a hardcoded 'inbound', even though Gmail's history API returns
 * SENT messages too. That put outbound copies back through the classifier.
 *
 * @param labels        Gmail label ids on the message
 * @param senderEmail   From: address
 * @param ownerEmails   mailboxes we own
 * @param declared      what the caller asked for; honoured only when 'outbound'
 */
export function deriveDirection(
  labels: string[] | undefined,
  senderEmail: string,
  ownerEmails: string[],
  declared: 'inbound' | 'outbound' = 'inbound',
): 'inbound' | 'outbound' {
  if (declared === 'outbound') return 'outbound';
  if ((labels ?? []).includes('SENT')) return 'outbound';
  const sender = normalizeAddr(senderEmail);
  return ownerEmails.map((e) => normalizeAddr(e)).includes(sender) ? 'outbound' : 'inbound';
}
