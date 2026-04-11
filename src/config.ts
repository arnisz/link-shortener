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
