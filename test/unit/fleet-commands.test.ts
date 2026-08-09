import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { createFleetCommandHandler } from "../../packages/fleet/commands/fleet-command.ts";
import { buildSetupBriefing, createFleetSetupHandler } from "../../packages/fleet/commands/fleetsetup-command.ts";

let root: string;
let cwd: string;
let agentDir: string;

const VALID = `
name: coding-team
description: A team that codes.
orchestrator:
  model: anthropic/claude-opus
teams:
  implementation:
    mode: dispatch
    members:
      - agent: worker
`;

interface Sent {
	userMessages: Array<{ content: string; options?: unknown }>;
	messages: string[];
	sessionName: string | undefined;
	setModelCalls: string[];
	setModelResult: boolean;
}

function stubs(overrides: { configured?: string[]; sessionName?: string; setModelResult?: boolean } = {}) {
	const sent: Sent = {
		userMessages: [],
		messages: [],
		sessionName: overrides.sessionName,
		setModelCalls: [],
		setModelResult: overrides.setModelResult ?? true,
	};
	const configured = overrides.configured ?? ["anthropic"];
	const pi = {
		sendUserMessage: (content: string, options?: unknown) => sent.userMessages.push({ content, options }),
		sendMessage: (message: { content: string }) => sent.messages.push(message.content),
		getSessionName: () => sent.sessionName,
		setSessionName: (name: string) => {
			sent.sessionName = name;
		},
		setModel: async (model: { provider: string; id: string }) => {
			sent.setModelCalls.push(`${model.provider}/${model.id}`);
			return sent.setModelResult;
		},
	};
	const ctx = {
		cwd,
		hasUI: false,
		modelRegistry: {
			getAll: () => [
				{ provider: "anthropic", id: "claude-opus" },
				{ provider: "openai-codex", id: "gpt-fast" },
			],
			find: (provider: string, id: string) =>
				provider === "anthropic" && id === "claude-opus" ? { provider, id } : undefined,
			getProviderAuthStatus: (provider: string) => ({ configured: configured.includes(provider) }),
		},
	};
	return { sent, pi, ctx };
}

function handlerDeps() {
	return { env: { ORPHUS_CODING_AGENT_DIR: agentDir } };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orphus-fleet-cmd-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".orphus", "fleets"), { recursive: true });
	mkdirSync(join(agentDir, "fleets"), { recursive: true });
	writeFileSync(join(cwd, ".orphus", "fleets", "coding-team.fleet.yaml"), VALID);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("/fleet", () => {
	test("bare invocation lists blueprints without triggering a turn", async () => {
		const { sent, pi, ctx } = stubs();
		await createFleetCommandHandler(pi as never, handlerDeps())("", ctx as never);
		assert.equal(sent.userMessages.length, 0);
		assert.match(sent.messages.join("\n"), /coding-team/u);
	});

	test("run sends exactly one user message carrying the rendered prompt, names the session, and pins the model", async () => {
		const { sent, pi, ctx } = stubs();
		await createFleetCommandHandler(pi as never, handlerDeps())("coding-team add a --version flag", ctx as never);
		assert.equal(sent.userMessages.length, 1);
		assert.match(sent.userMessages[0]!.content, /Fleet run: coding-team/u);
		assert.match(sent.userMessages[0]!.content, /add a --version flag/u);
		assert.equal(sent.sessionName, "fleet-coding-team-lead");
		assert.deepEqual(sent.setModelCalls, ["anthropic/claude-opus"]);
	});

	test("a pre-named session keeps its name", async () => {
		const { sent, pi, ctx } = stubs({ sessionName: "my-session" });
		await createFleetCommandHandler(pi as never, handlerDeps())("coding-team do it", ctx as never);
		assert.equal(sent.sessionName, "my-session");
	});

	test("an unconfigured orchestrator model aborts with /login guidance and no turn", async () => {
		const { sent, pi, ctx } = stubs({ setModelResult: false });
		await createFleetCommandHandler(pi as never, handlerDeps())("coding-team do it", ctx as never);
		assert.equal(sent.userMessages.length, 0);
		assert.match(sent.messages.join("\n"), /\/login anthropic/u);
	});

	test("unknown blueprint errors and lists what exists; missing task shows usage", async () => {
		const { sent, pi, ctx } = stubs();
		const handler = createFleetCommandHandler(pi as never, handlerDeps());
		await handler("ghost do it", ctx as never);
		assert.match(sent.messages.join("\n"), /coding-team/u);
		await handler("coding-team", ctx as never);
		assert.match(sent.messages.join("\n"), /usage/iu);
		assert.equal(sent.userMessages.length, 0);
	});

	test("validate subcommand reports without triggering a turn", async () => {
		const { sent, pi, ctx } = stubs();
		await createFleetCommandHandler(pi as never, handlerDeps())("validate coding-team", ctx as never);
		assert.equal(sent.userMessages.length, 0);
		assert.match(sent.messages.join("\n"), /valid/iu);
	});
});

describe("/fleetsetup", () => {
	test("headless setup sends one briefing listing ONLY configured providers and existing fleets", async () => {
		const { sent, pi, ctx } = stubs({ configured: ["anthropic"] });
		await createFleetSetupHandler(pi as never, handlerDeps())("", ctx as never);
		assert.equal(sent.userMessages.length, 1);
		const briefing = sent.userMessages[0]!.content;
		assert.match(briefing, /interview/iu);
		// The providers block is the contract: only configured providers may be
		// offered as model sources (the schema reference below it may use any
		// provider string as an example).
		const providersBlock = briefing.slice(
			briefing.indexOf("Configured providers"),
			briefing.indexOf("Existing fleets"),
		);
		assert.match(providersBlock, /anthropic/u);
		assert.doesNotMatch(providersBlock, /openai-codex/u);
		assert.match(briefing, /coding-team/u);
		assert.match(briefing, /\.fleet\.yaml/u);
	});

	test("buildSetupBriefing embeds the schema reference and the validate loop", () => {
		const briefing = buildSetupBriefing({
			schema: "SCHEMA CONTENT HERE",
			configuredProviders: ["anthropic"],
			fleets: [],
			targetDir: "/tmp/x/.orphus/fleets",
		});
		assert.match(briefing, /SCHEMA CONTENT HERE/u);
		assert.match(briefing, /fleet\(\{.*validate/su);
		assert.match(briefing, /subagent\(\{.*list/su);
	});
});
