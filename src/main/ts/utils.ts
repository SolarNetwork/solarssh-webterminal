import { ITheme } from "@xterm/xterm";

/**
 * Replace elements with `data-X` class values with the value of `X`.
 *
 * `X` stands for a property on the given `data` object.
 *
 * @param root - the root element to replace data in
 * @param data - the data to replace
 * @returns the `root` parameter
 */
export function replaceData<T extends HTMLElement>(root: T, data: any): T {
	for (const prop in data) {
		for (const el of root.querySelectorAll(
			".data-" + prop
		) as NodeListOf<HTMLElement>) {
			const val = data[prop];
			el.textContent = val !== undefined ? "" + val : "";
		}
	}
	return root;
}

export const AnsiEscapes = {
	color: {
		bright: {
			gray: "\x1B[30;1m",
			green: "\x1B[32;1m",
			red: "\x1B[31;1m",
			yellow: "\x1B[33;1m",
			white: "\x1B[37;1m",
			blue: "\x1B[34;1m",
			cyan: "\x1B[36;1m",
		},
	},
	reset: "\x1B[0m",
};

export const TerminalTheme: ITheme = {
	foreground: "#F8F8F8",
	background: "#2D2E2C",
	selectionBackground: "#5DA5D533",
	black: "#1E1E1D",
	brightBlack: "#262625",
	red: "#CE5C5C",
	brightRed: "#FF7272",
	green: "#5BCC5B",
	brightGreen: "#72FF72",
	yellow: "#CCCC5B",
	brightYellow: "#FFFF72",
	blue: "#5D5DD3",
	brightBlue: "#7279FF",
	magenta: "#BC5ED1",
	brightMagenta: "#E572FF",
	cyan: "#5DA5D5",
	brightCyan: "#72F0FF",
	white: "#F8F8F8",
	brightWhite: "#FFFFFF",
};

export function termEscapedText(
	esc: string,
	text: string,
	withoutReset?: boolean
): string {
	var value = esc + text;
	if (!withoutReset) {
		value += AnsiEscapes.reset;
	}
	return value;
}
