#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	COMPONENT_TARGETS,
	buildOpenMotionOrbitPayload,
	publishCloudTestToOrbit,
} from "../.github/scripts/orbit-publish-cloud-test.mjs";

const SOURCE_SHA = "a".repeat(40);
const TEST_ORBIT_API_URL = "https://orbit.example.invalid";

function sha256(text) {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function createDigestsFixture({ trailingNewline = false } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "openmotion-orbit-sync-"));
	const digests = {};
	const manifests = {};
	for (const [index, { target }] of COMPONENT_TARGETS.entries()) {
		const rawManifest = JSON.stringify({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.index.v1+json",
			target,
			manifests: [
				{
					digest: `sha256:${String(index + 1).repeat(64)}`,
					platform: { os: "linux", architecture: "amd64" },
				},
			],
		});
		const digest = sha256(rawManifest);
		digests[target] = digest;
		manifests[target] = rawManifest;
		await writeFile(join(dir, target), `${digest}\n`, "utf8");
		await writeFile(
			join(dir, `${target}.manifest.json`),
			trailingNewline ? `${rawManifest}\n` : rawManifest,
			"utf8",
		);
	}
	return { dir, digests, manifests };
}

function baseEnv(overrides = {}) {
	return {
		ORBIT_API_URL: TEST_ORBIT_API_URL,
		ORBIT_API_KEY: "orbit-legacy-key",
		ORBIT_OPENMOTION_BUILD_TOKEN: "orbit-build-token",
		GITHUB_REF: "refs/heads/feat/cloud-container-p1",
		GITHUB_SHA: SOURCE_SHA,
		GITHUB_REPOSITORY: "nexu-io/openmotion",
		GITHUB_REPOSITORY_OWNER: "Nexu-IO",
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_RUN_ID: "4492881234",
		GITHUB_RUN_ATTEMPT: "2",
		...overrides,
	};
}

test("publishes all four image digests and manifests to Orbit with idempotency", async () => {
	const { dir, digests, manifests } = await createDigestsFixture({
		trailingNewline: true,
	});
	try {
		const calls = [];
		const outputs = [];
		const summaries = [];
		for (const [key, receipt] of [
			["deploymentId", "dep_abc123"],
			["batchId", "batch_xyz789"],
		]) {
			const res = await publishCloudTestToOrbit({
				digestsDir: dir,
				env: baseEnv(),
				getRemoteHead: () => SOURCE_SHA,
				log: () => {},
				writeOutput: async (name, value) => outputs.push([name, value]),
				writeSummary: async (text) => summaries.push(text),
				fetchImpl: async (url, options) => {
					calls.push({ url, options });
					return {
						status: 202,
						text: async () =>
							JSON.stringify({
								success: true,
								mode: "desired",
								updates: [
									{
										application: "openmotion",
										filePath: "kubernetes/envs/test/openmotion/values.yaml",
										status: "queued",
										generation: 7,
										[key]: receipt,
									},
								],
							}),
					};
				},
			});
			assert.equal(res.skipped, false);
			assert.equal(res.receipt, receipt);
		}

		assert.equal(calls.length, 2);
		const first = calls[0];
		assert.equal(first.url, `${TEST_ORBIT_API_URL}/api/app/sync`);
		assert.equal(first.options.method, "POST");
		assert.equal(first.options.headers["X-Orbit-API-Key"], "orbit-legacy-key");
		assert.equal(
			first.options.headers.Authorization,
			"Bearer orbit-build-token",
		);
		assert.equal(
			first.options.headers["Idempotency-Key"],
			"nexu-io/openmotion:4492881234.2",
		);
		const body = JSON.parse(first.options.body);
		assert.equal(body.repository, "infra/apps");
		assert.equal(body.environment, "test");
		assert.equal(body.syncMode, "publishVersion");
		assert.equal(body.build.sourceRef, "feat/cloud-container-p1");
		assert.equal(
			body.build.artifact.uri,
			`ghcr.io/nexu-io/openmotion-api@${digests.api}`,
		);
		assert.equal(body.build.artifact.manifest, manifests.api);
		assert.deepEqual(
			Object.keys(body.build.artifact.images),
			["api", "workerMedia", "workerRender", "catalogSync"],
		);
		assert.deepEqual(JSON.parse(body.changes[0].valuesContent), {
			images: {
				api: { tag: `sha-${SOURCE_SHA}`, digest: digests.api },
				workerMedia: {
					tag: `sha-${SOURCE_SHA}`,
					digest: digests["worker-media"],
				},
				workerRender: {
					tag: `sha-${SOURCE_SHA}`,
					digest: digests["worker-render"],
				},
				catalogSync: {
					tag: `sha-${SOURCE_SHA}`,
					digest: digests["catalog-sync"],
				},
			},
		});
		assert.deepEqual(outputs, [
			["publication_result", "orbit_publication_accepted"],
			["publication_receipt", "dep_abc123"],
			["publication_result", "orbit_publication_accepted"],
			["publication_receipt", "batch_xyz789"],
		]);
		assert.ok(summaries[0].includes("dep_abc123"));
		assert.ok(!summaries[0].includes("orbit-build-token"));
		assert.ok(!summaries[0].includes("orbit-legacy-key"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("skips Orbit publication without calling API when a newer commit superseded head", async () => {
	const { dir } = await createDigestsFixture();
	try {
		const summaries = [];
		const result = await publishCloudTestToOrbit({
			digestsDir: dir,
			env: baseEnv(),
			getRemoteHead: () => "b".repeat(40),
			log: () => {},
			writeSummary: async (text) => summaries.push(text),
			fetchImpl: async () => {
				throw new Error("superseded run must not publish");
			},
		});
		assert.equal(result.skipped, true);
		assert.match(summaries[0], /superseded/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("rejects tampered manifests, missing artifacts, wrong branch or endpoint, and invalid receipts", async () => {
	const { dir } = await createDigestsFixture();
	try {
		const normalized = await buildOpenMotionOrbitPayload(
			baseEnv({ ORBIT_API_URL: `${TEST_ORBIT_API_URL}/` }),
			dir,
		);
		assert.equal(normalized.orbitApiUrl, TEST_ORBIT_API_URL);

		for (const badUrl of [
			"",
			"not-a-url",
			"http://orbit.example.invalid",
			"https://user:pass@orbit.example.invalid",
			"https://orbit.example.invalid/custom/path",
			"https://orbit.example.invalid/?q=1",
			"https://orbit.example.invalid/#frag",
		]) {
			await assert.rejects(
				() =>
					buildOpenMotionOrbitPayload(
						baseEnv({ ORBIT_API_URL: badUrl }),
						dir,
					),
				/ORBIT_API_URL/,
			);
		}
		await assert.rejects(
			() =>
				buildOpenMotionOrbitPayload(
					baseEnv({ GITHUB_REF: "refs/heads/main" }),
					dir,
				),
			/feat\/cloud-container-p1/,
		);
		await assert.rejects(
			() =>
				publishCloudTestToOrbit({
					digestsDir: dir,
					env: baseEnv(),
					getRemoteHead: () => SOURCE_SHA,
					log: () => {},
					fetchImpl: async () => ({
						status: 409,
						text: async () => JSON.stringify({ error: "not enrolled" }),
					}),
				}),
			/HTTP status 409/,
		);
		await assert.rejects(
			() =>
				publishCloudTestToOrbit({
					digestsDir: dir,
					env: baseEnv(),
					getRemoteHead: () => SOURCE_SHA,
					log: () => {},
					fetchImpl: async () => ({
						status: 202,
						text: async () =>
							JSON.stringify({
								success: true,
								mode: "desired",
								updates: [
									{
										application: "openmotion",
										filePath: "kubernetes/envs/test/openmotion/values.yaml",
										status: "queued",
										deploymentId: "bad-receipt",
									},
								],
							}),
					}),
				}),
			/Missing matching Orbit publication receipt/,
		);

		await writeFile(
			join(dir, "worker-render.manifest.json"),
			'{"tampered":true}',
			"utf8",
		);
		await assert.rejects(
			() => buildOpenMotionOrbitPayload(baseEnv(), dir),
			/does not match the pushed image digest for worker-render/,
		);
		await rm(join(dir, "api"));
		await assert.rejects(() => buildOpenMotionOrbitPayload(baseEnv(), dir));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("release and container image workflows wire CI + 4-image gate, manifests, and ORBIT_OPENMOTION_PULL toggle", async () => {
	const releaseWorkflow = await readFile(
		new URL("../.github/workflows/deploy-cloud-test.yml", import.meta.url),
		"utf8",
	);
	assert.match(releaseWorkflow, /branches:\s*\[feat\/cloud-container-p1\]/);
	assert.match(releaseWorkflow, /needs:\s*\[checks,\s*images\]/);
	assert.match(
		releaseWorkflow,
		/if:\s*vars\.ORBIT_OPENMOTION_PULL\s*==\s*'true'/,
	);
	assert.match(
		releaseWorkflow,
		/if:\s*vars\.ORBIT_OPENMOTION_PULL\s*!=\s*'true'/,
	);
	assert.match(
		releaseWorkflow,
		/node \.github\/scripts\/orbit-publish-cloud-test\.mjs "\$RUNNER_TEMP\/digests"/,
	);
	assert.match(
		releaseWorkflow,
		/ORBIT_API_URL:\s*\$\{\{\s*vars\.ORBIT_API_URL\s*\}\}/,
	);
	assert.doesNotMatch(releaseWorkflow, /powerformer\./i);
	assert.match(
		releaseWorkflow,
		/ORBIT_API_KEY:\s*\$\{\{\s*secrets\.ORBIT_API_KEY\s*\}\}/,
	);
	assert.match(
		releaseWorkflow,
		/ORBIT_OPENMOTION_BUILD_TOKEN:\s*\$\{\{\s*secrets\.ORBIT_OPENMOTION_BUILD_TOKEN\s*\}\}/,
	);

	const imagesWorkflow = await readFile(
		new URL("../.github/workflows/container-images.yml", import.meta.url),
		"utf8",
	);
	assert.match(imagesWorkflow, /full_sha_tag="sha-\$\{GITHUB_SHA\}"/);
	assert.match(imagesWorkflow, /\$\{image_ref\}:\$\{FULL_SHA_TAG\}/);
	assert.match(
		imagesWorkflow,
		/docker buildx imagetools inspect "\$\{IMAGE_REF\}@\$\{IMAGE_DIGEST\}" --raw > "\$RUNNER_TEMP\/\$\{TARGET\}\.manifest\.json"/,
	);
	assert.match(
		imagesWorkflow,
		/\$\{\{\s*runner\.temp\s*\}\}\/\$\{\{\s*matrix\.target\s*\}\}\.manifest\.json/,
	);
});
