// Unit tests for the sender-pinning excerpt.
// Run from the repo root (Node >= 22.18, no install): node --test excerpts/tests/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSenderAccount, planFollowUp } from '../sender-account.ts';

const rows = [
  { id: 'acct-personal', google_connected_email: 'me@personal.example.com' },
  { id: 'acct-business', google_connected_email: 'sales@example.com' },
];

test('pinned sender is chosen even when another account was refreshed more recently', () => {
  // Act
  const chosen = pickSenderAccount(rows, ' Sales@Example.com ');
  // Assert
  assert.equal(chosen?.id, 'acct-business');
});

test('pinned sender that is not connected fails closed', () => {
  assert.equal(pickSenderAccount(rows.slice(0, 1), 'sales@example.com'), null);
});

test('follow-up replies into the thread only when the sending mailbox owns it', () => {
  // Arrange
  const base = { stepNumber: 2, renderedSubject: '', step1Subject: 'Quick question',
    threadId: 'thread-1', senderAccountId: 'acct-business' };
  // Act
  const same = planFollowUp({ ...base, threadAccountId: 'acct-business' });
  const foreign = planFollowUp({ ...base, threadAccountId: 'acct-personal' });
  // Assert
  assert.deepEqual(same, { threadId: 'thread-1', subject: 'Re: Quick question', fresh: false });
  assert.deepEqual(foreign, { threadId: undefined, subject: 'Quick question', fresh: true });
});
