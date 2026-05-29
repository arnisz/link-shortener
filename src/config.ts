// Session configuration
export const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 600; // 10 minutes

// Cache configuration
export const GOOGLE_KEYS_CACHE_TTL_MS = 3600 * 1000; // 1 hour

// Short code generation
export const SHORT_CODE_LENGTH = 6;
export const SHORT_CODE_GENERATION_RETRIES = 5;
export const SHORT_CODE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Hard limits for user-supplied strings. */
export const TARGET_URL_MAX_LEN = 2000;
export const TITLE_MAX_LEN = 200;
export const TAG_MAX_PER_LINK = 10;
export const TAG_NAME_MAX_LEN = 50;
/** Backpressure: Globaler Insert-Cap pro Minute (Schicht 2). */
export const GLOBAL_INSERT_CAP = 1000;
/** Backpressure: Maximale Queue-Tiefe (unchecked, unclaimed) vor 503 (Schicht 3). */
export const QUEUE_DEPTH_THROTTLE_LIMIT = 5000;
/** Backpressure: TTL des Modul-Scope-Queue-Depth-Caches in ms (Schicht 3). */
export const QUEUE_DEPTH_CACHE_TTL_MS = 30_000;
/** Burst-Revalidation: Klick-Schwelle, ab der ein frischer Link zur vorgezogenen Neubewertung fällig wird. */
export const BURST_REVALIDATION_CLICK_THRESHOLD = 40;
/** Burst-Revalidation: Frischefenster in Stunden; nur Links innerhalb dieses Zeitraums ab created_at sind burst-eligible. */
export const BURST_REVALIDATION_WINDOW_HOURS = 6;
/** Active-Revalidation: unterhalb dieses Klickdeltas seit dem letzten Scan bleibt nur die reguläre 14-Tage-Regel aktiv. */
export const ACTIVE_REVALIDATION_MEDIUM_DELTA_THRESHOLD = 50;
/** Active-Revalidation: ab diesem Klickdelta seit dem letzten Scan gilt die schnellste Nachprüfung. */
export const ACTIVE_REVALIDATION_HIGH_DELTA_THRESHOLD = 100;
/** Active-Revalidation: 50-99 neue Klicks seit dem letzten Scan → Reclaim nach 1 Stunde. */
export const ACTIVE_REVALIDATION_MEDIUM_RECHECK_HOURS = 1;
/** Active-Revalidation: ab 100 neuen Klicks seit dem letzten Scan → Reclaim nach 30 Minuten. */
export const ACTIVE_REVALIDATION_HIGH_RECHECK_MINUTES = 30;

export const SECURITY_TXT = `Contact: mailto:security@xx.xx
Expires: 2027-06-01T00:00:00+00:00
Preferred-Languages: en
Policy: https://xxx.xx/.well-known/security-policy.txt
`;

export const SECURITY_POLICY_TXT = `# Security Policy — aadd.li

Scope: All services reachable under aadd.li and api.aadd.li.

Disclosure process:
1. Report via xxx (plaintext or PGP).
2. We confirm receipt within 5 business days.
3. We aim to resolve critical issues within 30 days.
4. Coordinated disclosure — please do not publish before a fix is available.

Out of scope: Social engineering, physical attacks, third-party services.
`;
