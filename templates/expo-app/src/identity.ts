/**
 * The app user id: RevenueCat's app user id and the id the verdict backend checks
 * entitlements for. It is stored per install and survives Delete my data, so a subscriber
 * keeps their subscription after PostHog resets to a new distinct id. Import-free so the
 * studio's tests can load it.
 */

/** A random per-install id (UUID v4 shape); never a shared constant. */
export function randomId(random: () => number = Math.random): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** The stored id wins; a first launch takes the PostHog distinct id, or a random id without PostHog. */
export function chooseUserId(stored: string | null, posthogId: string | null, random: () => string = randomId): string {
  return stored || posthogId || random();
}
