import type { GoogleIdTokenPayload, GoogleJWK } from "../types";
import { base64UrlDecode } from "../utils";
import { GOOGLE_KEYS_CACHE_TTL_MS } from "../config";

let googleKeysCache: GoogleJWK[] | null = null;
let googleKeysExpiry = 0;

export async function fetchGooglePublicKeys(): Promise<GoogleJWK[]> {
	if (googleKeysCache && Date.now() < googleKeysExpiry) {
		return googleKeysCache;
	}

	const resp = await fetch("https://www.googleapis.com/oauth2/v3/certs");
	if (!resp.ok) {
		throw new Error("Failed to fetch Google public keys");
	}

	const { keys } = await resp.json<{ keys: GoogleJWK[] }>();
	googleKeysCache = keys;
	googleKeysExpiry = Date.now() + GOOGLE_KEYS_CACHE_TTL_MS;
	return keys;
}

export async function verifyRS256Signature(
	data: string,
	signatureB64Url: string,
	jwk: GoogleJWK
): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"]
	);

	const signature = Uint8Array.from(base64UrlDecode(signatureB64Url), c => c.charCodeAt(0));
	const dataUint8 = new TextEncoder().encode(data);

	return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, dataUint8);
}

/**
 * Decodes and validates a Google ID token (JWT).
 * Performs critical security checks:
 * - JWT format (3 parts: header.payload.signature)
 * - Signature algorithm (RS256 only)
 * - Signature validity against Google's public keys
 * - Token issuer (Google)
 * - Email verification status
 */
export async function parseGoogleIdToken(idToken: string): Promise<GoogleIdTokenPayload> {
	const parts = idToken.split(".");
	if (parts.length !== 3) {
		throw new Error("Invalid ID token format");
	}

	const [headerB64, payloadB64, signatureB64] = parts;

	let header: { kid?: string; alg?: string };
	try {
		header = JSON.parse(base64UrlDecode(headerB64));
	} catch {
		throw new Error("Invalid JWT header");
	}

	if (header.alg !== "RS256") {
		throw new Error("Unsupported signature algorithm");
	}

	if (!header.kid) {
		throw new Error("Missing kid in JWT header");
	}

	const payloadJson = base64UrlDecode(payloadB64);
	const payload = JSON.parse(payloadJson) as GoogleIdTokenPayload;

	// 1. Verify issuer
	if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
		throw new Error("Invalid issuer");
	}

	// 2. Verify email_verified
	if (payload.email_verified !== true) {
		throw new Error("Email not verified");
	}

	// 3. Verify signature
	const keys = await fetchGooglePublicKeys();
	const key = keys.find(k => k.kid === header.kid);
	if (!key) {
		throw new Error("Public key not found for kid");
	}

	const isValid = await verifyRS256Signature(`${headerB64}.${payloadB64}`, signatureB64, key);
	if (!isValid) {
		throw new Error("Invalid JWT signature");
	}

	return payload;
}
