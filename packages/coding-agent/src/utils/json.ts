/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** Strip one leading UTF-8 BOM (U+FEFF) before JSON parsing. */
export function stripJsonBom(input: string): string {
	return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/** Parse JSON read from disk, accepting files that start with a UTF-8 BOM. */
export function parseJsonFileContent(input: string): unknown {
	return JSON.parse(stripJsonBom(input));
}
