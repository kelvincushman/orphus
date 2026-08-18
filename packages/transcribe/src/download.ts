import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { type CatalogModel, formatSize, modelDownloadUrl } from "./catalog.ts";

/**
 * Fetching model weights.
 *
 * Two rules, and the whole module exists to hold them:
 *
 * 1. **Nothing downloads without consent.** The prompt states the size and the
 *    licence before a byte moves, because agreeing to a licence you have not
 *    been shown is not agreement.
 * 2. **Nothing is accepted without proof.** Size, then SHA-256, against the
 *    pinned catalog entry. A file that fails either is deleted rather than left
 *    somewhere it might be loaded later.
 */

export interface DownloadConsentRequest {
	model: CatalogModel;
	sizeLabel: string;
	licenseUrl: string;
}

export type DownloadConsent = (request: DownloadConsentRequest) => Promise<boolean>;

export interface DownloadProgress {
	receivedBytes: number;
	totalBytes: number;
}

/** Only the call shape this module uses, so a test can pass a plain function. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface DownloadModelOptions {
	model: CatalogModel;
	/** Directory models are cached in. */
	modelsDir: string;
	/** Ask the user. A run with no one to ask must pass a consent that returns false. */
	consent: DownloadConsent;
	onProgress?: (progress: DownloadProgress) => void;
	signal?: AbortSignal;
	/** Injected for tests. Defaults to the global fetch. */
	fetchImpl?: FetchLike;
}

export type DownloadResult =
	| { outcome: "already-present"; path: string }
	| { outcome: "downloaded"; path: string }
	| { outcome: "declined" }
	| { outcome: "cancelled" }
	| { outcome: "failed"; reason: string };

export function modelPath(modelsDir: string, model: CatalogModel): string {
	return join(modelsDir, model.id, model.filename);
}

async function fileSize(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch {
		return undefined;
	}
}

/** SHA-256 of a file, streamed so a multi-gigabyte model never lands in memory. */
export async function hashFile(path: string): Promise<string> {
	const { createReadStream } = await import("node:fs");
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve());
	});
	return hash.digest("hex");
}

/**
 * Ensure a model is on disk, asking first and verifying after.
 *
 * A model already present is verified too: a cached file that no longer matches
 * its catalog entry is a file to re-fetch, not one to trust because it was here
 * yesterday.
 */
export async function ensureModelDownloaded(options: DownloadModelOptions): Promise<DownloadResult> {
	const { model } = options;
	const target = modelPath(options.modelsDir, model);
	const existingSize = await fileSize(target);
	if (existingSize === model.size && (await hashFile(target)) === model.sha256) {
		return { outcome: "already-present", path: target };
	}
	if (existingSize !== undefined) await rm(target, { force: true });

	const granted = await options.consent({
		model,
		sizeLabel: formatSize(model.size),
		licenseUrl: model.licenseUrl,
	});
	if (!granted) return { outcome: "declined" };

	const fetchImpl = options.fetchImpl ?? fetch;
	const partial = `${target}.partial`;
	await mkdir(dirname(target), { recursive: true });
	try {
		const response = await fetchImpl(modelDownloadUrl(model), { signal: options.signal });
		if (!response.ok || !response.body) {
			return { outcome: "failed", reason: `download failed with HTTP ${response.status}` };
		}
		// `pipeline` rather than a hand-rolled read/write loop: it owns error
		// propagation on both ends, so a sink that fails (disk full, permissions)
		// rejects the download instead of emitting an unhandled "error" and
		// leaving a drain wait that never settles.
		let received = 0;
		await pipeline(
			Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
			async function* (source: AsyncIterable<Uint8Array>) {
				for await (const value of source) {
					received += value.byteLength;
					options.onProgress?.({ receivedBytes: received, totalBytes: model.size });
					yield value;
				}
			},
			createWriteStream(partial),
			{ signal: options.signal },
		);

		if (received !== model.size) {
			await rm(partial, { force: true });
			return { outcome: "failed", reason: `expected ${model.size} bytes, received ${received}` };
		}
		const digest = await hashFile(partial);
		if (digest !== model.sha256) {
			// The bytes are wrong. Delete them: a mismatched model left on disk is
			// a model something will load later.
			await rm(partial, { force: true });
			return { outcome: "failed", reason: `checksum mismatch (got ${digest.slice(0, 12)}…)` };
		}
		await rename(partial, target);
		return { outcome: "downloaded", path: target };
	} catch (error) {
		await rm(partial, { force: true }).catch(() => undefined);
		if (options.signal?.aborted) return { outcome: "cancelled" };
		return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}
