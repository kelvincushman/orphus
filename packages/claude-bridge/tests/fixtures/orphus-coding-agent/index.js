import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".orphus";

export function getAgentDir() {
	return process.env.ORPHUS_CODING_AGENT_DIR
		?? process.env.PI_CODING_AGENT_DIR
		?? join(homedir(), ".orphus", "agent");
}

export function buildSessionContext(entries) {
	return {
		messages: entries
			.filter((entry) => entry?.type === "message" || entry?.type === "custom_message" || entry?.type === "branch_summary")
			.map((entry) => entry.message ?? entry),
	};
}

export function keyHint(_id, description) {
	return description;
}

export function formatSkillsForPrompt(skills) {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const escapeXml = (value) => value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}
