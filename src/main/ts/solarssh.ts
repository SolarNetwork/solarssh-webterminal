import $ from "jquery";
import { Modal } from "bootstrap";
import {
	InstructionStateNames,
	SshCloseCodes,
	SshCommand,
	SshSession,
	SshTerminalSettings,
} from "solarnetwork-api-core/domain";
import {
	AuthorizationV2Builder,
	HttpHeaders,
	HttpMethod,
	SolarSshApi,
	SolarSshTerminalWebSocketSubProtocol,
} from "solarnetwork-api-core/net";
import { urlQueryParse } from "solarnetwork-api-core/lib/net/urls";
import { Configuration } from "solarnetwork-api-core/lib/util";
import { NodeCredentialsFormElements, SnSettingsFormElements } from "./forms";
import { AnsiEscapes, termEscapedText, TerminalTheme } from "./utils";
import {
	ITerminalInitOnlyOptions,
	ITerminalOptions,
	Terminal,
} from "@xterm/xterm";
import { AttachAddon } from "@xterm/addon-attach";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

const ACTION_BUTTON_ANSI_COLOR = AnsiEscapes.color.bright.yellow;

const fitAddon = new FitAddon();

window.addEventListener("resize", () => {
	fitAddon.fit();
});

const enum CliWebSocketState {
	Unconfigured = 0,
	Configured = 1,
}

export default class SolarSshApp {
	readonly config: Configuration;

	readonly #snSettingsForm: HTMLFormElement;
	readonly #snSettingsElements: SnSettingsFormElements;

	readonly #terminal: Terminal;
	readonly #solarSshApi: SolarSshApi;
	readonly #termSettings;
	readonly #connectBtn: JQuery<HTMLButtonElement>;
	readonly #disconnectBtn: JQuery<HTMLButtonElement>;
	readonly #proxyBtn: JQuery<HTMLButtonElement>;
	readonly #cliBtn: JQuery<HTMLButtonElement>;

	readonly #nodeCredentialsForm: HTMLFormElement;
	readonly #nodeCredentialsElements: NodeCredentialsFormElements;
	readonly #nodeCredentialsModal: Modal;
	readonly #nodeCredentialsLoginBtn: JQuery<HTMLButtonElement>;

	#sshSession?: SshSession;
	#sshSessionEstablished: boolean = false;
	#socket?: WebSocket;
	#socketState: CliWebSocketState = CliWebSocketState.Unconfigured;
	#attachAddon?: AttachAddon;
	#credChangeTimeout?: number;
	#nodeCredChangeTimeout?: number;
	#connectDisabled: boolean = false;
	#disconnectDisabled: boolean = true;

	#guiWindow?: WindowProxy | null;

	/**
	 * Constructor.
	 * @param queryParams query parameters from `window.location.search` for example
	 */
	constructor(queryParams: string) {
		this.config = new Configuration(urlQueryParse(queryParams));

		this.#snSettingsForm =
			document.querySelector<HTMLFormElement>("#credentials")!;
		this.#snSettingsElements = this.#snSettingsForm
			.elements as unknown as SnSettingsFormElements;

		if (this.config.value("nodeId")) {
			this.#snSettingsElements.nodeId.value = this.config.value("nodeId");
		}

		this.#solarSshApi = new SolarSshApi();
		this.#termSettings = new SshTerminalSettings(
			this.config.value("lines") || 24
		);

		const opts: ITerminalOptions & ITerminalInitOnlyOptions = {
			tabStopWidth: 4,
			fontFamily: "Source Code Pro, Menlo, Roboto Mono, monospace",
			theme: TerminalTheme,
		};
		if (this.#termSettings.cols > 0 && this.#termSettings.lines > 0) {
			opts.cols = this.#termSettings.cols;
			opts.rows = this.#termSettings.lines;
		}
		this.#terminal = new Terminal(opts);

		this.#terminal.loadAddon(fitAddon);
		this.#terminal.onResize((size) => {
			this.#termSettings.cols = size.cols;
			this.#termSettings.lines = size.rows;
			/* Not finding way to tell server client new size yet...
			if (this.#socketState == CliWebSocketState.Configured) {
				this.#terminal.write("\x1B[8;" + size.rows + ";" + size.cols);
			} */
		});

		this.#terminal.loadAddon(new CanvasAddon());
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => {
				webgl.dispose();
			});
			this.#terminal.loadAddon(webgl);
		} catch (e) {
			console.warn("WebGL addon threw an exception during load", e);
		}

		this.#connectBtn = $("#connect");
		this.#disconnectBtn = $("#disconnect");
		this.#proxyBtn = $("#http-proxy");
		this.#cliBtn = $("#cli");

		this.#nodeCredentialsModal = new Modal("#node-credentials");

		this.#nodeCredentialsForm =
			document.querySelector<HTMLFormElement>("#node-credentials")!;
		this.#nodeCredentialsElements = this.#nodeCredentialsForm
			.elements as unknown as NodeCredentialsFormElements;

		this.#nodeCredentialsForm.addEventListener("hidden.bs.modal", () => {
			this.#nodeCredentialsForm.reset();
			this.#nodeCredBtnUpdateState();
		});
		this.#nodeCredentialsForm.addEventListener("shown.bs.modal", () => {
			if (!this.#nodeCredentialsElements.username.value) {
				this.#nodeCredentialsElements.username.focus();
			} else {
				this.#nodeCredentialsElements.password.focus();
			}
		});

		this.#nodeCredentialsLoginBtn = $("#cli-login");
		this.#nodeCredentialsForm.addEventListener("submit", (evt) => {
			evt.preventDefault();
			this.#cliLogin();
			return false;
		});

		this.#proxyBtn.on("click", () => this.#guiOpen());
	}

	start(): ThisType<SolarSshApp> {
		this.#terminal.open(document.getElementById("terminal")!);
		fitAddon.fit();

		this.#connectBtn.on("click", () => this.#connect());
		this.#disconnectBtn.on("click", () => this.#disconnect());
		this.#cliBtn.on("click", () => this.#nodeCredentialsModal.show());

		for (let field of [
			this.#snSettingsElements.nodeId,
			this.#snSettingsElements.token,
			this.#snSettingsElements.secret,
		]) {
			field.addEventListener("change", () => {
				clearTimeout(this.#credChangeTimeout);
				this.#connectBtnUpdateState();
			});
			field.addEventListener("keyup", () => {
				clearTimeout(this.#credChangeTimeout);
				this.#credChangeTimeout = setTimeout(
					() => this.#connectBtnUpdateState(),
					200
				);
			});
		}

		for (let field of [
			this.#nodeCredentialsElements.username,
			this.#nodeCredentialsElements.password,
		]) {
			field.addEventListener("change", () => {
				clearTimeout(this.#nodeCredChangeTimeout);
				this.#nodeCredBtnUpdateState();
			});
			field.addEventListener("keyup", () => {
				clearTimeout(this.#nodeCredChangeTimeout);
				this.#nodeCredChangeTimeout = setTimeout(
					() => this.#nodeCredBtnUpdateState(),
					200
				);
			});
		}

		this.#termWriteGreeting();
		this.#connectBtnUpdateState();
		return this;
	}

	stop(): ThisType<SolarSshApp> {
		return this;
	}

	#nodeId(): number | undefined {
		const val = this.#snSettingsElements.nodeId.valueAsNumber;
		return val || undefined;
	}

	#tokenId(): string | undefined {
		const val = this.#snSettingsElements.token.value;
		return val || undefined;
	}

	#tokenSecret(): string | undefined {
		const val = this.#snSettingsElements.secret.value;
		return val || undefined;
	}

	#termWriteEscapedText(
		esc: string,
		text: string,
		newline?: boolean,
		withoutReset?: boolean
	) {
		var value = termEscapedText(esc, text, withoutReset);
		if (newline) {
			this.#terminal.writeln(value);
		} else {
			this.#terminal.write(value);
		}
	}

	#termWriteBrightGreen(text: string, newline?: boolean) {
		this.#termWriteEscapedText(
			AnsiEscapes.color.bright.green,
			text,
			newline
		);
	}

	#termWriteBrightRed(text: string, newline?: boolean) {
		this.#termWriteEscapedText(AnsiEscapes.color.bright.red, text, newline);
	}

	#termWriteGreeting() {
		this.#terminal.writeln(
			termEscapedText(
				AnsiEscapes.color.bright.yellow,
				"Welcome to SolarNode Connect!"
			)
		);
		this.#terminal.writeln("");
		this.#terminal.writeln(
			"Fill in the node ID and token details, then click the " +
				termEscapedText(AnsiEscapes.color.bright.blue, "Connect") +
				" button to get started."
		);
	}

	#termWriteSuccess(withoutNewline?: boolean) {
		this.#termWriteBrightGreen("SUCCESS", !withoutNewline);
	}

	#termWriteFailed(withoutNewline?: boolean) {
		this.#termWriteBrightRed("FAILED", !withoutNewline);
	}

	#saveSessionJson(json: any): SshSession | undefined {
		const session = SshSession.fromJsonObject(json);
		if (session) {
			this.#sshSession = session;
			this.#solarSshApi.sshSession = session;
		}
		return session;
	}

	#setConnectDisabled(disabled: boolean) {
		this.#connectDisabled = disabled;
		this.#connectBtnUpdateState();
	}

	#setDisconnectDisabled(disabled: boolean) {
		this.#disconnectDisabled = disabled;
		this.#disconnectBtnUpdateState();
	}

	#connectAllowed(): boolean {
		const configValid = !!(
			this.#snSettingsElements.nodeId.value &&
			this.#snSettingsElements.token.value &&
			this.#snSettingsElements.secret.value
		);
		// TODO: check for existing session
		// && !activeSession
		return configValid && !this.#connectDisabled;
	}

	#connectBtnUpdateState() {
		const disabled = !this.#connectAllowed();
		this.#connectBtn.prop("disabled", disabled);
	}

	#disconnectAllowed(): boolean {
		return !this.#disconnectDisabled;
	}

	#disconnectBtnUpdateState() {
		const disabled = !this.#disconnectAllowed();
		this.#disconnectBtn.prop("disabled", disabled);
	}

	#cliBtnUpdateState() {
		const disabled = !this.#sshSessionEstablished || !!this.#socket;
		this.#cliBtn.prop("disabled", disabled);
	}

	#proxyBtnUpdateState() {
		const disabled = !this.#sshSessionEstablished;
		this.#proxyBtn.prop("disabled", disabled);
	}

	#setSshSessionEstablished(established: boolean) {
		this.#sshSessionEstablished = established;
		this.#cliBtnUpdateState();
		this.#proxyBtnUpdateState();
	}

	/**
	 * Execute an HTTP request.
	 *
	 * @param method the HTTP method
	 * @param url  the URL to request
	 * @param auth the authorization builder to use
	 * @param directAuth `true` to use the `Authorization` header, `false` to use the `X-SN-PreSignedAuthorization` header
	 * @returns promise for the response
	 */
	#executeWithAuthorization(
		method: HttpMethod,
		url: string,
		auth: AuthorizationV2Builder,
		directAuth?: boolean
	): Promise<Response> {
		auth.tokenId = this.#tokenId();
		const headers = new Headers();
		headers.set(HttpHeaders.ACCEPT, "application/json");
		headers.set(
			directAuth
				? HttpHeaders.AUTHORIZATION
				: HttpHeaders.X_SN_PRE_SIGNED_AUTHORIZATION,
			auth.build(this.#tokenSecret()!)
		);
		headers.set(HttpHeaders.X_SN_DATE, auth.requestDateHeaderValue!);
		if (directAuth) {
			if (auth.httpHeaders.firstValue(HttpHeaders.CONTENT_TYPE)) {
				headers.set(
					HttpHeaders.CONTENT_TYPE,
					auth.httpHeaders.firstValue(HttpHeaders.CONTENT_TYPE)
				);
			}
			if (auth.httpHeaders.firstValue(HttpHeaders.DIGEST)) {
				headers.set(
					HttpHeaders.DIGEST,
					auth.httpHeaders.firstValue(HttpHeaders.DIGEST)
				);
			}
		}
		console.debug("Requesting %s %s", method, url);
		return fetch(url, {
			method: method,
			headers: headers,
		});
	}

	/**
	 * Start a new SolarSSH session.
	 */
	#connect() {
		this.#setConnectDisabled(true);
		this.#setDisconnectDisabled(true);
		const nodeId = this.#nodeId();
		this.#terminal.writeln("");
		this.#terminal.write("Creating new session...");
		this.#executeWithAuthorization(
			HttpMethod.GET,
			this.#solarSshApi.createSshSessionUrl(nodeId),
			this.#solarSshApi.createSshSessionAuthBuilder(nodeId)
		)
			.then(async (res) => {
				// create session response
				const json = await res.json();
				if (!(json.success && json.data && json.data.sessionId)) {
					console.error(
						"Failed to create session; response = %s",
						JSON.stringify(json)
					);
					throw Error("Failed to create session: " + json.message);
				}
				this.#termWriteSuccess();
				let session = this.#saveSessionJson(json.data)!;
				console.info("Created session %s", session.sessionId);
				// start the session now
				this.#terminal.write("Requesting SolarNode to connect... ");
				return this.#executeWithAuthorization(
					HttpMethod.GET,
					this.#solarSshApi.startSshSessionUrl(session.sessionId),
					this.#solarSshApi.startSshSessionAuthBuilder()
				);
			})
			.then(async (res) => {
				// start session response
				const json = await res.json();
				if (!(json.success && json.data && json.data.sessionId)) {
					console.error(
						"Failed to start session; response = %s",
						JSON.stringify(json)
					);
					throw Error("Failed to start session: " + json.message);
				}
				console.info("Started session %s", this.#sshSession!.sessionId);
				this.#termWriteSuccess();
				const session = this.#saveSessionJson(json.data)!;
				this.#setDisconnectDisabled(false);
				this.#waitForStartRemoteSsh(session);
			})
			.catch((err) => {
				console.error("Failed to create session: %s", err);
				this.#termWriteFailed();
				this.#termWriteBrightRed(
					"Failed to start new SSH session: " + err,
					true
				);
				this.#setConnectDisabled(false);
				this.#setDisconnectDisabled(true);
			});
	}

	#disconnect() {
		if (this.#socket) {
			this.#resetWebSocket();
			this.#terminal.writeln("");
		}
		const session = this.#sshSession;
		if (!session) {
			return;
		}
		this.#sshSessionEstablished = false;
		this.#terminal.writeln("");
		this.#terminal.write("Requesting SolarNode to disconnect... ");
		this.#executeWithAuthorization(
			HttpMethod.GET,
			this.#solarSshApi.stopSshSessionUrl(session.sessionId),
			this.#solarSshApi.stopSshSessionAuthBuilder(session)
		)
			.then(async () => {
				// stop session response
				console.info("Stopped session %s", session.sessionId);
				this.#termWriteSuccess();
			})
			.catch((err) => {
				console.error("Failed to stop session: %s", err);
				this.#termWriteFailed();
			})
			.finally(() => {
				this.#terminal.writeln("");
				this.#terminal.writeln(
					"Session ended. Start another by clicking the " +
						termEscapedText(
							AnsiEscapes.color.bright.blue,
							"Connect"
						) +
						" button."
				);
				this.#reset();
			});
	}

	#resetWebSocket() {
		if (this.#socket) {
			this.#socket.close();
			this.#socket = undefined;
		}
		this.#socketState = CliWebSocketState.Unconfigured;
	}

	#reset(clear?: boolean) {
		this.#resetWebSocket();
		this.#sshSession = undefined;
		if (clear) {
			this.#terminal.clear();
			this.#termWriteGreeting();
		}
		this.#setConnectDisabled(false);
		this.#setDisconnectDisabled(true);
		this.#setSshSessionEstablished(false);
		if (this.#guiWindow) {
			this.#guiWindow = undefined;
		}
	}

	#waitForStartRemoteSsh(session: SshSession) {
		this.#terminal.write("Waiting for SolarNode to connect...");
		const url = this.#solarSshApi.viewStartRemoteSshInstructionUrl(session);
		const executeQuery = () => {
			var auth =
				this.#solarSshApi.viewStartRemoteSshInstructionAuthBuilder(
					session
				);
			this.#executeWithAuthorization(HttpMethod.GET, url, auth, true)
				.then(async (res) => {
					const json = await res.json();
					if (!(json.success && json.data && json.data.state)) {
						console.error(
							"Failed to query StartRemoteSsh instruction %d: %s",
							session.startInstructionId,
							JSON.stringify(json)
						);
						throw Error(
							"Failed to query StartRemoteSsh instruction status: " +
								json.message
						);
					}
					var state = json.data.state;
					if (InstructionStateNames.Completed === state) {
						// off to the races!
						this.#terminal.write(" ");
						this.#termWriteSuccess();
						this.#setSshSessionEstablished(true);
						this.#terminal.writeln(
							"Use the " +
								termEscapedText(
									ACTION_BUTTON_ANSI_COLOR,
									"CLI"
								) +
								" or " +
								termEscapedText(
									ACTION_BUTTON_ANSI_COLOR,
									"GUI"
								) +
								" buttons to interact with SolarNode."
						);
					} else if (InstructionStateNames.Declined === state) {
						throw new Error(
							"StartRemoteSsh instruction has been declined."
						);
					} else {
						// still waiting... try again in a little bit
						this.#terminal.write(".");
						setTimeout(() => executeQuery(), 10000);
					}
				})
				.catch((err) => {
					// bummer!
					this.#terminal.write(" ");
					this.#termWriteFailed();
					this.#termWriteBrightRed(err.message, true);
					setTimeout(() => {
						this.#disconnect();
					}, 1000);
				});
		};

		// add an initial delay of a small amount, to give MQTT based connections time to establish themselves
		setTimeout(() => executeQuery(), 4000);
	}

	#nodeCredBtnUpdateState() {
		const disabled = !(
			this.#nodeCredentialsElements.username.value &&
			this.#nodeCredentialsElements.password.value
		);
		this.#nodeCredentialsLoginBtn.prop("disabled", disabled);
	}

	#cliLogin() {
		const session = this.#sshSession;
		if (!(this.#sshSessionEstablished && session)) {
			return;
		}

		const creds: Record<string, any> = {
			username: this.#nodeCredentialsElements.username.value,
			password: this.#nodeCredentialsElements.password.value,
		};
		this.#nodeCredentialsModal.hide();

		this.#terminal.writeln("");
		this.#terminal.write(
			"Logging in to SolarNode OS as user '" + creds.username + "'... "
		);
		const url = this.#solarSshApi.terminalWebSocketUrl(session.sessionId);
		console.log(
			"Establishing web socket connection to %s using %s protocol",
			url,
			SolarSshTerminalWebSocketSubProtocol
		);

		const socket = new WebSocket(url, SolarSshTerminalWebSocketSubProtocol);
		this.#socket = socket;
		socket.onopen = () => {
			const auth = this.#solarSshApi.connectTerminalWebSocketAuthBuilder(
				session.nodeId
			);
			auth.tokenId = this.#tokenId();
			const msg = SshCommand.attachSshCommand(
				auth.build(this.#tokenSecret()!),
				auth.date(),
				creds.username,
				creds.password,
				this.#termSettings
			);

			console.info(
				"Authenticating web socket connection to node %d with username %s",
				session.nodeId,
				creds.username
			);

			// clear saved password
			delete creds.password;

			socket.send(msg.toJsonEncoding());
		};
		socket.onerror = (evt) => {
			console.error("Web socket error event: %s", JSON.stringify(evt));
		};
		socket.onmessage = (evt) => this.#webSocketMessage(evt);
		socket.onclose = (evt) => this.#webSocketClose(evt);

		this.#cliBtnUpdateState();
	}

	#webSocketClose(event: CloseEvent) {
		console.debug(
			"Web socket close event: code = %d; reason = %s",
			event.code,
			event.reason
		);
		this.#resetWebSocket();
		const terminal = this.#terminal;
		if (event.code === 1000) {
			// CLOSE_NORMAL
			if (terminal && this.#sshSessionEstablished) {
				terminal.writeln("");
				terminal.writeln(
					"Use the " +
						termEscapedText(ACTION_BUTTON_ANSI_COLOR, "CLI") +
						" button to reconnect to the CLI."
				);
				terminal.writeln(
					"The " +
						termEscapedText(ACTION_BUTTON_ANSI_COLOR, "GUI") +
						" button can still be used to view the SolarNode GUI."
				);
			}
		} else if (event.code === SshCloseCodes.AuthenticationFailure.value) {
			if (terminal) {
				this.#termWriteFailed();
				if (event.reason) {
					this.#termWriteBrightRed(event.reason, true);
				}
			}
		} else if (terminal) {
			terminal.writeln("Connection closed: " + event.reason);
		}
		this.#attachAddon?.dispose();
		this.#attachAddon = undefined;
		this.#cliBtnUpdateState();
	}

	#webSocketMessage(event: MessageEvent<any>) {
		var msg;
		if (this.#socketState === CliWebSocketState.Configured) {
			return;
		}
		try {
			msg = JSON.parse(event.data);
		} catch (e) {
			console.debug(
				"JSON parsing error [%s] on web socket event data %o",
				e,
				event.data
			);
		}
		if (msg.success) {
			this.#termWriteSuccess();
			this.#terminal.writeln("");
			this.#socketState = CliWebSocketState.Configured;
			this.#attachAddon = new AttachAddon(this.#socket!);
			this.#terminal.loadAddon(this.#attachAddon);
			this.#terminal.focus();
		} else {
			this.#termWriteFailed();
			this.#termWriteBrightRed(
				"Failed to attach to SolarNode CLI: " + event.data,
				true
			);
			this.#socket!.close();
		}
	}

	#guiOpen() {
		const sessionId = this.#sshSession?.sessionId;
		if (!sessionId) {
			return;
		}
		if (
			this.#guiWindow &&
			!this.#guiWindow.closed &&
			this.#sshSessionEstablished
		) {
			this.#guiWindow.location =
				this.#solarSshApi.httpProxyUrl(sessionId);
		} else {
			this.#guiWindow = window.open(
				this.#solarSshApi.httpProxyUrl(sessionId)
			);
		}
	}
}
