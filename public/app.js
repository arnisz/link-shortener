// ── Helpers ───────────────────────────────────────────────────────────────────

function isPWA() {
	return window.matchMedia('(display-mode: standalone)').matches
		|| window.navigator.standalone === true;
}

function translate(key, params) {
	return typeof window.t === "function" ? window.t(key, params) : key;
}

function getActiveLocale() {
	return window.getLocale();
}

const authState = {
	mode: "loading",
	email: "",
	errorMessage: "",
};

let createStatusState = { type: "idle", message: "" };
let isLocationBusy = false;
let csrfToken = null;

/** Returns mutation headers with CSRF token (if available) + legacy X-Requested-With. */
function mutationHeaders(contentType) {
	const h = { "X-Requested-With": "XMLHttpRequest" };
	if (contentType) h["Content-Type"] = contentType;
	if (csrfToken) h["X-CSRF-Token"] = csrfToken;
	return h;
}

function copyToClipboard(text, btn) {
	navigator.clipboard.writeText(text).then(() => {
		btn.textContent = translate("app.link.btn.copied");
		btn.style.borderColor = "#86efac";
		btn.style.color = "#166534";
		setTimeout(() => {
			btn.textContent = translate("app.link.btn.copy");
			btn.style.borderColor = "";
			btn.style.color = "";
		}, 2000);
	}).catch(() => {});
}

function fmtDate(iso) {
	if (!iso) return "";
	return new Date(iso).toLocaleString(getActiveLocale(), { dateStyle: "short", timeStyle: "short" });
}

function setCreateStatus(type, message = "") {
	createStatusState = { type, message };
	renderCreateStatus();
}

function renderCreateStatus() {
	const statusEl = document.getElementById("create-status");
	if (!statusEl) return;

	statusEl.className = createStatusState.type === "error" ? "error" : "";

	switch (createStatusState.type) {
		case "submitting":
			statusEl.textContent = translate("app.create.submitting");
			break;
		case "success":
			statusEl.textContent = translate("app.create.success_prefix", { url: createStatusState.message });
			break;
		case "error":
			statusEl.textContent = createStatusState.message || translate("error.app.create");
			break;
		default:
			statusEl.textContent = "";
	}
}

function renderAuthStatus() {
	const statusEl = document.getElementById("status");
	const logoutForm = document.getElementById("logout-form");
	const linkSection = document.getElementById("link-section");
	if (!statusEl || !logoutForm || !linkSection) return;

	statusEl.textContent = "";

	if (authState.mode === "anonymous") {
		statusEl.textContent = `${translate("app.notloggedin")} `;
		const a = document.createElement("a");
		a.href = "/login";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = translate("login.button");
		a.appendChild(btn);
		statusEl.appendChild(a);
		logoutForm.hidden = true;
		linkSection.hidden = true;
		return;
	}

	if (authState.mode === "authenticated") {
		statusEl.textContent = `${translate("app.loggedin")} ${authState.email}`;
		logoutForm.hidden = false;
		linkSection.hidden = false;
		return;
	}

	if (authState.mode === "error") {
		statusEl.textContent = `${translate("app.load.error")} ${authState.errorMessage}`;
		logoutForm.hidden = true;
		linkSection.hidden = true;
		return;
	}

	statusEl.textContent = translate("app.links.loading");
	logoutForm.hidden = true;
	linkSection.hidden = true;
}

function setLocationButtonState(busy) {
	isLocationBusy = busy;
	const btn = document.getElementById("location-btn-app");
	if (!btn) return;

	btn.textContent = translate(busy ? "app.location.detecting" : "app.location.button");
	btn.disabled = busy;
}

// ── DOM rendering ─────────────────────────────────────────────────────────────

function makeBadge(link) {
	const span = document.createElement("span");
	span.className = "badge";
	const now = Date.now();
	if (!link.is_active) {
		span.classList.add("badge-inactive");
		span.textContent = translate("app.link.badge.inactive");
	} else if (link.expires_at && new Date(link.expires_at).getTime() < now) {
		span.classList.add("badge-expired");
		span.textContent = translate("app.link.badge.expired");
	} else {
		span.classList.add("badge-active");
		span.textContent = translate("app.link.badge.active");
	}
	return span;
}

function renderLinkCard(l) {
	const row = document.createElement("div");
	row.className = "link-row";

	// ── Head: title + badge + action buttons ──
	const head = document.createElement("div");
	head.className = "link-head";

	const info = document.createElement("div");
	info.className = "link-info";

	const actions = document.createElement("div");
	actions.className = "link-actions";

	const titleDisplay = document.createElement("span");
	titleDisplay.className = "link-title";

	const aliasDisplay = document.createElement("span");
	aliasDisplay.className = "link-alias";

	const titleInput = document.createElement("input");
	titleInput.type = "text";
	titleInput.value = l.title || "";
	titleInput.placeholder = translate("app.create.title_field.placeholder");
	titleInput.className = "link-inline-input";
	titleInput.style.display = "none";

	const aliasInput = document.createElement("input");
	aliasInput.type = "text";
	aliasInput.value = l.short_code;
	aliasInput.placeholder = translate("app.create.alias.placeholder");
	aliasInput.title = translate("app.create.alias.title");
	aliasInput.pattern = "[a-zA-Z0-9_-]{3,50}";
	aliasInput.className = "link-inline-input link-inline-input-alias";
	aliasInput.style.display = "none";

	function syncTitleAndAliasDisplay() {
		titleDisplay.textContent = l.title || l.short_code;
		aliasDisplay.textContent = `${translate("app.link.edit.alias")}: ${l.short_code}`;
	}
	syncTitleAndAliasDisplay();

	info.appendChild(titleDisplay);
	info.appendChild(aliasDisplay);
	info.appendChild(titleInput);
	info.appendChild(aliasInput);
	info.appendChild(makeBadge(l));

	const copyBtn = document.createElement("button");
	copyBtn.className = "btn-sm";
	copyBtn.textContent = translate("app.link.btn.copy");
	copyBtn.style.minWidth = "5.5rem";
	if (!navigator.clipboard) {
		copyBtn.style.display = "none";
	} else {
		copyBtn.addEventListener("click", () => copyToClipboard(l.short_url, copyBtn));
	}
	actions.appendChild(copyBtn);

	const editBtn = document.createElement("button");
	editBtn.className = "btn-sm btn-edit";
	editBtn.textContent = translate("app.link.btn.edit");
	actions.appendChild(editBtn);

	const saveBtn = document.createElement("button");
	saveBtn.className = "btn-sm btn-sm-primary btn-save";
	saveBtn.textContent = translate("app.link.btn.save");
	saveBtn.style.display = "none";
	actions.appendChild(saveBtn);

	const cancelBtn = document.createElement("button");
	cancelBtn.className = "btn-sm btn-sm-neutral btn-cancel";
	cancelBtn.textContent = translate("app.link.btn.cancel");
	cancelBtn.style.display = "none";
	actions.appendChild(cancelBtn);

	const toggleBtn = document.createElement("button");
	toggleBtn.className = "btn-sm";
	toggleBtn.textContent = l.is_active ? translate("app.link.btn.deactivate") : translate("app.link.btn.activate");
	toggleBtn.addEventListener("click", () => toggleLink(l.short_code, !!l.is_active));
	actions.appendChild(toggleBtn);

	const deleteBtn = document.createElement("button");
	deleteBtn.className = "btn-sm";
	deleteBtn.textContent = translate("app.link.btn.delete");
	deleteBtn.addEventListener("click", () => deleteLink(l.short_code));
	actions.appendChild(deleteBtn);

	head.appendChild(info);
	head.appendChild(actions);
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
	const clickLabel = l.click_count === 1 ? translate("app.link.click") : translate("app.link.clicks");
	let stats = `${l.click_count} ${clickLabel} · ${translate("app.link.created")} ${fmtDate(l.created_at)}`;
	if (l.expires_at) stats += ` · ${translate("app.link.expires")} ${fmtDate(l.expires_at)}`;
	metaStats.textContent = stats;
	row.appendChild(metaStats);

	let originalTitle = l.title || "";
	let originalAlias = l.short_code;

	function enterEditMode() {
		clearCardError(row);
		originalTitle = l.title || "";
		originalAlias = l.short_code;
		titleInput.value = originalTitle;
		aliasInput.value = originalAlias;

		titleDisplay.style.display = "none";
		aliasDisplay.style.display = "none";
		titleInput.style.display = "";
		aliasInput.style.display = "";
		editBtn.style.display = "none";
		saveBtn.style.display = "";
		cancelBtn.style.display = "";
		titleInput.focus();
	}

	function exitEditMode() {
		titleDisplay.style.display = "";
		aliasDisplay.style.display = "";
		titleInput.style.display = "none";
		aliasInput.style.display = "none";
		editBtn.style.display = "";
		saveBtn.style.display = "none";
		cancelBtn.style.display = "none";
	}

	editBtn.addEventListener("click", enterEditMode);
	cancelBtn.addEventListener("click", () => {
		titleInput.value = originalTitle;
		aliasInput.value = originalAlias;
		clearCardError(row);
		exitEditMode();
	});

	saveBtn.addEventListener("click", async () => {
		const newTitle = titleInput.value.trim();
		const newAlias = aliasInput.value.trim();
		clearCardError(row);
		saveBtn.disabled = true;
		cancelBtn.disabled = true;
		saveBtn.textContent = "…";

		try {
			const res = await fetch(`/api/links/${l.short_code}/update`, {
				method: "POST",
				headers: mutationHeaders("application/json"),
				body: JSON.stringify({ title: newTitle, alias: newAlias }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				showCardError(row, data.error || translate("error.app.toggle"));
				return;
			}

			l.title = data.title ?? (newTitle || null);
			l.short_code = data.short_code ?? newAlias;
			l.short_url = data.short_url ?? `${window.location.origin}/r/${l.short_code}`;

			syncTitleAndAliasDisplay();
			anchor.href = l.short_url;
			anchor.textContent = l.short_url;
			exitEditMode();
		} catch (err) {
			showCardError(row, err.message || translate("error.app.toggle"));
		} finally {
			saveBtn.disabled = false;
			cancelBtn.disabled = false;
			saveBtn.textContent = translate("app.link.btn.save");
		}
	});

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
	if (!resp.ok) throw Object.assign(new Error(resp.statusText || "Request failed"), { status: resp.status });
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
					? `${translate("app.session.expired")} ${translate("app.session.relogin")}`
					: (err.message && err.message !== "Request failed" ? err.message : translate("app.links.load.more.error"));
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
	el.textContent = translate("app.links.all_loaded");
	list.appendChild(el);
}

function showCardError(card, message) {
	let errorEl = card.querySelector(".link-card-error");
	if (!errorEl) {
		errorEl = document.createElement("p");
		errorEl.className = "link-card-error";
		card.appendChild(errorEl);
	}
	errorEl.textContent = message;
}

function clearCardError(card) {
	const errorEl = card.querySelector(".link-card-error");
	if (!errorEl) return;
	errorEl.textContent = "";
}

// ── Link actions ──────────────────────────────────────────────────────────────

async function toggleLink(code, currentIsActive) {
	const resp = await fetch(`/api/links/${code}/update`, {
		method: "POST",
		headers: mutationHeaders("application/json"),
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
			statusEl.textContent = data.error ?? translate("error.app.toggle");
			statusEl.className = "error";
		}
	}
}

async function deleteLink(code) {
	const resp = await fetch(`/api/links/${code}/delete`, {
		method: "POST",
		headers: mutationHeaders(),
	});
	if (resp.ok) {
		await loadLinks();
	} else if (resp.status === 401) {
		window.location.href = "/login";
	} else {
		const data = await resp.json().catch(() => ({}));
		const statusEl = document.getElementById("links-status");
		if (statusEl) {
			statusEl.textContent = data.error ?? translate("error.app.delete");
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
	loading.textContent = translate("app.links.loading");
	list.appendChild(loading);

	try {
		_isFetching = true;
		const data = await fetchLinks(null, 50);
		_isFetching = false;
		_nextCursor = data.nextCursor;
		list.innerHTML = "";

		if (!data.links.length) {
			const empty = document.createElement("em");
			empty.textContent = translate("app.links.empty");
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
			const msg = document.createTextNode(`${translate("app.session.expired")} `);
			const a   = document.createElement("a");
			a.href = "/login";
			a.textContent = translate("app.session.relogin");
			list.appendChild(msg);
			list.appendChild(a);
		} else {
			list.textContent = err.message && err.message !== "Request failed"
				? err.message
				: translate("app.links.load.error");
		}
	}
}

// ── Create form ───────────────────────────────────────────────────────────────

document.getElementById("create-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	setCreateStatus("submitting");
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
			headers: mutationHeaders("application/json"),
			body: JSON.stringify(body),
		});
		const data = await resp.json();
		if (!resp.ok) {
			setCreateStatus("error", data.error ?? translate("error.app.create"));
			return;
		}
		setCreateStatus("success", data.short_url);
		form.reset();
		await loadLinks();
	} catch (err) {
		setCreateStatus("error", err.message || String(err) || translate("error.app.create"));
	}
});

// ── Logout ────────────────────────────────────────────────────────────────────

document.getElementById("logout-btn").addEventListener("click", async () => {
	try {
		await fetch("/logout", {
			method: "POST",
			headers: mutationHeaders(),
		});
	} finally {
		window.location.href = "/";
	}
});

// ── Auth / session check ──────────────────────────────────────────────────────

async function loadMe() {
	authState.mode = "loading";
	authState.email = "";
	authState.errorMessage = "";
	renderAuthStatus();
	try {
		const resp = await fetch("/api/me");
		const data = await resp.json();
		if (!data.authenticated) {
			authState.mode = "anonymous";
			csrfToken = null;
			renderAuthStatus();
			return;
		}
		authState.mode = "authenticated";
		authState.email = data.user.email;
		csrfToken = data.csrfToken || null;
		renderAuthStatus();
		await loadLinks();
	} catch (err) {
		authState.mode = "error";
		authState.errorMessage = err.message || String(err);
		renderAuthStatus();
	}
}

loadMe();

// ── Location link (PWA only) ──────────────────────────────────────────────────

if (isPWA() && navigator.geolocation) {
	document.getElementById("location-section-app").style.display = "block";
}

document.getElementById("location-btn-app").addEventListener("click", () => {
	setLocationButtonState(true);

	navigator.geolocation.getCurrentPosition(
		async (pos) => {
			const { latitude, longitude } = pos.coords;
			const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
			const now = new Date().toLocaleString(getActiveLocale(), {
				day: "2-digit", month: "2-digit", year: "numeric",
				hour: "2-digit", minute: "2-digit",
			});
			try {
				const res = await fetch("/api/links", {
					method: "POST",
					headers: mutationHeaders("application/json"),
					body: JSON.stringify({
						target_url: mapsUrl,
						title: `${translate("app.location.title_prefix")} ${now}`,
					}),
				});
				const data = await res.json();
				if (!res.ok) {
					const statusEl = document.getElementById("links-status");
					if (statusEl) {
						statusEl.textContent = data.error || translate("error.app.create");
						statusEl.className = "error";
					}
					return;
				}
				await loadLinks();
			} catch (err) {
				const statusEl = document.getElementById("links-status");
				if (statusEl) {
					statusEl.textContent = err.message || translate("error.app.create");
					statusEl.className = "error";
				}
			} finally {
				setLocationButtonState(false);
			}
		},
		() => {
			setLocationButtonState(false);
			const statusEl = document.getElementById("links-status");
			if (statusEl) {
				statusEl.textContent = translate("app.location.denied");
				statusEl.className = "error";
			}
		},
		{ enableHighAccuracy: true, timeout: 10000 }
	);
});

document.addEventListener("i18n:change", () => {
	renderAuthStatus();
	renderCreateStatus();
	setLocationButtonState(isLocationBusy);
	if (authState.mode === "authenticated") {
		loadLinks();
	}
});

renderCreateStatus();
setLocationButtonState(false);

// ── Service Worker registration ───────────────────────────────────────────────

if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js");
}
