// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
	if (!iso) return "";
	return new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

// ── DOM rendering ─────────────────────────────────────────────────────────────

function makeBadge(link) {
	const span = document.createElement("span");
	span.className = "badge";
	const now = Date.now();
	if (!link.is_active) {
		span.classList.add("badge-inactive");
		span.textContent = "Inaktiv";
	} else if (link.expires_at && new Date(link.expires_at).getTime() < now) {
		span.classList.add("badge-expired");
		span.textContent = "Abgelaufen";
	} else {
		span.classList.add("badge-active");
		span.textContent = "Aktiv";
	}
	return span;
}

function renderLinkCard(l) {
	const row = document.createElement("div");
	row.className = "link-row";

	// ── Head: title + badge + action buttons ──
	const head = document.createElement("div");
	head.className = "link-head";

	const title = document.createElement("strong");
	title.textContent = l.title || l.short_code;
	head.appendChild(title);

	head.appendChild(makeBadge(l));

	const toggleBtn = document.createElement("button");
	toggleBtn.className = "btn-sm";
	toggleBtn.textContent = l.is_active ? "Deaktivieren" : "Aktivieren";
	toggleBtn.addEventListener("click", () => toggleLink(l.id, !!l.is_active));
	head.appendChild(toggleBtn);

	const deleteBtn = document.createElement("button");
	deleteBtn.className = "btn-sm";
	deleteBtn.textContent = "Löschen";
	deleteBtn.addEventListener("click", () => deleteLink(l.id));
	head.appendChild(deleteBtn);

	row.appendChild(head);

	// ── Short URL ──
	const shortDiv = document.createElement("div");
	shortDiv.className = "link-short";
	const anchor = document.createElement("a");
	anchor.href = l.short_url;
	anchor.target = "_blank";
	anchor.rel = "noopener";
	anchor.textContent = l.short_url;
	shortDiv.appendChild(anchor);
	row.appendChild(shortDiv);

	// ── Target URL ──
	const metaTarget = document.createElement("div");
	metaTarget.className = "link-meta";
	metaTarget.textContent = "→ " + l.target_url;
	row.appendChild(metaTarget);

	// ── Stats: clicks + created + expiry ──
	const metaStats = document.createElement("div");
	metaStats.className = "link-meta";
	let stats = `${l.click_count} Klick${l.click_count !== 1 ? "s" : ""} · Erstellt: ${fmtDate(l.created_at)}`;
	if (l.expires_at) stats += " · Läuft ab: " + fmtDate(l.expires_at);
	metaStats.textContent = stats;
	row.appendChild(metaStats);

	return row;
}

// ── Pagination state ──────────────────────────────────────────────────────────

let _nextCursor = null;
let _isFetching = false;
let _observer   = null;

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchLinks(cursor, limit) {
	const params = new URLSearchParams({ limit: String(limit) });
	if (cursor) params.set("cursor", cursor);
	const resp = await fetch(`/api/links?${params}`);
	if (resp.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
	if (!resp.ok) throw new Error("Fehler beim Laden der Links.");
	return resp.json();
}

// ── Infinite scroll ───────────────────────────────────────────────────────────

function teardownObserver() {
	if (_observer) { _observer.disconnect(); _observer = null; }
}

function setupSentinel(list) {
	teardownObserver();
	const sentinel = document.createElement("div");
	sentinel.id = "links-sentinel";
	list.appendChild(sentinel);

	_observer = new IntersectionObserver(async (entries) => {
		if (!entries[0].isIntersecting || _isFetching || !_nextCursor) return;
		_isFetching = true;
		const spinner = document.getElementById("links-spinner");
		if (spinner) spinner.hidden = false;
		try {
			const data = await fetchLinks(_nextCursor, 10);
			_nextCursor = data.nextCursor;
			const s = document.getElementById("links-sentinel");
			if (s) data.links.forEach(link => s.before(renderLinkCard(link)));
			if (!_nextCursor) {
				teardownObserver();
				if (s) s.remove();
				appendEndMessage(list);
			}
		} catch (err) {
			const statusEl = document.getElementById("links-status");
			if (statusEl) {
				statusEl.textContent = err.status === 401
					? "Sitzung abgelaufen. Bitte neu anmelden."
					: (err.message || "Fehler beim Laden weiterer Links.");
				statusEl.className = "error";
			}
			if (err.status === 401) window.location.href = "/login";
		} finally {
			_isFetching = false;
			const spinner = document.getElementById("links-spinner");
			if (spinner) spinner.hidden = true;
		}
	}, { rootMargin: "200px" });

	_observer.observe(sentinel);
}

function appendEndMessage(list) {
	if (document.getElementById("links-end")) return;
	const el = document.createElement("p");
	el.id = "links-end";
	el.textContent = "Alle Links geladen";
	list.appendChild(el);
}

// ── Link actions ──────────────────────────────────────────────────────────────

async function toggleLink(id, currentIsActive) {
	const resp = await fetch(`/api/links/${id}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ is_active: !currentIsActive }),
	});
	if (resp.ok) {
		await loadLinks();
	} else if (resp.status === 401) {
		window.location.href = "/login";
	} else {
		const data = await resp.json().catch(() => ({}));
		const statusEl = document.getElementById("links-status");
		if (statusEl) {
			statusEl.textContent = "Fehler: " + (data.error ?? resp.statusText);
			statusEl.className = "error";
		}
	}
}

async function deleteLink(id) {
	const resp = await fetch(`/api/links/${id}/delete`, { method: "POST" });
	if (resp.ok) {
		await loadLinks();
	} else if (resp.status === 401) {
		window.location.href = "/login";
	} else {
		const data = await resp.json().catch(() => ({}));
		const statusEl = document.getElementById("links-status");
		if (statusEl) {
			statusEl.textContent = "Fehler: " + (data.error ?? resp.statusText);
			statusEl.className = "error";
		}
	}
}

// ── Load link list ────────────────────────────────────────────────────────────

async function loadLinks() {
	teardownObserver();
	_nextCursor = null;
	_isFetching = false;
	const list     = document.getElementById("links-list");
	const statusEl = document.getElementById("links-status");
	if (statusEl) { statusEl.textContent = ""; statusEl.className = ""; }

	list.innerHTML = "";
	const loading = document.createElement("em");
	loading.textContent = "Lade…";
	list.appendChild(loading);

	try {
		_isFetching = true;
		const data = await fetchLinks(null, 50);
		_isFetching = false;
		_nextCursor = data.nextCursor;
		list.innerHTML = "";

		if (!data.links.length) {
			const empty = document.createElement("em");
			empty.textContent = "Noch keine Links – erstelle deinen ersten!";
			list.appendChild(empty);
			return;
		}

		data.links.forEach(link => list.appendChild(renderLinkCard(link)));

		if (_nextCursor) {
			setupSentinel(list);
		} else {
			appendEndMessage(list);
		}
	} catch (err) {
		_isFetching = false;
		list.innerHTML = "";
		if (err.status === 401) {
			const msg = document.createTextNode("Sitzung abgelaufen. ");
			const a   = document.createElement("a");
			a.href = "/login";
			a.textContent = "Bitte neu anmelden.";
			list.appendChild(msg);
			list.appendChild(a);
		} else {
			list.textContent = err.message || "Fehler beim Laden der Links.";
		}
	}
}

// ── Create form ───────────────────────────────────────────────────────────────

document.getElementById("create-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const statusEl = document.getElementById("create-status");
	statusEl.className = "";
	statusEl.textContent = "Erstelle…";
	const form = e.currentTarget;

	const expiresRaw = form.elements["expires_at"].value;
	const body = {
		target_url: form.elements["target_url"].value.trim(),
		title:      form.elements["title"].value.trim() || undefined,
		alias:      form.elements["alias"].value.trim() || undefined,
		// Convert datetime-local to UTC ISO so the Worker receives a proper timestamp
		expires_at: expiresRaw ? new Date(expiresRaw).toISOString() : undefined,
	};

	try {
		const resp = await fetch("/api/links", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = await resp.json();
		if (!resp.ok) {
			statusEl.className = "error";
			statusEl.textContent = "Fehler: " + (data.error ?? resp.statusText);
			return;
		}
		statusEl.textContent = "✓ Erstellt: " + data.short_url;
		form.reset();
		await loadLinks();
	} catch (err) {
		statusEl.className = "error";
		statusEl.textContent = "Fehler: " + String(err);
	}
});

// ── Auth / session check ──────────────────────────────────────────────────────

async function loadMe() {
	const statusEl   = document.getElementById("status");
	const logoutForm  = document.getElementById("logout-form");
	const linkSection = document.getElementById("link-section");
	try {
		const resp = await fetch("/api/me");
		const data = await resp.json();
		if (!data.authenticated) {
			statusEl.textContent = "Nicht eingeloggt. ";
			const a   = document.createElement("a");
			a.href = "/login";
			const btn = document.createElement("button");
			btn.type = "button";
			btn.textContent = "Mit Google anmelden";
			a.appendChild(btn);
			statusEl.appendChild(a);
			logoutForm.hidden  = true;
			linkSection.hidden = true;
			return;
		}
		statusEl.textContent = "Eingeloggt als " + data.user.email;
		logoutForm.hidden  = false;
		linkSection.hidden = false;
		await loadLinks();
	} catch (err) {
		statusEl.textContent = "Fehler beim Laden: " + String(err);
		logoutForm.hidden  = true;
		linkSection.hidden = true;
	}
}

loadMe();
