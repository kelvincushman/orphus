import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";
import { theme } from "../theme/theme.ts";

const ORPHUS_FORALL_BANNER_LINES: readonly string[] = [
	" ██████╗ ██████╗ ██████╗ ██╗  ██╗██╗   ██╗███████╗",
	"██╔═══██╗██╔══██╗██╔══██╗██║  ██║██║   ██║██╔════╝",
	"██║   ██║██████╔╝██████╔╝███████║██║   ██║███████╗",
	"██║   ██║██╔══██╗██╔═══╝ ██╔══██║██║   ██║╚════██║",
	"╚██████╔╝██║  ██║██║     ██║  ██║╚██████╔╝███████║",
	" ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

/** Column where the two banner halves meet during the assembly animation. */
const BANNER_SPLIT_COLUMN = 25;

/** Box-drawing outline glyphs get the dim 'digital rain' treatment; solid blocks stay bright. */
const OUTLINE_CHARS = new Set(["╔", "╗", "╚", "╝", "═", "║"]);

export const STARTUP_ASSEMBLY_GAPS = [10, 8, 6, 4, 3, 2, 1, 1, 0] as const;
export const STARTUP_FRAME_MS = 80;
export const STARTUP_MANIFESTO = [
	"We question,",
	"we break away from what is accepted.",
	"Engineering matters.",
] as const;
const SHADOW_CHAR = "░";

function shadowGrid(): string[] {
	const blankLine = " ".repeat(ORPHUS_FORALL_BANNER_LINES[0]?.length ?? 0);
	return [...ORPHUS_FORALL_BANNER_LINES, blankLine].map((line, row) => {
		const chars = [...line];
		const previousLine = ORPHUS_FORALL_BANNER_LINES[row - 1];
		if (previousLine !== undefined) {
			for (const [column, char] of [...previousLine].entries()) {
				const shadowColumn = column + 1;
				if (char !== " " && chars[shadowColumn] === " ") chars[shadowColumn] = SHADOW_CHAR;
			}
		}
		return chars.join("");
	});
}

function noColorRequested(): boolean {
	return process.env.NO_COLOR !== undefined;
}

export function renderAtomicAssemblyBanner(gap: number, activeTheme: Theme, thinkingLevel: ThinkingLevel): string[] {
	const colorize = activeTheme.getThinkingBorderColor(thinkingLevel);
	const solid = (text: string) => activeTheme.bold(noColorRequested() ? text : colorize(text));
	const paint = (char: string) => {
		if (char === " ") return char;
		if (char === SHADOW_CHAR || OUTLINE_CHARS.has(char)) {
			return noColorRequested() ? char : activeTheme.fg("dim", char);
		}
		return solid(char);
	};
	if (gap <= 0) {
		return shadowGrid().map((line) => [...line].map(paint).join(""));
	}
	const width = ORPHUS_FORALL_BANNER_LINES[0]!.length;
	return [
		...ORPHUS_FORALL_BANNER_LINES.map((line) => {
			const cells = Array<string>(width).fill(" ");
			for (const [column, char] of [...line].entries()) {
				if (char === " ") continue;
				const shifted = column < BANNER_SPLIT_COLUMN ? column - gap : column + gap;
				if (shifted >= 0 && shifted < width) cells[shifted] = paint(char);
			}
			return cells.join("");
		}),
		" ".repeat(width),
	];
}

export function renderAtomicAnsiBanner(activeTheme: Theme, thinkingLevel: ThinkingLevel): string[] {
	return renderAtomicAssemblyBanner(0, activeTheme, thinkingLevel);
}

/** Manifesto phase: 0 none, 1–3 phrase entrance, 4 settled final treatment. */
export function renderStartupManifesto(phase: number): string[] {
	return STARTUP_MANIFESTO.map((text, index) => {
		if (phase <= index) return "";
		if (noColorRequested()) return index === 2 && phase >= 4 ? theme.bold(text) : text;
		if (index === 2 && phase >= 4) return theme.bold(theme.fg("text", text));
		return theme.fg(phase === index + 1 ? "dim" : "muted", text);
	});
}

/** Compose mark, landed identity metadata, and optional first-landing manifesto. */
export function composeStartupIdentity(
	markLines: readonly string[],
	metaLines: readonly string[],
	maxWidth?: number,
	manifestoLines: readonly string[] = [],
): string {
	const markWidth = Math.max(...markLines.map((line) => visibleWidth(line)));
	const asideWidth = Math.max(0, ...metaLines.map(visibleWidth), ...manifestoLines.map(visibleWidth));
	const wide = maxWidth === undefined || (maxWidth >= 80 && maxWidth >= markWidth + 2 + asideWidth);
	if (wide) {
		return markLines
			.map((line, index) => {
				const aside = index < 3 ? metaLines[index] : index >= 4 && index < 7 ? manifestoLines[index - 4] : "";
				return `${line}${aside ? `  ${aside}` : ""}`.trimEnd();
			})
			.join("\n");
	}
	const stacked = [...metaLines];
	if (manifestoLines.length > 0) stacked.push("", ...manifestoLines);
	if (maxWidth !== undefined && maxWidth < markWidth) return stacked.join("\n");
	return [...markLines, ...stacked].join("\n");
}
