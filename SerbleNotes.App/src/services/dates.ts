/**
 * Timestamps in the two forms the UI needs: a short relative one to read at a glance, and the full
 * one underneath it as a tooltip.
 *
 * The API sends UTC with no zone marker, and `new Date` reads a bare "2026-08-21T09:00:00" as local
 * time - which puts every timestamp hours out for anyone not on UTC. HistoryPanel already carried
 * this fix inline; it lives here now so every timestamp in the app gets it.
 */
function parse(iso: string): Date {
  const zoned = iso.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  return new Date(zoned);
}

/** The whole thing, date and time, for a tooltip or a details row. */
export function absolute(iso: string): string {
  const date = parse(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

/** Just the day, for something long enough ago that the hour has stopped mattering. */
export function day(iso: string): string {
  const date = parse(iso);
  return Number.isNaN(date.getTime())
    ? 'unknown'
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/**
 * "just now", "5 minutes ago", "yesterday", and a plain date once it is more than a week old -
 * past which counting days is less use than knowing which day it was.
 */
export function relative(iso: string): string {
  const then = parse(iso).getTime();
  if (Number.isNaN(then)) {
    return 'unknown';
  }

  // Two devices rarely agree on the time to the second, so a stamp a little in the future is a
  // clock difference rather than a note from tomorrow. Say the honest thing instead of "in 3s".
  const gap = Math.max(0, Date.now() - then);

  if (gap < 45_000) {
    return 'just now';
  }
  if (gap < HOUR) {
    return relativeFormat.format(-Math.round(gap / MINUTE), 'minute');
  }
  if (gap < DAY) {
    return relativeFormat.format(-Math.round(gap / HOUR), 'hour');
  }
  if (gap < 7 * DAY) {
    return relativeFormat.format(-Math.round(gap / DAY), 'day');
  }
  return day(iso);
}
