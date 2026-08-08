# Security Policy

## Supported Versions

Security fixes are provided for the latest released version of Orphus. Before reporting a vulnerability, confirm that it is reproducible on the latest release.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.

Use GitHub's [private vulnerability reporting form](https://github.com/kelvincushman/orphus/security/advisories/new) to submit a report confidentially. Include as much of the following information as possible:

- the affected Orphus version and platform
- a description of the vulnerability and its potential impact
- reproducible steps or a minimal proof of concept
- relevant logs, configuration, or screenshots with secrets removed
- any known mitigations or workarounds

We will acknowledge the report, investigate it, and provide status updates through the private advisory. Please allow time for a fix to be developed and released before publicly disclosing the vulnerability.

If the vulnerability is in code Orphus inherits unchanged from [Atomic](https://github.com/bastani-inc/atomic) or from Pi upstream of it, please report it to that project as well — a fix there benefits every fork. Report it here too if Orphus is affected, so this repository can track and ship the fix.

## Scope

Reports should demonstrate a security boundary violation, unauthorized access, or another concrete security impact. Orphus is a local coding agent that runs with the invoking user's permissions. Expected tool execution, access explicitly granted by the user, prompt injection from untrusted content without a privilege-boundary bypass, and behavior introduced by user-installed extensions or skills are generally outside the security boundary.

The roundtable broker is deliberately scoped to a single machine: it listens on a local socket under the agent directory, and every session that can open that socket is already running as the same user with the same permissions. Peers inside that boundary are trusted, so a report that assumes a hostile same-user process is outside the model — such a process already has a shell and does not need the broker.

Two things that look like security boundaries are not, and reports against them will be closed as working-as-designed:

- **The `librarian` write role is a coordination convention, not enforcement.** It is an in-process role-name check that prevents *accidental* concurrent memory writes. Any same-user session could invoke the memory backend directly, so no in-process check could make it a boundary. See [`docs/memory.md`](docs/memory.md).
- **Prompt injection carried in room messages** is the untrusted-content case above. It becomes a report worth filing only when it crosses a privilege boundary.

What *is* in scope for the Orphus-specific surfaces: a path that widens the broker socket beyond the local user, and a room message that inflates a peer's context past the digest bound — the digest is meant to be deterministic and model-free precisely so a verbose or hostile peer cannot spend your context. See [`packages/roundtable/DESIGN.md`](packages/roundtable/DESIGN.md) for the contract these boundaries come from.

Thank you for helping keep Orphus and its users safe.
