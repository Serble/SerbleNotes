/**
 * Reading the server's timestamps.
 *
 * There is one bug worth a test file here and it is invisible: the API sends UTC with no zone
 * marker, and `new Date("2026-08-21T09:00:00")` reads that as *local* time. Every timestamp in the
 * app is then hours out for anyone not on UTC - and it is hours out consistently, so it looks
 * plausible rather than broken, which is why it survived being read past several times.
 *
 * The rest is arithmetic on a gap, where the only interesting cases are the boundaries and the one
 * that cannot happen but does: a stamp from the future, because two devices do not agree on the time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { absolute, day, relative } from '../src/services/dates';

/** An ISO stamp `ms` in the past, in the shape the API sends: UTC, no marker. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace('Z', '');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('a stamp with no zone marker is read as UTC, not as local time', () => {
  // The whole point. Both of these name the same instant, so they must render identically - if the
  // bare one were read as local, they would differ by the reader's offset from UTC.
  assert.equal(absolute('2026-08-21T09:00:00'), absolute('2026-08-21T09:00:00Z'));
  assert.equal(day('2026-08-21T09:00:00'), day('2026-08-21T09:00:00Z'));
});

test('a stamp that does carry a zone is believed', () => {
  // +02:00 at 11:00 is 09:00 UTC. Appending a Z to this would move it two hours.
  assert.equal(absolute('2026-08-21T11:00:00+02:00'), absolute('2026-08-21T09:00:00Z'));
});

test('a fractional-second stamp is still read as UTC', () => {
  // What the backend actually sends, from datetime(6).
  assert.equal(absolute('2026-08-21T09:00:00.123456'), absolute('2026-08-21T09:00:00.123456Z'));
});

test('a stamp that is not a date says so instead of showing Invalid Date', () => {
  for (const bad of ['', 'not a date', '2026-13-45T99:99:99']) {
    assert.equal(absolute(bad), 'unknown');
    assert.equal(day(bad), 'unknown');
    assert.equal(relative(bad), 'unknown');
  }
});

test('a recent save reads as just now rather than as a count of seconds', () => {
  assert.equal(relative(ago(0)), 'just now');
  assert.equal(relative(ago(44_000)), 'just now');
  assert.notEqual(relative(ago(46_000)), 'just now');
});

test('a stamp from the future is a clock difference, not a note from tomorrow', () => {
  // Two devices rarely agree to the second, and "in 3 seconds" is a nonsense a user cannot act on.
  const soon = new Date(Date.now() + 5 * MINUTE).toISOString().replace('Z', '');
  assert.equal(relative(soon), 'just now');
});

test('the gap decides the unit', () => {
  assert.match(relative(ago(5 * MINUTE)), /minute/);
  assert.match(relative(ago(5 * HOUR)), /hour/);
  assert.match(relative(ago(3 * DAY)), /day|yesterday/);
});

test('past a week it becomes a date, because counting days has stopped helping', () => {
  const old = relative(ago(30 * DAY));

  assert.doesNotMatch(old, /day|hour|minute|ago/);
  assert.equal(old, day(ago(30 * DAY)));
});
