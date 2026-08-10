import { type Component, Loader, type LoaderIndicatorOptions, Text, type TUI } from "@earendil-works/pi-tui";
import { ansi256ToHex, fgAnsi, hexToRgb } from "../theme/color-utils.ts";
import { theme } from "../theme/theme.ts";

/** Orphus's literal one-cell identity follows the approved ten-step luminance ramp. */
export const ORPHUS_WORKING_FRAMES = ["∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀"] as const;
export const ORPHUS_WORKING_BOLD_PHASES = [false, false, false, false, true, true, true, false, false, false] as const;
export const ORPHUS_WORKING_FRAME_MS = 88;

export interface AtomicWorkingPalette {
	dark: string;
	lift: string;
	muted: string;
	accent: string;
	bright: string;
	peak: string;
}

export type AtomicWorkingTone = keyof AtomicWorkingPalette;

export const ORPHUS_WORKING_PHASES: readonly AtomicWorkingTone[] = [
	"dark",
	"lift",
	"muted",
	"accent",
	"bright",
	"peak",
	"bright",
	"accent",
	"muted",
	"lift",
];

export interface AtomicWorkingStatusOptions {
	frame?: number;
	message?: string;
	/** Dim parenthetical after the message, e.g. "1m 30s · ↓ 4.9k tokens". */
	stats?: string;
	palette?: AtomicWorkingPalette | (() => AtomicWorkingPalette);
	spinnerColor?: (text: string) => string;
	spinnerBoldColor?: (text: string) => string;
	messageColor?: (text: string) => string;
}

function normalizedFrameIndex(frame: number): number {
	return ((frame % ORPHUS_WORKING_FRAMES.length) + ORPHUS_WORKING_FRAMES.length) % ORPHUS_WORKING_FRAMES.length;
}

function noColorRequested(): boolean {
	return process.env.NO_COLOR !== undefined;
}

function ansiToHex(ansi: string): string | undefined {
	const rgb = /\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgb) {
		return `#${rgb
			.slice(1)
			.map((value) => Number(value).toString(16).padStart(2, "0"))
			.join("")}`;
	}
	const indexed = /\x1b\[(?:38|48);5;(\d{1,3})m/.exec(ansi);
	if (!indexed) return undefined;
	const index = Number(indexed[1]);
	return ansi256ToHex(index);
}

function mixHex(from: string, to: string, amount: number): string {
	const a = hexToRgb(from);
	const b = hexToRgb(to);
	const channel = (start: number, end: number) =>
		Math.round(start + (end - start) * amount)
			.toString(16)
			.padStart(2, "0");
	return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`;
}

function derivedThemePalette(): AtomicWorkingPalette | undefined {
	const configured = (tone: AtomicWorkingTone): string | undefined => {
		const ansi = theme.getWorkingIndicatorAnsi(tone);
		return ansi ? ansiToHex(ansi) : undefined;
	};
	const dark = configured("dark") ?? ansiToHex(theme.getBgAnsi("selectedBg"));
	const accent = configured("accent") ?? ansiToHex(theme.getFgAnsi("accent"));
	const peak = configured("peak") ?? ansiToHex(theme.getFgAnsi("text"));
	if (!dark || !accent || !peak) return undefined;
	return {
		dark,
		lift: mixHex(dark, accent, 0.25),
		muted: mixHex(dark, accent, 0.6),
		accent,
		bright: mixHex(accent, peak, 0.55),
		peak,
	};
}

function derivedThemePhaseHex(tone: AtomicWorkingTone): string | undefined {
	return derivedThemePalette()?.[tone];
}

function fallbackThemeColor(tone: AtomicWorkingTone, text: string): string {
	if (tone === "dark" || tone === "lift") return theme.fg("dim", text);
	if (tone === "bright" || tone === "peak") return theme.fg("text", text);
	return theme.fg("accent", text);
}

function colorizePhase(
	frameIndex: number,
	text: string,
	paletteOption?: AtomicWorkingPalette | (() => AtomicWorkingPalette),
): string {
	const tone = ORPHUS_WORKING_PHASES[frameIndex]!;
	if (noColorRequested()) return text;
	const palette = typeof paletteOption === "function" ? paletteOption() : paletteOption;
	if (palette) return `${fgAnsi(palette[tone], theme.getColorMode())}${text}\x1b[39m`;
	const configured = theme.getWorkingIndicatorAnsi(tone);
	if (configured) return `${configured}${text}\x1b[39m`;
	const derived = derivedThemePhaseHex(tone);
	if (derived) return `${fgAnsi(derived, theme.getColorMode())}${text}\x1b[39m`;
	return fallbackThemeColor(tone, text);
}

function emphasize(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

function styleLegacyFrame(frame: string, bold: boolean, options: AtomicWorkingStatusOptions): string | undefined {
	if (!options.spinnerColor && !options.spinnerBoldColor) return undefined;
	const regular = options.spinnerColor?.(frame) ?? theme.fg("accent", frame);
	if (!bold) return regular;
	return options.spinnerBoldColor?.(frame) ?? theme.bold(regular);
}

export class AtomicWorkingStatusComponent implements Component {
	private readonly options: AtomicWorkingStatusOptions;

	constructor(options: AtomicWorkingStatusOptions = {}) {
		this.options = options;
	}

	render(width: number): string[] {
		const reducedMotion = process.env.ORPHUS_REDUCED_MOTION === "1";
		const frameIndex = reducedMotion ? 3 : normalizedFrameIndex(this.options.frame ?? 0);
		const frame = ORPHUS_WORKING_FRAMES[frameIndex];
		const message = this.options.message ?? "Working...";
		const bold = !reducedMotion && ORPHUS_WORKING_BOLD_PHASES[frameIndex];
		const icon =
			styleLegacyFrame(frame, bold, this.options) ??
			(bold
				? emphasize(colorizePhase(frameIndex, frame, this.options.palette))
				: colorizePhase(frameIndex, frame, this.options.palette));
		const styledMessage = noColorRequested()
			? message
			: (this.options.messageColor ?? ((text: string) => theme.fg("muted", text)))(message);
		const stats = this.options.stats
			? ` ${noColorRequested() ? `(${this.options.stats})` : theme.fg("dim", `(${this.options.stats})`)}`
			: "";
		return ["", ...new Text(`${icon} ${styledMessage}${stats}`, 1, 0).render(width)];
	}
	invalidate(): void {}
}

/** Loader-compatible ordinary working surface. Explicit extension indicators delegate to pi-tui unchanged. */
export class AtomicWorkingLoader implements Component {
	private readonly ui: TUI;
	private readonly spinnerColor: ((text: string) => string) | undefined;
	private readonly messageColor: (text: string) => string;
	private readonly stats: (() => string | undefined) | undefined;
	private message: string;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private delegateGeneration = 0;
	private indicator: LoaderIndicatorOptions | undefined;
	private delegate: Loader | undefined;

	constructor(
		ui: TUI,
		spinnerColor: ((text: string) => string) | undefined,
		messageColor: (text: string) => string,
		message = "Working...",
		indicator?: LoaderIndicatorOptions,
		stats?: () => string | undefined,
	) {
		this.ui = ui;
		this.spinnerColor = spinnerColor;
		this.messageColor = messageColor;
		this.message = message;
		this.stats = stats;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		// The 88ms frame timer already drives renders, so the stats provider is
		// re-read every tick — live elapsed time without a second timer.
		return (
			this.delegate?.render(width) ??
			new AtomicWorkingStatusComponent({
				frame: this.frame,
				message: this.message,
				spinnerColor: this.spinnerColor,
				messageColor: this.messageColor,
				...(this.stats ? { stats: this.stats() } : {}),
			}).render(width)
		);
	}

	start(): void {
		if (this.indicator) {
			this.stop();
			this.createDelegate();
			return;
		}
		this.stop();
		if (process.env.ORPHUS_REDUCED_MOTION === "1") return;
		const timer = setInterval(() => {
			if (this.timer !== timer || this.delegate) return;
			this.frame = (this.frame + 1) % ORPHUS_WORKING_FRAMES.length;
			this.ui.requestRender();
		}, ORPHUS_WORKING_FRAME_MS);
		this.timer = timer;
		this.timer.unref?.();
	}

	stop(): void {
		this.delegateGeneration += 1;
		const delegate = this.delegate;
		this.delegate = undefined;
		delegate?.stop();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	setMessage(message: string): void {
		this.message = message;
		this.delegate?.setMessage(message);
		this.ui.requestRender();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.stop();
		this.indicator = indicator;
		this.frame = 0;
		if (indicator) this.createDelegate();
		else this.start();
	}

	private createDelegate(): void {
		if (!this.indicator) return;
		const generation = ++this.delegateGeneration;
		const guardedUi = {
			requestRender: () => {
				if (this.delegateGeneration === generation) this.ui.requestRender();
			},
		} as TUI;
		const spinnerColor = this.spinnerColor ?? ((text: string) => theme.fg("accent", text));
		this.delegate = new Loader(guardedUi, spinnerColor, this.messageColor, this.message, this.indicator);
	}

	invalidate(): void {}

	resetForTurn(message: string): void {
		this.message = message;
		if (this.indicator) {
			this.start();
			return;
		}
		this.frame = 0;
		this.start();
		this.ui.requestRender();
	}
}

export function atomicWorkingFrame(now = Date.now()): number {
	if (process.env.ORPHUS_REDUCED_MOTION === "1") return 3;
	return Math.floor(now / ORPHUS_WORKING_FRAME_MS) % ORPHUS_WORKING_FRAMES.length;
}

/** 45s · 1m 30s · 1h 2m — the shape users know from other harnesses. */
export function formatWorkingElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** 812 → "812"; 4900 → "4.9k". */
export function formatWorkingTokens(count: number): string {
	if (count < 1000) return String(count);
	return `${(count / 1000).toFixed(1)}k`;
}
