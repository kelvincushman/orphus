/**
 * Declarative role manifest: the reproducibility artifact for a deliberation.
 *
 * A manifest names the task, the room, and which model plays each role. The
 * launcher turns it into concrete session commands — same roles, same models,
 * same budgets, so a deliberation can be rerun.
 */

/** One role: a name, the model behind it, and the brief that tells it its job. */
export interface RoleSpec {
  /** Room identity. Cursors and attribution are keyed by this. */
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  /** Absolute path to the role brief; undefined when the role declares none. */
  readonly briefPath?: string;
  /** Room this role joins — the per-role override, else the manifest room. */
  readonly room: string;
  /** Working directory for the session, absolute. Defaults to the manifest dir. */
  readonly cwd: string;
  /**
   * Whether the manifest set cwd at all. Comparing resolved paths loses this:
   * an explicit `cwd: .` resolves to the manifest dir yet is still a choice —
   * and under `--format orca` the difference decides whether the terminal
   * follows the worktree or the author.
   */
  readonly cwdExplicit: boolean;
  /** Orca worktree selector (`name:planner`, `path:/…`, `active`). Default "active". */
  readonly worktree: string;
}

/**
 * Digest budgets recorded for the run.
 *
 * These are defaults the roles are *instructed* to use in their footer, not a
 * runtime-enforced ceiling — the hard bound lives in `buildDigest`, which the
 * tool applies per call. Recording them here is what makes a rerun comparable.
 */
export interface RoleBudgets {
  readonly digest: number;
  readonly perMessage: number;
}

export interface RoleManifest {
  readonly task: string;
  readonly room: string;
  readonly roles: readonly RoleSpec[];
  readonly budgets: RoleBudgets;
  /** Directory the manifest was loaded from; relative paths resolve against it. */
  readonly dir: string;
  /** Absolute path of the manifest file, for error messages. */
  readonly path: string;
}

/** One session to launch: a fully-formed command line. */
export interface RoleLaunch {
  readonly role: string;
  readonly room: string;
  readonly provider: string;
  readonly model: string;
  readonly briefPath?: string;
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  readonly worktree: string;
  readonly command: string;
  readonly args: readonly string[];
  /** The generated coordination footer, passed as its own --append-system-prompt. */
  readonly footer: string;
}

export interface LaunchPlan {
  readonly task: string;
  readonly room: string;
  readonly budgets: RoleBudgets;
  readonly launches: readonly RoleLaunch[];
}

/** Thrown for any malformed manifest; message names the file and the key path. */
export class RoleManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleManifestError";
  }
}
