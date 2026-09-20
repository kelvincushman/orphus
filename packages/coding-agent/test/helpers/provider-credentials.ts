/**
 * The environment variables that authenticate a model provider.
 *
 * Model-world fixtures build a real `ModelRuntime` over pi-ai's full builtin
 * provider list, and several providers authenticate from the environment alone:
 * amazon-bedrock accepts the AWS default chain, google-vertex accepts ADC. A
 * fixture that inherits them silently gains those providers' whole catalogs, so
 * a test asserting that no models are authenticated — or asserting which model a
 * fallback lands on — passes only on a machine without credentials. That is a
 * bug in the test, exactly like load sensitivity.
 *
 * Two suffixes catch most of them. The names below are the ones that match
 * neither, and they are matched exactly rather than by an `AWS_` prefix on
 * purpose: `AWS_CA_BUNDLE` configures TLS transport rather than identity, and a
 * sandbox behind a proxy needs it to reach anything at all.
 */
export const PROVIDER_CREDENTIAL_ENV: readonly string[] = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
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

/** Whether this variable authenticates a provider rather than configuring one. */
export function isProviderCredential(name: string): boolean {
	return name.endsWith("_API_KEY") || name.endsWith("_BEARER_AUTH") || PROVIDER_CREDENTIAL_ENV.includes(name);
}

/**
 * A copy of `env` with every provider credential removed.
 *
 * Non-mutating, mirroring `scrubInteractiveEngineEnv`: a fixture hands the
 * result to a child process while its own environment stays intact.
 */
export function scrubProviderCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const scrubbed: NodeJS.ProcessEnv = { ...env };
	for (const name of Object.keys(scrubbed)) {
		if (isProviderCredential(name)) delete scrubbed[name];
	}
	return scrubbed;
}
