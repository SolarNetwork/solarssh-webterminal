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
		},
	},
	reset: "\x1B[0m",
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
