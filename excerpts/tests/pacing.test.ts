// Unit tests for the campaign pacing and bounce-breaker excerpts.
// Run from the repo root (Node >= 22.18, no install): node --test excerpts/tests/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fairShareCap, pacedRunQuota } from '../campaign-pacing.ts';
import { shouldTripBounceBreaker } from '../bounce-breaker.ts';

const ACTIVE = [50, 30, 30, 10];

test('fairShareCap splits the global cap in proportion to each limit', () => {
  // Arrange / Act
  const shares = ACTIVE.map((limit) => fairShareCap(limit, ACTIVE, 100));
  // Assert: floor(100 * limit / 120)
  assert.deepEqual(shares, [41, 25, 25, 8]);
  assert.ok(shares.reduce((a, b) => a + b, 0) <= 100);
});

test('fairShareCap leaves limits alone when they fit under the cap', () => {
  assert.equal(fairShareCap(30, [30, 20, 10], 100), 30);
});

test('fairShareCap guarantees a tiny campaign at least one send', () => {
  assert.equal(fairShareCap(1, [1, 500], 100), 1);
});

/** One 8-hour window on a 15-minute tick; returns the tick index of every send. */
function simulate(allowance: number): number[] {
  const sends: number[] = [];
  for (let tick = 0; tick < 32; tick++) {
    const quota = pacedRunQuota({
      dailyAllowance: allowance, sentToday: sends.length, remainingToday: allowance - sends.length,
      minutesLeftInWindow: 480 - tick * 15, windowMinutes: 480, tickMinutes: 15,
      runCap: 10, mailboxHourlyLeft: 12,
    });
    for (let i = 0; i < quota; i++) sends.push(tick);
  }
  return sends;
}

test('pacedRunQuota spreads a small allowance across the window', () => {
  // Act
  const sends = simulate(5);
  // Assert: sends land throughout the window, not all in tick 0
  assert.deepEqual(sends, [0, 6, 12, 19, 25]);
});

test('pacedRunQuota never exceeds the mailbox hourly ceiling', () => {
  const quota = pacedRunQuota({
    dailyAllowance: 29, sentToday: 0, remainingToday: 29, minutesLeftInWindow: 60,
    windowMinutes: 480, tickMinutes: 15, runCap: 10, mailboxHourlyLeft: 3,
  });
  assert.equal(quota, 3);
});

test('bounce breaker ignores small samples and trips on a real bad list', () => {
  assert.equal(shouldTripBounceBreaker(35, 2), false);   // too few sends
  assert.equal(shouldTripBounceBreaker(50, 3), false);   // too few bounces
  assert.equal(shouldTripBounceBreaker(100, 5), false);  // exactly 5% does not trip
  assert.equal(shouldTripBounceBreaker(100, 6), true);
});
