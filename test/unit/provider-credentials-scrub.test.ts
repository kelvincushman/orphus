import assert from "node:assert/strict";
import { test } from "vitest";
import {
	isProviderCredential,
	PROVIDER_CREDENTIAL_ENV,
	scrubProviderCredentials,
} from "../../packages/coding-agent/test/helpers/provider-credentials.ts";

/**
 * The regression this file exists for: the four engine fixtures used to scrub
 * by the `_API_KEY` / `_BEARER_AUTH` suffixes alone, so an AWS key pair — which
 * matches neither — reached the child. amazon-bedrock authenticates from the
 * AWS default chain, so the fixture's model world gained bedrock's whole
 * catalog and a fallback assertion landed on `amazon.nova-lite-v1:0` instead of
 * the fixture's own provider.
 */
test("an AWS key pair is a credential even though it matches neither suffix", () => {
	for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
		assert.equal(isProviderCredential(name), true, `${name} would reach a child's model world`);
		assert.equal(name.endsWith("_API_KEY"), false, "the suffix rule alone would have caught it");
		assert.equal(name.endsWith("_BEARER_AUTH"), false, "the suffix rule alone would have caught it");
	}
});

test("both suffix rules still hold, for providers that are keyed that way", () => {
	assert.equal(isProviderCredential("GROQ_API_KEY"), true);
	assert.equal(isProviderCredential("AZURE_BEARER_AUTH"), true);
});

test("transport configuration is not a credential", () => {
	// A prefix match on AWS_ would take this with it, and a sandbox behind a
	// proxy cannot reach a provider — or anything else — without its CA bundle.
	assert.equal(isProviderCredential("AWS_CA_BUNDLE"), false);
	assert.equal(isProviderCredential("AWS_REGION"), false);
	assert.equal(isProviderCredential("HTTPS_PROXY"), false);
});

test("scrubbing removes every credential, keeps the rest, and leaves the input alone", () => {
	const input: NodeJS.ProcessEnv = {
		AWS_ACCESS_KEY_ID: "AKIA-not-real",
		AWS_SECRET_ACCESS_KEY: "secret",
		GROQ_API_KEY: "gsk-not-real",
		AWS_CA_BUNDLE: "/root/.ccr/ca-bundle.crt",
		PATH: "/usr/bin",
		EMPTY: "",
	};

	const scrubbed = scrubProviderCredentials(input);

	for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GROQ_API_KEY"]) {
		assert.ok(!(name in scrubbed), `${name} survived the scrub`);
	}
	assert.equal(scrubbed.AWS_CA_BUNDLE, "/root/.ccr/ca-bundle.crt");
	assert.equal(scrubbed.PATH, "/usr/bin");
	assert.equal(scrubbed.EMPTY, "", "an unrelated empty value must be preserved verbatim");
	assert.equal(input.AWS_ACCESS_KEY_ID, "AKIA-not-real", "the caller's environment was mutated");
});

test("Windows case-insensitivity is honoured, and only on Windows", () => {
	// Windows environment variables are case-insensitive and `Object.keys` hands
	// back the casing they were set with, so an exact match can miss one there.
	assert.equal(isProviderCredential("aws_access_key_id", "win32"), true);
	assert.equal(isProviderCredential("Groq_Api_Key", "win32"), true);

	// On POSIX the same spelling is a different variable that no SDK reads, so
	// scrubbing it would remove something harmless rather than a credential.
	assert.equal(isProviderCredential("aws_access_key_id", "linux"), false);
	assert.equal(isProviderCredential("Groq_Api_Key", "darwin"), false);

	// The conventional spelling is a credential on every platform.
	for (const platform of ["win32", "linux", "darwin"] as const) {
		assert.equal(isProviderCredential("AWS_ACCESS_KEY_ID", platform), true, `missed on ${platform}`);
	}
});

test("scrubbing carries the platform through to the matcher", () => {
	const input: NodeJS.ProcessEnv = { aws_secret_access_key: "secret", PATH: "/usr/bin" };

	assert.ok(!("aws_secret_access_key" in scrubProviderCredentials(input, "win32")));
	assert.equal(scrubProviderCredentials(input, "linux").aws_secret_access_key, "secret");
	assert.equal(scrubProviderCredentials(input, "win32").PATH, "/usr/bin");
});

test("every listed name matches neither suffix, so the list earns its place", () => {
	// A name that matches a suffix belongs to the rule, not the list; keeping it
	// in both is how the two halves drift apart.
	for (const name of PROVIDER_CREDENTIAL_ENV) {
		assert.equal(
			name.endsWith("_API_KEY") || name.endsWith("_BEARER_AUTH"),
			false,
			`${name} is already covered by a suffix rule`,
		);
	}
});
