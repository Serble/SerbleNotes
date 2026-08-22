/**
 * Identifiers the client makes for itself: this device, a note, a version.
 *
 * `crypto.randomUUID` would be the whole of this file, but it is a secure-context API and so does
 * not exist when the page came over plain http from anything other than localhost. That is not a
 * hypothetical: `tauri android dev` replaces the dev URL with this machine's LAN address, so the
 * Android client is served from `http://192.168.x.x:3000` every time it is run against a device,
 * and a self-hosted backend on a LAN would look the same to it. Reaching for `randomUUID` there
 * throws, and it is reached for before anything else - the first API call needs a device id.
 *
 * `crypto.getRandomValues` carries no such restriction, so the bytes come from there and only the
 * v4 formatting is ours. The randomness is identical either way; this is not a weaker fallback.
 * The Rust core is unaffected - getrandom's js backend calls `getRandomValues` too.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4.
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 1.

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
