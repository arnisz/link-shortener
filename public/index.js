function isPWA() {
	return window.matchMedia('(display-mode: standalone)').matches
		|| window.navigator.standalone === true;
}

function translate(key, params) {
	return typeof window.t === "function" ? window.t(key, params) : key;
}

// Auth check — redirect authenticated users straight to the app
fetch("/api/me")
	.then(r => r.json())
	.then(data => {
		if (data.authenticated) {
			window.location.replace("/app.html");
		}
	})
	.catch(() => { /* network error – stay on landing */ });

const form       = document.getElementById("anon-form");
const urlInput   = document.getElementById("anon-url");
const submitBtn  = document.getElementById("anon-submit");
const resultDiv  = document.getElementById("anon-result");
const errorMsg   = document.getElementById("anon-error-msg");
const successDiv = document.getElementById("anon-success");
const shortUrlEl = document.getElementById("anon-short-url");
const copyBtn    = document.getElementById("anon-copy");
const locationSection = document.getElementById("location-section");
const locationBtn = document.getElementById("location-btn");

let errorState = null;
let copyResetTimer = null;
let isCopyFeedbackVisible = false;
let isLocationBusy = false;

function setCopyButtonLabel() {
	copyBtn.textContent = translate(isCopyFeedbackVisible ? "result.copied" : "result.copy");
}

function setLocationButtonState(busy) {
	isLocationBusy = busy;
	locationBtn.textContent = translate(busy ? "location.detecting" : "location.button");
	locationBtn.disabled = busy;
}

function renderErrorState() {
	if (!errorState) {
		errorMsg.textContent = "";
		return;
	}

	errorMsg.textContent = errorState.key
		? translate(errorState.key, errorState.params)
		: errorState.message;
}

function showError({ key = null, params = null, message = "" } = {}) {
	errorState = key ? { key, params } : { message };
	resultDiv.style.display = "block";
	resultDiv.classList.add("error");
	renderErrorState();
	successDiv.hidden = true;
}

function showSuccess(shortUrl) {
	errorState = null;
	resultDiv.style.display = "block";
	resultDiv.classList.remove("error");
	errorMsg.textContent = "";
	shortUrlEl.textContent = shortUrl;
	successDiv.hidden = false;
}

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	submitBtn.disabled = true;
	resultDiv.style.display = "none";
	successDiv.hidden = true;

	try {
		const resp = await fetch("/api/links/anonymous", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ target_url: urlInput.value.trim() }),
		});
		const data = await resp.json().catch(() => ({}));

		if (resp.ok) {
			showSuccess(data.short_url);
			urlInput.value = "";
		} else if (resp.status === 429) {
			showError({ key: "error.ratelimit" });
		} else if (resp.status === 422) {
			showError({ key: "error.spam" });
		} else {
			showError({ message: data.error ?? translate("error.generic") });
		}
	} catch {
		showError({ key: "error.network" });
	} finally {
		submitBtn.disabled = false;
	}
});

copyBtn.addEventListener("click", () => {
	const url = shortUrlEl.textContent;
	navigator.clipboard.writeText(url).then(() => {
		isCopyFeedbackVisible = true;
		setCopyButtonLabel();
		clearTimeout(copyResetTimer);
		copyResetTimer = setTimeout(() => {
			isCopyFeedbackVisible = false;
			setCopyButtonLabel();
		}, 2000);
	}).catch(() => {
		isCopyFeedbackVisible = false;
		setCopyButtonLabel();
	});
});

// ── Location short link (PWA only) ───────────────────────────────────────────

if (isPWA() && navigator.geolocation) {
	locationSection.style.display = "block";
}

locationBtn.addEventListener("click", () => {
	setLocationButtonState(true);

	navigator.geolocation.getCurrentPosition(
		async (pos) => {
			const { latitude, longitude } = pos.coords;
			const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
			try {
				const res = await fetch("/api/links/anonymous", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ target_url: mapsUrl }),
				});
				const data = await res.json();
				if (!res.ok) {
					showError({ message: data.error || translate("error.generic") });
					return;
				}
				showSuccess(data.short_url);
			} catch (err) {
				showError({ message: err.message || translate("error.generic") });
			} finally {
				setLocationButtonState(false);
			}
		},
		() => {
			setLocationButtonState(false);
			showError({ key: "location.denied" });
		},
		{ enableHighAccuracy: true, timeout: 10000 }
	);
});

document.addEventListener("i18n:change", () => {
	renderErrorState();
	setCopyButtonLabel();
	setLocationButtonState(isLocationBusy);
});

setCopyButtonLabel();
setLocationButtonState(false);

// ── Service Worker registration ───────────────────────────────────────────────

if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js");
}
