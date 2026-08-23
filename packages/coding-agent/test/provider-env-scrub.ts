/**
 * Delete ambient provider credentials before any test module loads.
 *
 * Model-world fixtures build a real ModelRuntime over pi-ai's full builtin
 * provider list, and several providers authenticate from the environment alone:
 * amazon-bedrock accepts the AWS default chain (AWS_ACCESS_KEY_ID +
 * AWS_SECRET_ACCESS_KEY, AWS_PROFILE, …), google-vertex accepts ADC. On any
 * machine with such variables set — a developer laptop with a configured AWS
 * CLI, a sandbox whose proxy injects dummy AWS keys — every "no models are
 * authenticated" fixture silently gains that provider's entire catalog, and
 * spawned CLI children inherit the same credentials and dispatch real provider
 * requests. A test that only passes on a machine without provider credentials
 * is a bug in that test; this scrub makes the whole suite hermetic instead.
 *
 * Fixtures that need a credential set their own after this runs. The suffix
 * rule mirrors the engine-fixture scrub from the root suites; the explicit
 * names are the credential variables pi-ai reads that match neither suffix.
 */
const PROVIDER_CREDENTIAL_ENV = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_PROFILE",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"HF_TOKEN",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
];

for (const name of Object.keys(process.env)) {
	if (name.endsWith("_API_KEY") || name.endsWith("_BEARER_AUTH")) delete process.env[name];
}
for (const name of PROVIDER_CREDENTIAL_ENV) delete process.env[name];
