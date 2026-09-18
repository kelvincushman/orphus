import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "vitest";
import { createTypesafeSystemOne } from "../../packages/systemone/adapters/typesafe.ts";
import { createSystemOne, SystemOneAdapterError } from "../../packages/systemone/create.ts";
import type { ChoiceQuestion, NoulQuestion } from "../../packages/systemone/port.ts";
import { decisionOf } from "../../packages/systemone/port.ts";

const noul: NoulQuestion = { type: "noul", instructions: "Is this sufficient?" };
const choice: ChoiceQuestion = { type: "choice", criteria: { fast: null, standard: null, judgment: null } };

interface Recorded {
	readonly url: string;
	readonly method: string;
	readonly authorization?: string;
	readonly body: Record<string, unknown>;
}

async function withServer(
	respond: () => { status?: number; payload?: unknown; delayMs?: number },
	run: (input: { baseUrl: string; recorded: Recorded[] }) => Promise<void>,
): Promise<void> {
	const recorded: Recorded[] = [];
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			recorded.push({
				url: request.url ?? "",
				method: request.method ?? "",
				...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
				body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
			});
			const reply = respond();
			const send = () => {
				response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
				response.end(JSON.stringify(reply.payload ?? {}));
			};
			if (reply.delayMs === undefined) send();
			else setTimeout(send, reply.delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		await run({ baseUrl: `http://127.0.0.1:${port}`, recorded });
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("the typesafe adapter", () => {
	test("posts the wire shape the published SDK documents", async () => {
		await withServer(
			() => ({ payload: { model: "jev-latest", answers: { sufficient: { type: "noul", noul: 0.98 } } } }),
			async ({ baseUrl, recorded }) => {
				const answers = await createTypesafeSystemOne({ apiKey: "secret", baseUrl }).decide("some state", {
					sufficient: noul,
				});

				assert.equal(recorded.length, 1);
				assert.equal(recorded[0]!.method, "POST");
				assert.equal(recorded[0]!.url, "/v1/systemone");
				assert.equal(recorded[0]!.authorization, "Bearer secret");
				assert.equal(recorded[0]!.body.model, "jev-latest");
				assert.equal(recorded[0]!.body.state, "some state");
				assert.deepEqual(recorded[0]!.body.questions, { sufficient: noul });
				assert.equal(answers.sufficient!.type === "noul" && answers.sufficient.noul, 0.98);
			},
		);
	});

	test("an answer of the wrong primitive is discarded rather than misread", async () => {
		// A response answering a choice with a noul is version skew, not a
		// decision, and the safe reading of a decision we cannot interpret is
		// that there was none.
		await withServer(
			() => ({ payload: { answers: { profile: { type: "noul", noul: 0.99 } } } }),
			async ({ baseUrl }) => {
				const answers = await createTypesafeSystemOne({ apiKey: "k", baseUrl }).decide("s", { profile: choice });
				assert.equal(answers.profile!.type, "choice");
				assert.equal(decisionOf(answers.profile!, 0.01).abstain, true);
			},
		);
	});

	test("a question the response never answered abstains", async () => {
		await withServer(
			() => ({ payload: { answers: { sufficient: { type: "noul", noul: 0.9 } } } }),
			async ({ baseUrl }) => {
				const answers = await createTypesafeSystemOne({ apiKey: "k", baseUrl }).decide("s", {
					sufficient: noul,
					profile: choice,
				});
				assert.equal(decisionOf(answers.sufficient!, 0.5).abstain, false);
				assert.equal(decisionOf(answers.profile!, 0.01).abstain, true);
			},
		);
	});

	test("rate limiting and outages abstain rather than failing the run", async () => {
		// A hosted dependency must not be able to fail a run that would have
		// proceeded perfectly well without it.
		await withServer(
			() => ({ status: 429, payload: { detail: "slow down" } }),
			async ({ baseUrl }) => {
				const answers = await createTypesafeSystemOne({ apiKey: "k", baseUrl }).decide("s", { sufficient: noul });
				assert.equal(decisionOf(answers.sufficient!, 0.01).abstain, true);
			},
		);
	});

	test("a slow response abstains on the timeout", async () => {
		await withServer(
			() => ({ payload: { answers: {} }, delayMs: 200 }),
			async ({ baseUrl }) => {
				const answers = await createTypesafeSystemOne({ apiKey: "k", baseUrl, timeoutMs: 20 }).decide("s", {
					sufficient: noul,
				});
				assert.equal(decisionOf(answers.sufficient!, 0.01).abstain, true);
			},
		);
	});

	test("names the model in its id, so a comparison's receipts say which answered", () => {
		assert.equal(createTypesafeSystemOne({ apiKey: "k" }).id, "typesafe:jev-latest");
		assert.equal(createTypesafeSystemOne({ apiKey: "k", model: "jev-2026-09" }).id, "typesafe:jev-2026-09");
	});
});

describe("selecting the typesafe adapter", () => {
	test("refuses without a key rather than reaching for a hosted service unconfigured", () => {
		assert.throws(() => createSystemOne({ adapter: "typesafe" }), SystemOneAdapterError);
		assert.throws(() => createSystemOne({ adapter: "typesafe", typesafe: { apiKey: "  " } }), /TYPESAFE_API_KEY/u);
	});

	test("builds only when explicitly named and keyed", () => {
		assert.equal(createSystemOne({ adapter: "typesafe", typesafe: { apiKey: "k" } }).id, "typesafe:jev-latest");
	});

	test("no other adapter reaches the network", async () => {
		// The default path must never contact a third party. `null` is what a
		// run gets unless someone changed a setting on purpose.
		const nullAdapter = createSystemOne({ adapter: "null" });
		const answers = await nullAdapter.decide("s", { sufficient: noul });
		assert.equal(nullAdapter.id, "null@1");
		assert.equal(decisionOf(answers.sufficient!, 0.01).abstain, true);
	});
});
