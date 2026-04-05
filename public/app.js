const button = document.getElementById("loadBtn");
const output = document.getElementById("output");

button.addEventListener("click", async () => {
	output.textContent = "Lade...";

	try {
		const response = await fetch("/api/hello");

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const data = await response.json();
		output.textContent = JSON.stringify(data, null, 2);
	} catch (error) {
		output.textContent =
			`Fehler: ${error instanceof Error ? error.message : String(error)}`;
	}
});
