import type { FleetBlueprint, MemberSpec, TeamSpec } from "./types.ts";

/**
 * Pure renderers turning a validated blueprint plus a task into the run prompt
 * the /fleet command injects. The prompt carries the concrete facts — rooms,
 * member names, skill unions, literal tool-call recipes — while the invariant
 * protocol (convergence discipline, failure handling, escalation) lives in the
 * fleet-orchestration skill so the community can evolve style without code.
 */

/**
 * Unique session names per team. A member with count > 1, or two members
 * sharing an agent, gets ordinal suffixes; a unique single member keeps its
 * agent name. Room cursors and attribution key on these names (see the
 * subagent `name` parameter), so they must be distinct within a room.
 */
export function memberNames(team: TeamSpec): string[] {
  const totals = new Map<string, number>();
  for (const member of team.members) {
    totals.set(member.agent, (totals.get(member.agent) ?? 0) + member.count);
  }
  const reservedSingles = new Set(
    team.members.filter((member) => (totals.get(member.agent) ?? 0) === 1).map((member) => member.agent),
  );
  const counters = new Map<string, number>();
  const used = new Set<string>();
  const names: string[] = [];
  for (const member of team.members) {
    for (let i = 0; i < member.count; i++) {
      if ((totals.get(member.agent) ?? 0) > 1) {
        let next = counters.get(member.agent) ?? 0;
        let candidate: string;
        do {
          next += 1;
          candidate = `${member.agent}-${next}`;
        } while (used.has(candidate) || reservedSingles.has(candidate));
        counters.set(member.agent, next);
        used.add(candidate);
        names.push(candidate);
      } else {
        used.add(member.agent);
        names.push(member.agent);
      }
    }
  }
  return names;
}

function skillUnion(team: TeamSpec, member: MemberSpec): string[] {
  const union = [...team.skills];
  for (const skill of member.skills) if (!union.includes(skill)) union.push(skill);
  return union;
}

interface RecipeTask {
  agent: string;
  name: string;
  task: string;
  skill?: string[];
  model?: string;
}

function recipeTasks(team: TeamSpec, taskFor: (member: MemberSpec, name: string) => string): RecipeTask[] {
  const names = memberNames(team);
  const tasks: RecipeTask[] = [];
  let cursor = 0;
  for (const member of team.members) {
    for (let i = 0; i < member.count; i++) {
      const name = names[cursor++]!;
      const skills = skillUnion(team, member);
      tasks.push({
        agent: member.agent,
        name,
        task: taskFor(member, name),
        ...(skills.length ? { skill: skills } : {}),
        ...(member.model ? { model: member.model } : {}),
      });
    }
  }
  return tasks;
}

function renderRecipe(team: TeamSpec, blueprint: FleetBlueprint, tasks: RecipeTask[]): string {
  const call = {
    tasks,
    concurrency: team.concurrency ?? blueprint.defaults.concurrency,
    ...(team.group !== undefined ? { group: team.group } : {}),
  };
  return `subagent(${JSON.stringify(call, null, 2)})`;
}

function briefLine(member: MemberSpec): string {
  if (member.brief) return ` Role brief: ${member.brief.trim()}`;
  if (member.briefPath) return ` Read your role brief first: ${member.briefPath}`;
  return "";
}

function deliberateTaskTemplate(team: TeamSpec, blueprint: FleetBlueprint, task: string) {
  const { digest, perMessage } = blueprint.defaults.budgets;
  return (member: MemberSpec, name: string): string =>
    `You are "${name}" in roundtable room #${team.room}${team.topic ? ` (topic: ${team.topic})` : ""}. ` +
    `Task under discussion: ${task}.${briefLine(member)} ` +
    `Join the room with roundtable({ action: "join", room: "${team.room}" }), post your opening position, ` +
    `then run ${team.rounds} rounds of: pull a digest (budget ${digest}, perMessage ${perMessage}), reply to what changed your view. ` +
    `Post conclusions, not transcripts. When your position is settled, post one line starting "FINAL:" and leave the room.`;
}

function dispatchTaskTemplate(task: string) {
  return (member: MemberSpec, name: string): string =>
    `You are "${name}". Complete this bounded task and return the result: ${task}.${briefLine(member)} ` +
    `State what you actually did and ran, not what you intended.`;
}

function renderDeliberatePhase(team: TeamSpec, blueprint: FleetBlueprint, task: string): string {
  const { digest, perMessage } = blueprint.defaults.budgets;
  return [
    `Deliberation — room #${team.room}, ${team.rounds} rounds per member:`,
    renderRecipe(team, blueprint, recipeTasks(team, deliberateTaskTemplate(team, blueprint, task))),
    `Members converse in the room while the call runs. When it returns, pull ONE digest to synthesize:`,
    `roundtable({ action: "digest", room: "${team.room}", budget: ${digest}, perMessage: ${perMessage} })`,
  ].join("\n");
}

function renderDispatchPhase(team: TeamSpec, blueprint: FleetBlueprint, task: string): string {
  return [`Dispatch:`, renderRecipe(team, blueprint, recipeTasks(team, dispatchTaskTemplate(task)))].join("\n");
}

function renderTeam(team: TeamSpec, blueprint: FleetBlueprint, task: string): string {
  const header = `## Team: ${team.name} — mode: ${team.mode}${team.topic ? ` — ${team.topic}` : ""}`;
  switch (team.mode) {
    case "dispatch":
      return [header, renderDispatchPhase(team, blueprint, task)].join("\n");
    case "deliberate":
      return [header, renderDeliberatePhase(team, blueprint, task)].join("\n");
    case "deliberate-then-dispatch":
      return [
        header,
        renderDeliberatePhase(team, blueprint, task),
        `Post your synthesis to #${team.room} as the decision of record, then dispatch execution with that decision embedded in each task:`,
        renderDispatchPhase(team, blueprint, task),
      ].join("\n");
  }
}

/** The complete run prompt for `/fleet <name> <task>`. */
export function renderFleetRunPrompt(blueprint: FleetBlueprint, task: string): string {
  const order = blueprint.pipeline.map(
    (name) => blueprint.teams.find((team) => team.name === name) as TeamSpec,
  );
  return [
    `# Fleet run: ${blueprint.name}`,
    ``,
    `Task: ${task}`,
    ``,
    `You are the fleet orchestrator. Load the "fleet-orchestration" skill now and follow its protocol; the facts below instantiate it for this fleet. Direct the work and check the work — do not do the members' work yourself.`,
    ``,
    `Suggested order: ${blueprint.pipeline.join(" → ")}. Adapt if the task demands it.`,
    ``,
    ...order.map((team) => renderTeam(team, blueprint, task)),
    ``,
    `Digest budgets: budget ${blueprint.defaults.budgets.digest}, perMessage ${blueprint.defaults.budgets.perMessage}. Escalate to the user with contact_supervisor semantics only where the skill says a human gate is due.`,
  ].join("\n");
}
