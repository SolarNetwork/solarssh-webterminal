import $ from "jquery";
import { Modal } from "bootstrap";
import {
	InstructionStateNames,
	SshCloseCodes,
	SshSession,
	SshTerminalSettings,
} from "solarnetwork-api-core/domain";
import {
	AuthorizationV2Builder,
	HttpHeaders,
	HttpMethod,
	SolarSshApi,
} from "solarnetwork-api-core/net";
import { urlQueryParse } from "solarnetwork-api-core/lib/net/urls";
import { Configuration } from "solarnetwork-api-core/lib/util";
import { SnSettingsFormElements } from "./forms";
import { AnsiEscapes, termEscapedText } from "./utils";
import { Terminal } from "@xterm/xterm";
import { AttachAddon } from "@xterm/addon-attach";

export default class SolarSshApp {
	readonly config: Configuration;
	readonly snSettingsForm: HTMLFormElement;
	readonly snSettingsElements: SnSettingsFormElements;

	readonly #terminal: Terminal;
	readonly #solarSshApi: SolarSshApi;
	readonly #termSettings;
	readonly #nodeCredentialsModal: Modal;
	readonly #connectBtn: JQuery<HTMLButtonElement>;
	readonly #disconnectBtn: JQuery<HTMLButtonElement>;
	readonly #proxyBtn: JQuery<HTMLButtonElement>;
	readonly #cliBtn: JQuery<HTMLButtonElement>;

	#sshSession?: SshSession;
	#sshSessionEstablished: boolean = false;
	#socket?: WebSocket;
	#attachAddon?: any;
	#credChangeTimeout?: number;
	#connectDisabled: boolean = false;
	#disconnectDisabled: boolean = true;

	#setupGuiWindow?: any;

	/**
	 * Constructor.
	 * @param queryParams query parameters from `window.location.search` for example
	 */
	constructor(queryParams: string) {
		this.config = new Configuration(
			Object.assign(
				{
					// TODO provide defaults
				},
				urlQueryParse(queryParams)
			)
		);

		this.snSettingsForm =
			document.querySelector<HTMLFormElement>("#credentials")!;
		this.snSettingsElements = this.snSettingsForm
			.elements as unknown as SnSettingsFormElements;

		this.#solarSshApi = new SolarSshApi();
		this.#termSettings = new SshTerminalSettings(
			this.config.value("cols") || 100,
			this.config.value("lines") || 24
		);

		var opts: any = {
			tabStopWidth: 4,
		};
		if (this.#termSettings.cols > 0 && this.#termSettings.lines > 0) {
			opts.cols = this.#termSettings.cols;
			opts.rows = this.#termSettings.lines;
		}
		this.#terminal = new Terminal(opts);

		this.#nodeCredentialsModal = new Modal("#node-credentials");
		this.#connectBtn = $("#connect");
		this.#disconnectBtn = $("#disconnect");
		this.#proxyBtn = $("#http-proxy");
		this.#cliBtn = $("#cli");
	}

	start(): ThisType<SolarSshApp> {
		this.#terminal.open(document.getElementById("terminal")!);

		this.#connectBtn.on("click", () => this.#connect());
		this.#disconnectBtn.on("click", () => this.#disconnect());

		for (let field of [
			this.snSettingsElements.nodeId,
			this.snSettingsElements.token,
			this.snSettingsElements.secret,
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

		this.#termWriteGreeting();
		this.#connectBtnUpdateState();
		return this;
	}

	stop(): ThisType<SolarSshApp> {
		return this;
	}

	#nodeId(): number | undefined {
		const val = this.snSettingsElements.nodeId.valueAsNumber;
		return val || undefined;
	}

	#tokenId(): string | undefined {
		const val = this.snSettingsElements.token.value;
		return val || undefined;
	}

	#tokenSecret(): string | undefined {
		const val = this.snSettingsElements.secret.value;
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
			this.snSettingsElements.nodeId.value &&
			this.snSettingsElements.token.value &&
			this.snSettingsElements.secret.value
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
		const disabled =
			!this.#sshSessionEstablished ||
			(this.#socket &&
				(this.#socket.readyState === WebSocket.CONNECTING ||
					this.#socket.readyState === WebSocket.OPEN));
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
		this.#terminal.write("Creating new SSH session...");
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
				this.#terminal.write(
					"Requesting SolarNode to establish remote SSH session... "
				);
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
		this.#terminal.write(
			"Requesting SolarNode to stop remote SSH session... "
		);
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
				setTimeout(() => {
					this.#reset();
				}, 1000);
			});
	}

	#resetWebSocket() {
		if (this.#socket) {
			this.#socket.close();
			this.#terminal.reset();
			this.#socket = undefined;
		}
	}

	#reset() {
		this.#resetWebSocket();
		this.#sshSession = undefined;
		this.#terminal.clear();
		this.#termWriteGreeting();
		this.#setConnectDisabled(false);
		this.#setDisconnectDisabled(true);
		this.#cliBtnUpdateState();
		this.#proxyBtnUpdateState();
		if (this.#setupGuiWindow) {
			this.#setupGuiWindow = undefined;
		}
	}

	#waitForStartRemoteSsh(session: SshSession) {
		this.#terminal.write(
			"Waiting for SolarNode to establish remote SSH session..."
		);
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
									AnsiEscapes.color.bright.cyan,
									"CLI"
								) +
								" or " +
								termEscapedText(
									AnsiEscapes.color.bright.cyan,
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
}
