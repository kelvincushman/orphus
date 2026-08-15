/**
 * An opt-in jail for kernel processes.
 *
 * > **Read this before trusting it.** A jail here reduces *exposure*. It does
 * > not make untrusted code safe to run. Both profiles below are permissive by
 * > design — a REPL that cannot read the workspace or reach its own interpreter
 * > is useless — so what they buy is a smaller blast radius, not containment.
 * > `docs/repl.md` says the same thing at the top of the page, and Rule 5 of
 * > `docs/rlm-security-posture.md` requires that it keep saying it.
 *
 * Off by default. A user who has not asked for a jail gets a plain process and
 * a tool that is honest about being bash with memory; a user who asks gets a
 * documented, checkable reduction.
 *
 * The two platforms differ in what they can promise, and this module refuses to
 * paper over that: on macOS `sandbox-exec` denies writes outside an allowlist;
 * on Linux `bwrap` gives a read-only bind of the filesystem with the workspace
 * writable. Anywhere else, `jailCommand` returns the command unchanged and says
 * so, rather than pretending.
 */

export type JailPlatform = "darwin" | "linux" | "unsupported";

export interface JailRequest {
	platform: JailPlatform;
	/** The directory the kernel may write to. */
	workspace: string;
	command: string;
	args: readonly string[];
	/** Present only when the wrapper exists on this machine. */
	wrapperAvailable?: boolean;
}

export interface JailResult {
	command: string;
	args: string[];
	/** False when the command is unchanged. Callers must surface this rather than implying a jail. */
	jailed: boolean;
	/** Why it is not jailed. Present exactly when `jailed` is false. */
	reason?: string;
}

/**
 * A `sandbox-exec` profile allowing reads broadly and writes only under the
 * workspace and the temp directory.
 *
 * Deliberately not a deny-all: a Python REPL reads its stdlib, its site
 * packages, and the workspace. A profile that blocked those would be refused by
 * every user within a day, and a jail nobody enables protects nothing.
 */
export function macosSandboxProfile(workspace: string): string {
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* (subpath ${JSON.stringify(workspace)}))`,
		'(allow file-write* (subpath "/tmp"))',
		'(allow file-write* (subpath "/private/tmp"))',
		'(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
		'(allow file-write* (subpath "/dev/ptmx"))',
	].join("\n");
}

/**
 * Wrap a command so it runs jailed, or return it unchanged with a reason.
 *
 * Never silently returns an unjailed command as though it were jailed — the
 * caller has to be able to tell the user which they got.
 */
export function jailCommand(request: JailRequest): JailResult {
	const { platform, workspace, command, args } = request;
	const plain = { command, args: [...args] };

	if (request.wrapperAvailable === false) {
		return { ...plain, jailed: false, reason: `the jail wrapper for ${platform} is not installed on this machine` };
	}

	switch (platform) {
		case "darwin":
			return {
				command: "sandbox-exec",
				args: ["-p", macosSandboxProfile(workspace), command, ...args],
				jailed: true,
			};
		case "linux":
			return {
				command: "bwrap",
				args: [
					"--ro-bind",
					"/",
					"/",
					"--bind",
					workspace,
					workspace,
					"--bind",
					"/tmp",
					"/tmp",
					"--dev",
					"/dev",
					"--proc",
					"/proc",
					"--unshare-pid",
					"--die-with-parent",
					command,
					...args,
				],
				jailed: true,
			};
		default:
			return {
				...plain,
				jailed: false,
				reason: "no jail profile exists for this platform; the kernel runs with your full permissions",
			};
	}
}

/** One line for the agent and the user, stating plainly which they got. */
export function describeJail(result: JailResult): string {
	if (result.jailed) {
		return "jailed (reduces exposure — this is not a security sandbox, and untrusted code is still unsafe)";
	}
	return `NOT jailed: ${result.reason}`;
}
