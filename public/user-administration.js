(function () {
	'use strict';

	// ── State ──────────────────────────────────────────────────────────────
	let adminToken = sessionStorage.getItem('admin_token') ?? '';
	let csrfToken = '';
	let allUsers = [];
	let allLinks = [];
	let linksCursor = null;
	let linksPrevCursors = [];

	// ── DOM refs ───────────────────────────────────────────────────────────
	const tokenInput   = document.getElementById('token-input');
	const authBtn      = document.getElementById('auth-btn');
	const statusMsg    = document.getElementById('status-msg');
	const mainContent  = document.getElementById('main-content');
	const authSection  = document.getElementById('auth-section');
	const adminInfo    = document.getElementById('admin-info');
	const logoutBtn    = document.getElementById('logout-btn');
	const usersTbody   = document.getElementById('users-tbody');
	const linksTbody   = document.getElementById('links-tbody');
	const userSearch   = document.getElementById('user-search');
	const linkSearch   = document.getElementById('link-search');
	const linksPrevBtn = document.getElementById('links-prev-btn');
	const linksNextBtn = document.getElementById('links-next-btn');
	const linksPageInfo= document.getElementById('links-page-info');

	// ── Helpers ────────────────────────────────────────────────────────────
	function esc(str) {
		return String(str ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function fmtDate(iso) {
		if (!iso) return '–';
		try { return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }); }
		catch { return iso; }
	}

	function authHeaders(extra) {
		return {
			'Authorization': `Bearer ${adminToken}`,
			'X-CSRF-Token': csrfToken,
			'Content-Type': 'application/json',
			...extra
		};
	}

	function showStatus(msg, isErr) {
		statusMsg.textContent = msg;
		statusMsg.className = isErr ? 'err' : 'ok';
	}

	// ── Auth ───────────────────────────────────────────────────────────────
	async function tryAuth(token) {
		const res = await fetch('/api/me', { credentials: 'include' });
		if (!res.ok) {
			showStatus('Nicht eingeloggt. Bitte zuerst via Google anmelden.', true);
			return false;
		}
		const data = await res.json();
		if (!data.authenticated) {
			showStatus('Nicht eingeloggt. Bitte zuerst via Google anmelden.', true);
			return false;
		}
		csrfToken = data.csrfToken ?? '';

		// Verify admin token by calling a protected endpoint
		const test = await fetch('/api/admin/users', {
			credentials: 'include',
			headers: { 'Authorization': `Bearer ${token}` }
		});
		if (!test.ok) {
			showStatus('Admin-Token ungültig oder keine Berechtigung.', true);
			return false;
		}
		adminToken = token;
		sessionStorage.setItem('admin_token', token);
		adminInfo.textContent = `Eingeloggt als: ${esc(data.user?.email ?? '?')}`;
		return true;
	}

	async function login() {
		const token = tokenInput.value.trim();
		if (!token) { showStatus('Bitte Token eingeben.', true); return; }
		showStatus('Prüfe…', false);
		authBtn.disabled = true;
		try {
			const ok = await tryAuth(token);
			if (ok) {
				authSection.style.display = 'none';
				mainContent.style.display = 'block';
				await Promise.all([loadUsers(), loadLinks(null)]);
			}
		} catch (e) {
			showStatus('Fehler: ' + e.message, true);
		} finally {
			authBtn.disabled = false;
		}
	}

	authBtn.addEventListener('click', login);
	tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

	logoutBtn.addEventListener('click', () => {
		sessionStorage.removeItem('admin_token');
		adminToken = '';
		csrfToken = '';
		mainContent.style.display = 'none';
		authSection.style.display = '';
		tokenInput.value = '';
		showStatus('', false);
	});

	// ── Auto-login if token stored ─────────────────────────────────────────
	if (adminToken) {
		tokenInput.value = adminToken;
		login();
	}

	// ── Users ──────────────────────────────────────────────────────────────
	async function loadUsers() {
		const res = await fetch('/api/admin/users', {
			credentials: 'include',
			headers: { 'Authorization': `Bearer ${adminToken}` }
		});
		if (!res.ok) { alert('Fehler beim Laden der Benutzer.'); return; }
		const data = await res.json();
		allUsers = data.users ?? [];
		renderUsers();
	}

	function renderUsers() {
		const q = userSearch.value.trim().toLowerCase();
		const filtered = q ? allUsers.filter(u => (u.email ?? '').toLowerCase().includes(q)) : allUsers;
		if (!filtered.length) {
			usersTbody.innerHTML = '<tr><td colspan="5" style="color:#888;text-align:center">Keine Benutzer gefunden.</td></tr>';
			return;
		}
		usersTbody.innerHTML = filtered.map(u => `
			<tr data-uid="${esc(u.id)}">
				<td title="${esc(u.id)}">${esc(u.email ?? '–')}</td>
				<td>${u.link_count ?? 0}</td>
				<td><span class="badge ${u.is_blocked ? 'badge-yes' : 'badge-no'}">${u.is_blocked ? 'Ja' : 'Nein'}</span></td>
				<td>${fmtDate(u.created_at)}</td>
				<td>
					${u.is_blocked
						? `<button class="btn btn-unblock" data-action="unblock" data-uid="${esc(u.id)}">Entsperren</button>`
						: `<button class="btn btn-block" data-action="block" data-uid="${esc(u.id)}">Sperren</button>`
					}
					<button class="btn btn-delete" data-action="delete" data-uid="${esc(u.id)}" data-email="${esc(u.email)}">Löschen</button>
				</td>
			</tr>`).join('');
	}

	userSearch.addEventListener('input', renderUsers);

	document.getElementById('reload-users-btn').addEventListener('click', loadUsers);

	usersTbody.addEventListener('click', async e => {
		const btn = e.target.closest('button[data-action]');
		if (!btn) return;
		const action = btn.dataset.action;
		const uid = btn.dataset.uid;

		if (action === 'delete') {
			const email = btn.dataset.email;
			if (!confirm(`Benutzer "${email}" unwiderruflich löschen?\nAlle Links und Sessions werden ebenfalls gelöscht.`)) return;
		}
		if (action === 'block') {
			if (!confirm(`Benutzer sperren? Alle aktiven Sessions werden beendet.`)) return;
		}

		const method = action === 'delete' ? 'DELETE' : 'POST';
		const path = action === 'delete'
			? `/api/admin/users/${uid}`
			: `/api/admin/users/${uid}/${action}`;

		try {
			const res = await fetch(path, {
				method,
				credentials: 'include',
				headers: authHeaders()
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				alert('Fehler: ' + (err.error ?? res.status));
				return;
			}
			await loadUsers();
		} catch (e) {
			alert('Netzwerkfehler: ' + e.message);
		}
	});

	// ── Links ──────────────────────────────────────────────────────────────
	async function loadLinks(cursor) {
		const params = new URLSearchParams({ limit: '100' });
		if (cursor) params.set('cursor', cursor);
		const res = await fetch(`/api/admin/links?${params}`, {
			credentials: 'include',
			headers: { 'Authorization': `Bearer ${adminToken}` }
		});
		if (!res.ok) { alert('Fehler beim Laden der Links.'); return; }
		const data = await res.json();
		allLinks = data.links ?? [];
		linksCursor = data.nextCursor ?? null;
		linksNextBtn.disabled = !linksCursor;
		linksPrevBtn.disabled = linksPrevCursors.length === 0;
		linksPageInfo.textContent = `${allLinks.length} Links`;
		renderLinks();
	}

	function renderLinks() {
		const q = linkSearch.value.trim().toLowerCase();
		const filtered = q
			? allLinks.filter(l =>
				(l.short_code ?? '').toLowerCase().includes(q) ||
				(l.target_url ?? '').toLowerCase().includes(q) ||
				(l.user_email ?? '').toLowerCase().includes(q))
			: allLinks;
		if (!filtered.length) {
			linksTbody.innerHTML = '<tr><td colspan="9" style="color:#888;text-align:center">Keine Links gefunden.</td></tr>';
			return;
		}
		linksTbody.innerHTML = filtered.map(l => {
			const activeClass = l.is_active ? 'badge-active' : 'badge-inactive';
			return `<tr data-id="${esc(l.id)}">
				<td style="white-space:nowrap">
					<button class="btn btn-delete" data-action="delete-link" data-id="${esc(l.id)}" data-short-code="${esc(l.short_code)}" title="Link löschen">🗑</button>
				</td>
				<td><a href="/r/${esc(l.short_code)}" target="_blank" rel="noopener">${esc(l.short_code)}</a></td>
				<td><span class="truncate" title="${esc(l.target_url)}">${esc(l.target_url)}</span></td>
				<td>
					<select class="status-select" data-action="change-status" data-id="${esc(l.id)}" data-short-code="${esc(l.short_code)}" data-orig="${esc(l.status)}">
						<option value="active"${l.status === 'active' ? ' selected' : ''}>active</option>
						<option value="warning"${l.status === 'warning' ? ' selected' : ''}>warning</option>
						<option value="blocked"${l.status === 'blocked' ? ' selected' : ''}>blocked</option>
					</select>
				</td>
				<td style="white-space:nowrap">
					<input class="score-input" type="number" min="0" max="1" step="0.01"
						data-action="edit-score" data-id="${esc(l.id)}"
						value="${typeof l.spam_score === 'number' ? l.spam_score : ''}"
						placeholder="0.00" />
					<button class="btn btn-save" data-action="save-score" data-id="${esc(l.id)}" data-short-code="${esc(l.short_code)}">✓</button>
				</td>
				<td><span class="badge ${activeClass}">${l.is_active ? 'Ja' : 'Nein'}</span></td>
				<td>${l.click_count ?? 0}</td>
				<td title="${esc(l.user_id ?? '')}">${esc(l.user_email ?? '–')}</td>
				<td>${fmtDate(l.created_at)}</td>
			</tr>`;
		}).join('');
	}

	async function adminLinkAction(action, id, extra) {
		let method, body;
		if (action === 'delete-link') {
			method = 'DELETE';
			body = undefined;
		} else {
			method = 'PATCH';
			body = extra;
		}
		const res = await fetch(`/api/admin/links/${encodeURIComponent(id)}`, {
			method,
			credentials: 'include',
			headers: authHeaders(),
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			alert('Fehler: ' + (err.error ?? res.status));
			return false;
		}
		return true;
	}

	linksTbody.addEventListener('change', async e => {
		const sel = e.target.closest('select[data-action="change-status"]');
		if (!sel) return;
		const id = sel.dataset.id;
		const shortCode = sel.dataset.shortCode;
		const newStatus = sel.value;
		if (!confirm(`Status von "${shortCode}" auf "${newStatus}" setzen?\nDies setzt manual_override=1 (Wächter überschreibt nicht mehr).`)) {
			sel.value = sel.dataset.orig;
			return;
		}
		const ok = await adminLinkAction('change-status', id, { status: newStatus });
		if (ok) {
			sel.dataset.orig = newStatus;
			// update local cache
			const link = allLinks.find(l => l.id === id);
			if (link) link.status = newStatus;
		} else {
			sel.value = sel.dataset.orig;
		}
	});

	linksTbody.addEventListener('click', async e => {
		const btn = e.target.closest('button[data-action]');
		if (!btn) return;
		const action = btn.dataset.action;
		const id = btn.dataset.id;
		const shortCode = btn.dataset.shortCode;

		if (action === 'delete-link') {
			if (!confirm(`Link "${shortCode}" unwiderruflich löschen?`)) return;
			const ok = await adminLinkAction('delete-link', id);
			if (ok) {
				allLinks = allLinks.filter(l => l.id !== id);
				renderLinks();
			}
			return;
		}

		if (action === 'save-score') {
			const row = linksTbody.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
			const input = row ? row.querySelector('input[data-action="edit-score"]') : null;
			if (!input) return;
			const val = parseFloat(input.value);
			if (isNaN(val) || val < 0 || val > 1) {
				alert('Spam-Score muss zwischen 0.0 und 1.0 liegen.');
				return;
			}
			const ok = await adminLinkAction('save-score', id, { spam_score: val });
			if (ok) {
				const link = allLinks.find(l => l.id === id);
				if (link) link.spam_score = val;
			}
		}
	});

	linkSearch.addEventListener('input', renderLinks);

	document.getElementById('reload-links-btn').addEventListener('click', () => {
		linksPrevCursors = [];
		loadLinks(null);
	});

	linksNextBtn.addEventListener('click', () => {
		if (!linksCursor) return;
		linksPrevCursors.push(linksCursor);
		loadLinks(linksCursor);
	});

	linksPrevBtn.addEventListener('click', () => {
		if (!linksPrevCursors.length) return;
		linksPrevCursors.pop();
		loadLinks(linksPrevCursors.length ? linksPrevCursors[linksPrevCursors.length - 1] : null);
	});
})();
