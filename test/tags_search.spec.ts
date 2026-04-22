import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { setupTestDb, setupLinksTable, setupTagsTables, setupRateLimitTable, seedSession, makeRequest, seedLink } from "./helpers";

describe("Tags & Search", () => {
	beforeAll(async () => {
		await setupTestDb(env.hello_cf_spa_db);
		await setupLinksTable(env.hello_cf_spa_db);
		await setupTagsTables(env.hello_cf_spa_db);
		await setupRateLimitTable(env.hello_cf_spa_db);
	});

	beforeEach(async () => {
		await env.hello_cf_spa_db.prepare("DELETE FROM link_tags").run();
		await env.hello_cf_spa_db.prepare("DELETE FROM links").run();
		await env.hello_cf_spa_db.prepare("DELETE FROM tags").run();
		await env.hello_cf_spa_db.prepare("DELETE FROM sessions").run();
		await env.hello_cf_spa_db.prepare("DELETE FROM users").run();
		await env.hello_cf_spa_db.prepare("DELETE FROM rate_limits").run();
	});

	describe("Tag Validation & Normalization", () => {
		it("should accept valid tags and normalize them", async () => {
			const { sessionId } = await seedSession(env.hello_cf_spa_db);
			const resp = await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({
						target_url: "https://example.com/tags",
						tags: ["Work", "#urgent", "  Project-1  "]
					})
				})
			);

			expect(resp.status).toBe(201);
			const data: any = await resp.json();
			expect(data.tags).toEqual(["work", "urgent", "project-1"]);
		});

		it("should reject more than 10 tags", async () => {
			const { sessionId } = await seedSession(env.hello_cf_spa_db);
			const resp = await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({
						target_url: "https://example.com/too-many",
						tags: Array.from({ length: 11 }, (_, i) => `tag${i}`)
					})
				})
			);
			expect(resp.status).toBe(400);
			const data: any = await resp.json();
			expect(data.error).toContain("Maximum 10 tags");
		});

		it("should deduplicate tags", async () => {
			const { sessionId } = await seedSession(env.hello_cf_spa_db);
			const resp = await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({
						target_url: "https://example.com/dedup",
						tags: ["work", "Work", "#work"]
					})
				})
			);
			expect(resp.status).toBe(201);
			const data: any = await resp.json();
			expect(data.tags).toEqual(["work"]);
		});

		it("should reject invalid tags", async () => {
			const { sessionId } = await seedSession(env.hello_cf_spa_db);
			const cases = [
				{ tags: [""], error: "empty" },
				{ tags: ["a".repeat(51)], error: "too long" },
				{ tags: ["-start"], error: "start with a letter/digit" },
				{ tags: ["#"], error: "empty" }
			];

			for (const c of cases) {
				const resp = await SELF.fetch(
					makeRequest("http://aadd.li/api/links", "POST", {
						cookies: { "__Host-sid": sessionId },
						headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
						body: JSON.stringify({ target_url: "https://example.com", tags: c.tags })
					})
				);
				expect(resp.status).toBe(400);
			}
		});
	});

	describe("User Isolation", () => {
		it("should keep tags separated between users", async () => {
			const userA = await seedSession(env.hello_cf_spa_db, { userId: "user-a", email: "a@ex.com", googleSub: "sub-a" });
			const userB = await seedSession(env.hello_cf_spa_db, { userId: "user-b", email: "b@ex.com", googleSub: "sub-b" });

			// User A creates a link with tag 'work'
			await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": userA.sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({ target_url: "https://a.com", tags: ["work", "secret-a"] })
				})
			);

			// User B creates a link with tag 'work'
			await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": userB.sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({ target_url: "https://b.com", tags: ["work", "secret-b"] })
				})
			);

			// Verify tags in DB (should be separate rows)
			const tags: any = await env.hello_cf_spa_db.prepare("SELECT * FROM tags WHERE name = 'work'").all();
			expect(tags.results.length).toBe(2);

			// User B searches for 'secret-a' -> should be empty
			const respSearch = await SELF.fetch(
				makeRequest("http://aadd.li/api/links?q=secret-a", "GET", {
					cookies: { "__Host-sid": userB.sessionId }
				})
			);
			const dataSearch: any = await respSearch.json();
			expect(dataSearch.links.length).toBe(0);

			// User B tries to update User A's link (not possible as we don't know the code easily, but we can try)
			// But the ownership check is in the WHERE clause anyway.
		});
	});

	describe("Garbage Collection", () => {
		it("should delete tags when they are no longer referenced", async () => {
			const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);

			// 1. Create link with tags [a, b]
			const res1 = await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({ target_url: "https://ex.com", tags: ["a", "b"] })
				})
			);
			const link: any = await res1.json();

			const tagsBefore = await env.hello_cf_spa_db.prepare("SELECT name FROM tags WHERE user_id = ?").bind(userId).all();
			expect(tagsBefore.results.length).toBe(2);

			// 2. Update link to tags [a]
			await SELF.fetch(
				makeRequest(`http://aadd.li/api/links/${link.short_code}/update`, "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({ tags: ["a"] })
				})
			);

			const tagsAfterUpdate = await env.hello_cf_spa_db.prepare("SELECT name FROM tags WHERE user_id = ?").bind(userId).all();
			expect(tagsAfterUpdate.results.length).toBe(1);
			expect(tagsAfterUpdate.results[0].name).toBe("a");

			// 3. Delete link
			await SELF.fetch(
				makeRequest(`http://aadd.li/api/links/${link.short_code}/delete`, "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "X-Requested-With": "XMLHttpRequest" }
				})
			);

			const tagsAfterDelete = await env.hello_cf_spa_db.prepare("SELECT name FROM tags WHERE user_id = ?").bind(userId).all();
			expect(tagsAfterDelete.results.length).toBe(0);
		});

		it("should keep tags if still referenced by another link of the same user", async () => {
			const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);

			const res1 = await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({ target_url: "https://1.com", tags: ["shared"] })
				})
			);
			const link1: any = await res1.json();

			await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
					body: JSON.stringify({ target_url: "https://2.com", tags: ["shared"] })
				})
			);

			// Delete one link
			await SELF.fetch(
				makeRequest(`http://aadd.li/api/links/${link1.short_code}/delete`, "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: { "X-Requested-With": "XMLHttpRequest" }
				})
			);

			const tags = await env.hello_cf_spa_db.prepare("SELECT name FROM tags WHERE user_id = ?").bind(userId).all();
			expect(tags.results.length).toBe(1);
			expect(tags.results[0].name).toBe("shared");
		});
	});

	describe("Search Functionality", () => {
		it("should search by title, short_code and tag name (case-insensitive)", async () => {
			const { sessionId } = await seedSession(env.hello_cf_spa_db);

			await seedLink(env.hello_cf_spa_db, { userId: "test-user-001", shortCode: "my-alias", title: "Awesome Title" });

			// Add tags manually since seedLink doesn't support them yet
			const linkRes = await env.hello_cf_spa_db.prepare("SELECT id FROM links WHERE short_code = 'my-alias'").first<{id: string}>();
			await env.hello_cf_spa_db.prepare("INSERT INTO tags (user_id, name) VALUES (?, ?)").bind("test-user-001", "work").run();
			const tagRes = await env.hello_cf_spa_db.prepare("SELECT id FROM tags WHERE name = 'work'").first<{id: number}>();
			await env.hello_cf_spa_db.prepare("INSERT INTO link_tags (link_id, tag_id, user_id) VALUES (?, ?, ?)").bind(linkRes!.id, tagRes!.id, "test-user-001").run();

			const cases = [
				{ q: "awesome", expected: 1 },
				{ q: "ALIAS", expected: 1 },
				{ q: "WORK", expected: 1 },
				{ q: "none", expected: 0 }
			];

			for (const c of cases) {
				const resp = await SELF.fetch(
					makeRequest(`http://aadd.li/api/links?q=${c.q}`, "GET", {
						cookies: { "__Host-sid": sessionId }
					})
				);
				const data: any = await resp.json();
				expect(data.links.length).toBe(c.expected);
			}
		});

		it("should not search in target_url", async () => {
			const { sessionId } = await seedSession(env.hello_cf_spa_db);
			await seedLink(env.hello_cf_spa_db, { userId: "test-user-001", targetUrl: "https://hidden-target.com" });

			const resp = await SELF.fetch(
				makeRequest(`http://aadd.li/api/links?q=hidden`, "GET", {
					cookies: { "__Host-sid": sessionId }
				})
			);
			const data: any = await resp.json();
			expect(data.links.length).toBe(0);
		});
	});

	describe("Security", () => {
		it("should reject anonymous links with tags", async () => {
			const resp = await SELF.fetch(
				makeRequest("http://aadd.li/api/links/anonymous", "POST", {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ target_url: "https://anon.com", tags: ["forbidden"] })
				})
			);
			expect(resp.status).toBe(400);
			const data: any = await resp.json();
			expect(data.error).toContain("Anonymous links cannot have tags");
		});

		it("should require CSRF for tag mutations", async () => {
			const { sessionId } = await seedSession(env.hello_cf_spa_db);
			const resp = await SELF.fetch(
				makeRequest("http://aadd.li/api/links", "POST", {
					cookies: { "__Host-sid": sessionId },
					headers: {
						"Content-Type": "application/json",
						"Origin": "http://aadd.li"
					},
					body: JSON.stringify({ target_url: "https://no-csrf.com", tags: ["a"] })
				})
			);
			expect(resp.status).toBe(403);
		});
	});
});
