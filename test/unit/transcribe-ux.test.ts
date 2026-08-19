import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { ProtocolBackend } from "../../packages/transcribe/src/backend.js";
import {
	CATALOG_MODELS,
	getCatalogModel,
	modelDownloadUrl,
	modelsForLanguages,
} from "../../packages/transcribe/src/catalog.js";
import { TranscribeController, type TranscribeUi } from "../../packages/transcribe/src/controller.js";
import { ensureModelDownloaded, hashFile, modelPath } from "../../packages/transcribe/src/download.js";
import { createFakeChannel } from "../../packages/transcribe/src/fake-channel.js";
import { parseSettings, readSettings, writeSettings } from "../../packages/transcribe/src/settings.js";
import { downloadPrompt } from "../../packages/transcribe/src/setup.js";

const temporaryDirs: string[] = [];
afterEach(() => {
	for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "orphus-transcribe-"));
	temporaryDirs.push(dir);
	return dir;
}

interface RecordedUi extends TranscribeUi {
	readonly inserted: string[];
	readonly notices: { message: string; level: string }[];
	readonly statuses: (string | undefined)[];
	/** Deliberately absent from `TranscribeUi`; here to prove nothing calls it. */
	readonly submitted: string[];
}

function recordingUi(): RecordedUi {
	const inserted: string[] = [];
	const notices: { message: string; level: string }[] = [];
	const statuses: (string | undefined)[] = [];
	return {
		inserted,
		notices,
		statuses,
		submitted: [],
		insertText: (text) => inserted.push(text),
		notify: (message, level) => notices.push({ message, level }),
		setStatus: (text) => statuses.push(text),
	};
}

async function controller(options?: {
	channel?: ReturnType<typeof createFakeChannel>;
	resolveBackend?: () => Promise<ProtocolBackend | undefined>;
}) {
	const channel = options?.channel ?? createFakeChannel();
	const backend = new ProtocolBackend(channel);
	await backend.initialize({ modelPath: "/models/m.gguf", language: "en", sampleRate: 16_000 });
	const ui = recordingUi();
	const subject = new TranscribeController({
		ui,
		resolveBackend: options?.resolveBackend ?? (async () => backend),
	});
	return { subject, ui, channel, backend };
}

test("a transcript is pasted into the editor and never submitted", async () => {
	const { subject, ui } = await controller({
		channel: createFakeChannel({ transcript: { text: "  delete the branch  " } }),
	});

	await subject.toggle();
	assert.equal(subject.state, "recording");
	await subject.toggle();

	assert.deepEqual(ui.inserted, ["delete the branch"], "trimmed, and inserted as a draft");
	assert.deepEqual(ui.submitted, [], "dictation never sends; reading it first is the user's call");
	assert.equal(subject.state, "idle");
	assert.equal(ui.statuses.at(-1), undefined, "the status line is cleared afterwards");
});

test("the command and the shortcut are the same action, so they cannot drift", async () => {
	const { subject } = await controller();
	// Both surfaces call toggle(); there is no second entry point to keep in step.
	await subject.toggle();
	assert.equal(subject.state, "recording");
	await subject.toggle();
	assert.equal(subject.state, "idle");
});

test("escape cancels a recording and inserts nothing", async () => {
	const { subject, ui, channel } = await controller();
	await subject.toggle();

	assert.equal(await subject.cancel(), true);

	assert.equal(subject.state, "idle");
	assert.deepEqual(ui.inserted, []);
	assert.ok(channel.requests.some((request) => request.kind === "cancel"));
	assert.ok(ui.notices.some((notice) => notice.message === "Dictation cancelled."));
});

test("escape while idle is not consumed, so it still reaches whatever else wanted it", async () => {
	const { subject } = await controller();
	assert.equal(await subject.cancel(), false);
});

test("a cancel during transcription discards the transcript that arrives afterwards", async () => {
	const channel = createFakeChannel({ silentFor: ["stopAndTranscribe"] });
	const { subject, ui } = await controller({ channel });
	await subject.toggle();

	const transcribing = subject.toggle();
	assert.equal(subject.state, "transcribing");
	await subject.cancel();
	// The backend answers late; the transcript must not land in the editor.
	channel.emitRaw(`${JSON.stringify({ kind: "transcript", id: "3", text: "too late" })}\n`);
	await transcribing;

	assert.deepEqual(ui.inserted, []);
});

test("a second toggle during a slow backend resolve does not start recording twice", async () => {
	// `resolveBackend` can be first-run setup and a model download; the state is
	// still "idle" for all of it, and the shortcut can be pressed again.
	const channel = createFakeChannel();
	const backend = new ProtocolBackend(channel);
	await backend.initialize({ modelPath: "/models/m.gguf", language: "en", sampleRate: 16_000 });
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ui = recordingUi();
	const subject = new TranscribeController({
		ui,
		resolveBackend: async () => {
			await gate;
			return backend;
		},
	});

	const first = subject.toggle();
	const second = subject.toggle();
	release?.();
	await Promise.all([first, second]);

	assert.equal(subject.state, "recording");
	assert.equal(
		channel.requests.filter((request) => request.kind === "startRecording").length,
		1,
		"one keypress race must not become two recordings",
	);
});

test("escape during a slow backend resolve cancels the pending start", async () => {
	// The state is still "idle" while `resolveBackend` runs — which can be
	// first-run setup and a model download — so Escape must claim the pending
	// start rather than being ignored and watching recording begin anyway.
	const channel = createFakeChannel();
	const backend = new ProtocolBackend(channel);
	await backend.initialize({ modelPath: "/models/m.gguf", language: "en", sampleRate: 16_000 });
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ui = recordingUi();
	const subject = new TranscribeController({
		ui,
		resolveBackend: async () => {
			await gate;
			return backend;
		},
	});

	const starting = subject.toggle();
	assert.equal(subject.cancellable, true, "a start in flight is something Escape can cancel");
	assert.equal(await subject.cancel(), true);
	release?.();
	await starting;

	assert.equal(subject.state, "idle");
	assert.deepEqual(
		channel.requests.filter((request) => request.kind === "startRecording"),
		[],
		"a keystroke that asked to stop must not start recording",
	);
	assert.ok(ui.notices.some((notice) => notice.message === "Dictation cancelled."));
});

test("declining first-run setup starts nothing", async () => {
	const { subject, ui } = await controller({ resolveBackend: async () => undefined });
	await subject.toggle();
	assert.equal(subject.state, "idle");
	assert.deepEqual(ui.inserted, []);
});

test("an empty transcript says so instead of inserting nothing silently", async () => {
	const { subject, ui } = await controller({ channel: createFakeChannel({ transcript: { text: "   " } }) });
	await subject.toggle();
	await subject.toggle();
	assert.deepEqual(ui.inserted, []);
	assert.ok(ui.notices.some((notice) => notice.message === "Nothing was transcribed."));
});

test("a missing microphone is reported and leaves the controller idle", async () => {
	const { subject, ui } = await controller({
		channel: createFakeChannel({
			failures: { startRecording: { code: "no_capture_device", message: "no microphone was found" } },
		}),
	});
	await subject.toggle();
	assert.equal(subject.state, "idle");
	assert.ok(ui.notices.some((notice) => notice.level === "error" && /no microphone was found/.test(notice.message)));
});

test("settings are written atomically and owner-only", async () => {
	const dir = scratch();
	const path = join(dir, "nested", "transcribe.json");
	const settings = {
		version: 1 as const,
		preferredLanguages: ["en"],
		transcriptionLanguage: "en",
		microphone: { type: "system-default" as const },
		model: { source: "catalog" as const, id: "canary-180m-flash", path: "/models/x.gguf" },
	};

	await writeSettings(path, settings);

	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual((await readSettings(path)).settings, settings);
	assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
	// No temporary file is left behind next to it.
	assert.deepEqual(await readdir(join(dir, "nested")), ["transcribe.json"]);
});

test.runIf(process.platform !== "win32")(
	"a planted file at the old predictable temp path is never written through",
	async () => {
		// The temp name was once `<path>.<pid>.tmp` — predictable enough to
		// pre-create as a symlink and have the settings written through it. The
		// name is random now and created with `wx`; the planted link must survive
		// untouched, and its target must stay empty. (Gated: symlinks need
		// elevated rights on Windows, and the write path is platform-neutral.)
		const dir = scratch();
		const path = join(dir, "transcribe.json");
		const victim = join(dir, "victim.txt");
		await writeFile(victim, "", "utf8");
		const planted = `${path}.${process.pid}.tmp`;
		await symlink(victim, planted);

		await writeSettings(path, {
			version: 1,
			preferredLanguages: [],
			transcriptionLanguage: "auto",
			microphone: { type: "system-default" },
			model: { source: "catalog", id: "m", path: "/m.gguf" },
		});

		assert.equal(await readFile(victim, "utf8"), "", "the symlink target must not receive the settings");
		assert.ok((await lstat(planted)).isSymbolicLink(), "the planted link is not consumed or replaced");
		assert.ok((await readSettings(path)).settings, "the real settings landed beside it");
	},
);

test("a malformed or future settings file is reported rather than silently discarded", async () => {
	assert.match(parseSettings("{ not json").warning ?? "", /could not be parsed/);
	assert.match(parseSettings(JSON.stringify({ version: 99 })).warning ?? "", /version 99/);
	assert.match(parseSettings(JSON.stringify({ version: 1 })).warning ?? "", /name no model/);

	// A file written before the configurable-shortcut field was dropped still
	// parses; the unused key is simply ignored.
	const legacy = parseSettings(
		JSON.stringify({ version: 1, shortcut: "ctrl+x", model: { id: "m", path: "/m.gguf" } }),
	);
	assert.equal(legacy.warning, undefined);
	assert.ok(legacy.settings && !("shortcut" in legacy.settings));

	const dir = scratch();
	const path = join(dir, "transcribe.json");
	await writeFile(path, "{ not json", "utf8");
	assert.ok((await readSettings(path)).warning);
	assert.equal((await readSettings(join(dir, "absent.json"))).warning, undefined, "no file is not an error");
});

test("a rejected settings file is reported before setup runs again, not silently discarded", async () => {
	const dir = scratch();
	await writeFile(join(dir, "transcribe.json"), "{ not json", "utf8");

	const previous = process.env.ORPHUS_CODING_AGENT_DIR;
	process.env.ORPHUS_CODING_AGENT_DIR = dir;
	try {
		const { default: transcribeExtension } = await import("../../packages/transcribe/src/index.js");
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		transcribeExtension({
			registerCommand: (name: string, options: { handler: never }) => commands.set(name, options),
			registerShortcut: () => {},
			on: () => {},
		} as never);

		const notices: string[] = [];
		const ctx = {
			hasUI: false,
			ui: {
				notify: (message: string) => notices.push(message),
				// Declining the first question ends setup without a backend.
				input: async () => undefined,
				select: async () => undefined,
				confirm: async () => false,
				pasteToEditor: () => {},
				setStatus: () => {},
			},
		};
		await commands.get("transcribe")?.handler("", ctx);

		assert.ok(
			notices.some((notice) => /could not be parsed/.test(notice)),
			`the corrupt settings file must be reported; saw: ${JSON.stringify(notices)}`,
		);
	} finally {
		if (previous === undefined) delete process.env.ORPHUS_CODING_AGENT_DIR;
		else process.env.ORPHUS_CODING_AGENT_DIR = previous;
	}
});

test("every catalog entry is pinned to a revision, a size, a checksum, and a licence link", () => {
	assert.ok(CATALOG_MODELS.length > 0);
	for (const model of CATALOG_MODELS) {
		assert.match(model.revision, /^[0-9a-f]{40}$/, `${model.id} must pin a commit, not a branch`);
		assert.match(model.sha256, /^[0-9a-f]{64}$/, `${model.id} must carry a full SHA-256`);
		assert.ok(model.size > 0, `${model.id} must carry an exact size`);
		assert.match(model.licenseUrl, /^https:\/\//, `${model.id} must link its licence`);
		assert.match(modelDownloadUrl(model), new RegExp(`/resolve/${model.revision}/`), "the URL must use the pin");
	}
});

test("the picker narrows to models that cover the requested language", () => {
	assert.deepEqual(
		modelsForLanguages(["ja"]).map((model) => model.id),
		["whisper-medium"],
	);
	assert.ok(modelsForLanguages(["en"]).length > 1);
	assert.deepEqual(modelsForLanguages(["xx"]), []);
	assert.equal(getCatalogModel("canary-180m-flash")?.license, "cc-by-4.0");
});

test("the download prompt states the size and the licence before consent is asked", () => {
	const model = CATALOG_MODELS[0];
	const prompt = downloadPrompt(model);
	assert.match(prompt.title, new RegExp(`Download ${model.name}\\?`));
	assert.match(prompt.message, /Size:/);
	assert.match(prompt.message, new RegExp(model.licenseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(prompt.message, /verified against a pinned checksum/);
});

test("declining the prompt downloads nothing", async () => {
	const dir = scratch();
	let fetched = 0;
	const result = await ensureModelDownloaded({
		model: CATALOG_MODELS[0],
		modelsDir: dir,
		consent: async () => false,
		fetchImpl: async () => {
			fetched += 1;
			return new Response("", { status: 200 });
		},
	});
	assert.deepEqual(result, { outcome: "declined" });
	assert.equal(fetched, 0, "consent is asked before a byte moves");
});

test("a download whose checksum does not match is deleted rather than kept", async () => {
	const dir = scratch();
	const model = { ...CATALOG_MODELS[0], size: 5, sha256: "0".repeat(64) };
	const result = await ensureModelDownloaded({
		model,
		modelsDir: dir,
		consent: async () => true,
		fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4, 5])),
	});

	assert.equal(result.outcome, "failed");
	assert.match(result.outcome === "failed" ? result.reason : "", /checksum mismatch/);
	await assert.rejects(hashFile(modelPath(dir, model)), /ENOENT/, "a mismatched model must not be left on disk");
});

test("a truncated download fails on the size before the hash is even computed", async () => {
	const dir = scratch();
	const model = { ...CATALOG_MODELS[0], size: 10, sha256: "0".repeat(64) };
	const result = await ensureModelDownloaded({
		model,
		modelsDir: dir,
		consent: async () => true,
		fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
	});
	assert.equal(result.outcome, "failed");
	assert.match(result.outcome === "failed" ? result.reason : "", /expected 10 bytes, received 3/);
});

test("a verified download lands, and a second call reuses it without asking again", async () => {
	const dir = scratch();
	const bytes = new Uint8Array([9, 8, 7, 6]);
	const model = {
		...CATALOG_MODELS[0],
		size: bytes.byteLength,
		sha256: "d3e07f0b3ded15e3b4b4d5b7e9b1ba36d6e4f81cf6b1b3f88a2fd5fdb1b52dc3",
	};
	// Compute the real digest so the test asserts verification, not a guess.
	const { createHash } = await import("node:crypto");
	const digest = createHash("sha256").update(bytes).digest("hex");
	const pinned = { ...model, sha256: digest };

	let requests = 0;
	let prompts = 0;
	const download = () =>
		ensureModelDownloaded({
			model: pinned,
			modelsDir: dir,
			consent: async () => {
				prompts += 1;
				return true;
			},
			fetchImpl: async () => {
				requests += 1;
				return new Response(bytes);
			},
		});

	assert.equal((await download()).outcome, "downloaded");
	assert.equal((await download()).outcome, "already-present");
	assert.equal(requests, 1);
	assert.equal(prompts, 1, "an already-verified model is not re-requested");
	assert.equal(await hashFile(modelPath(dir, pinned)), digest);
});

test("a sink that cannot be written fails the download instead of crashing or hanging", async () => {
	const dir = scratch();
	const model = { ...CATALOG_MODELS[0], size: 3, sha256: "0".repeat(64) };
	// Occupy the partial path with a directory: the write stream cannot open it,
	// and that error must come back as `failed`, not as an unhandled "error".
	await mkdir(`${modelPath(dir, model)}.partial`, { recursive: true });

	const result = await ensureModelDownloaded({
		model,
		modelsDir: dir,
		consent: async () => true,
		fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
	});
	assert.equal(result.outcome, "failed");
});

test("progress is reported against the pinned size", async () => {
	const dir = scratch();
	const bytes = new Uint8Array(1024);
	const { createHash } = await import("node:crypto");
	const model = {
		...CATALOG_MODELS[0],
		size: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const progress: number[] = [];
	await ensureModelDownloaded({
		model,
		modelsDir: dir,
		consent: async () => true,
		onProgress: ({ receivedBytes, totalBytes }) => progress.push(receivedBytes / totalBytes),
		fetchImpl: async () => new Response(bytes),
	});
	assert.ok(progress.length > 0);
	assert.equal(progress.at(-1), 1);
});
