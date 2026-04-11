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

function showError(msg) {
	resultDiv.style.display = "block";
	resultDiv.classList.add("error");
	errorMsg.textContent = msg;
	successDiv.hidden = true;
}

function showSuccess(shortUrl) {
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
			showError("Zu viele Anfragen. Bitte warte eine Minute.");
		} else if (resp.status === 422) {
			showError("Diese URL wurde als Spam erkannt und kann nicht gekürzt werden.");
		} else {
			showError(data.error ?? "Ein Fehler ist aufgetreten. Bitte versuche es erneut.");
		}
	} catch {
		showError("Netzwerkfehler. Bitte versuche es erneut.");
	} finally {
		submitBtn.disabled = false;
	}
});

copyBtn.addEventListener("click", () => {
	const url = shortUrlEl.textContent;
	navigator.clipboard.writeText(url).then(() => {
		copyBtn.textContent = "Kopiert!";
		setTimeout(() => { copyBtn.textContent = "Kopieren"; }, 2000);
	}).catch(() => {
		copyBtn.textContent = "Kopieren";
	});
});
