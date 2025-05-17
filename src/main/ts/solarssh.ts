import $ from "jquery";
import { Popover } from "bootstrap";
import {
	SshCloseCodes,
	SshSession,
	SshTerminalSettings,
} from "solarnetwork-api-core/domain";
import { SolarSshApi } from "solarnetwork-api-core/net";
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

	readonly #solarSshApi: SolarSshApi;
	readonly #termSettings;

	#sshSession?: SshSession;
	#socket?: any;
	#attachAddon?: any;
	#socketState: number = 0;
	#terminal?: Terminal;

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
	}

	start(): ThisType<SolarSshApp> {
		var opts: any = {
			tabStopWidth: 4,
		};
		if (this.#termSettings.cols > 0 && this.#termSettings.lines > 0) {
			opts.cols = this.#termSettings.cols;
			opts.rows = this.#termSettings.lines;
		}
		this.#terminal = new Terminal(opts);
		this.#terminal.open(document.getElementById("terminal")!);
		this.#termWriteGreeting();
		return this;
	}

	stop(): ThisType<SolarSshApp> {
		return this;
	}

	#nodeId(): string | undefined {
		const val = this.snSettingsElements.nodeId.value;
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
			this.#terminal?.writeln(value);
		} else {
			this.#terminal?.write(value);
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
		this.#terminal?.writeln(
			"Hello from " +
				termEscapedText(AnsiEscapes.color.bright.yellow, "Solar") +
				termEscapedText(AnsiEscapes.color.bright.gray, "SSH") +
				"!"
		);
	}

	#termWriteSuccess(withoutNewline?: boolean) {
		this.#termWriteBrightGreen("SUCCESS", !withoutNewline);
	}

	#termWriteFailed(withoutNewline?: boolean) {
		this.#termWriteBrightRed("FAILED", !withoutNewline);
	}

	#saveSessionJson(json: string) {
		const session = SshSession.fromJsonEncoding(json);
		if (session) {
			this.#sshSession = session;
			this.#solarSshApi.sshSession = session;
		}
	}
}
