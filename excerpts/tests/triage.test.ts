// Unit tests for the pre-LLM triage gate excerpt.
// Run from the repo root (Node >= 22.18, no install): node --test excerpts/tests/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, deriveDirection } from '../triage.ts';

const base = { ownerEmails: ['sales@example.com'], isKnownContact: false };

test('own outbound mail is skipped even without the SENT label', () => {
  const verdict = triage({ ...base, senderEmail: 'Sales <sales@example.com>', labels: ['INBOX'] });
  assert.equal(verdict.classify, false);
  assert.equal(verdict.reason, 'own_sent_mail');
});

test('platform notifications are skipped, including subdomains', () => {
  const verdict = triage({ ...base, senderEmail: 'alerts@e.linkedin.com', subject: 'New activity' });
  assert.equal(verdict.reason, 'platform_noise');
});

test('bulk mail is detected by List-Unsubscribe header', () => {
  const verdict = triage({ ...base, senderEmail: 'news@vendor.example.org',
    headers: { 'list-unsubscribe': '<mailto:unsub@vendor.example.org>' } });
  assert.equal(verdict.reason, 'bulk_mail');
});

test('a known contact outranks every machine-traffic skip rule', () => {
  // Arrange: looks like bulk mail, but the sender is in an active sequence
  const input = { ...base, isKnownContact: true, senderEmail: 'prospect@client.example.net',
    labels: ['CATEGORY_UPDATES'], headers: { 'list-unsubscribe': '<mailto:x@client.example.net>' } };
  // Act
  const verdict = triage(input);
  // Assert
  assert.equal(verdict.classify, true);
  assert.equal(verdict.reason, 'known_contact_reply');
});

test('a bounce is skipped even for a known contact', () => {
  const verdict = triage({ ...base, isKnownContact: true, senderEmail: 'mailer-daemon@mail.example.net',
    subject: 'Delivery Status Notification (Failure)' });
  assert.equal(verdict.reason, 'bounce_notice');
});

test('an ordinary human email earns a model call', () => {
  const verdict = triage({ ...base, senderEmail: 'someone@client.example.net', subject: 'Pricing?' });
  assert.equal(verdict.classify, true);
  assert.equal(verdict.reason, 'needs_classification');
});

test('deriveDirection trusts the SENT label over a hardcoded inbound', () => {
  assert.equal(deriveDirection(['SENT'], 'other@example.org', [], 'inbound'), 'outbound');
  assert.equal(deriveDirection(['INBOX'], 'other@example.org', ['sales@example.com']), 'inbound');
});
