import "../scss/style.scss";
import { replaceData } from "./utils.js";

import SolarSshApp from "./solarssh.js";

// populate app version and then display it
replaceData(document.querySelector<HTMLElement>("#app-version")!, {
	"app-version": APP_VERSION,
}).classList.add("d-md-block");

function startApp() {
	const app = new SolarSshApp(window.location.search);
	app.start();
	window.onbeforeunload = function () {
		app.stop();
	};
}

if (
	document.readyState === "complete" ||
	document.readyState === "interactive"
) {
	startApp();
} else {
	window.addEventListener("load", startApp);
}
