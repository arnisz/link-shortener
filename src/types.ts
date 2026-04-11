export interface Env {
	hello_cf_spa_db: D1Database;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	SESSION_SECRET: string;
	APP_BASE_URL: string;
}

export type GoogleTokenResponse = {
	access_token?: string;
	expires_in?: number;
	id_token?: string;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
};

export type GoogleIdTokenPayload = {
	iss: string;
	aud: string;
	sub: string;
	nonce?: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
	exp: number;
	iat: number;
};

export interface GoogleJWK {
	kid: string;
	n: string;
	e: string;
	kty: "RSA";
	alg: "RS256";
	use: "sig";
}
