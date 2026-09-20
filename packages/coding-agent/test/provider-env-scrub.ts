/**
 * Delete ambient provider credentials before any test module loads.
 *
 * Wired as this project's vitest `setupFiles`, so it runs once per worker
 * before the first fixture builds a model world. On any machine with provider
 * credentials set — a developer laptop with a configured AWS CLI, a sandbox
 * whose proxy injects dummy AWS keys — every "no models are authenticated"
 * fixture would otherwise gain that provider's entire catalog, and spawned CLI
 * children would inherit the same credentials and dispatch real provider
 * requests.
 *
 * Fixtures that need a credential set their own after this runs. The list and
 * the matching rules live in `helpers/provider-credentials.ts`, which the root
 * suites' engine fixtures share — they scrub a child's environment rather than
 * their own, and a second copy of the list would drift from this one.
 */

import { isProviderCredential } from "./helpers/provider-credentials.ts";

for (const name of Object.keys(process.env)) {
	if (isProviderCredential(name)) delete process.env[name];
}
