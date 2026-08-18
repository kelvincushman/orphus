import { existsSync } from "node:fs";
import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { ENV_AGENT_DIR, getAgentConfigPaths, getAgentDir, getEnvValue } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { createSelectorHost } from "../core/terminal/index.ts";
import { ListSelectorModel } from "../core/terminal/list-selector-model.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import {
	detectTerminalBackgroundTheme,
	initTheme,
	setTheme,
	type TerminalTheme,
} from "../modes/interactive/theme/theme.ts";

function createStartupTui(settingsManager: SettingsManager): TUI {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());
	const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

async function detectStartupTheme(ui: TUI): Promise<TerminalTheme> {
	try {
		const scheme = await ui.queryTerminalColorScheme({ timeoutMs: 100 });
		if (scheme) return scheme;
	} catch {}
	return (await detectTerminalBackgroundTheme({ ui, timeoutMs: 100 })).theme;
}

/**
 * First-run setup is eligible only in the default agent directory before
 * settings.json exists in any config-dir tier — a settings file left by a
 * fork-legacy or legacy install means this is not a first run.
 */
export function shouldRunFirstTimeSetup(
	settingsPaths: string | readonly string[] = getAgentConfigPaths("settings.json"),
): boolean {
	const paths = typeof settingsPaths === "string" ? [settingsPaths] : settingsPaths;
	return !getEnvValue(ENV_AGENT_DIR) && !paths.some((path) => existsSync(path));
}

export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) return;
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};
		void (async () => {
			ui.start();
			const detectedTheme = await detectStartupTheme(ui);
			setTheme(detectedTheme);
			const setup = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (name) => {
					setTheme(name);
					ui.requestRender();
				},
				onSubmit: (result) => {
					void finish(result);
				},
				onCancel: () => {
					void finish(undefined);
				},
			});
			ui.addChild(setup);
			ui.setFocus(setup);
			ui.requestRender();
		})();
	});
}

/**
 * Startup selection, on whichever terminal backend this session resolves to.
 *
 * The second of the two surfaces in the termDOM pilot. Like the session picker,
 * the host is disposed and that disposal awaited before this returns, so the
 * terminal is fully handed back before anything else attaches.
 */
export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());
	const { host, warning } = await createSelectorHost({ setting: settingsManager.getTuiBackend() });
	if (warning) console.error(warning);
	try {
		const result = await host.selectFromList({
			model: new ListSelectorModel(
				title,
				options.map((option) => ({ label: option.label })),
			),
		});
		return result.outcome === "selected" ? options[result.index]?.value : undefined;
	} finally {
		await host.dispose();
	}
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(input);
		ui.setFocus(input);
		ui.start();
	});
}
