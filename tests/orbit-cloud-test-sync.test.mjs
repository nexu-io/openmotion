#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	COMPONENT_TARGETS,
	buildOpenMotionOrbitPayload,
	isSupersededByRemoteHead,
	matchesWorkflowPath,
	parseDeployPushPaths,
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
		ORBIT_OPENMOTION_BUILD_TOKEN: "orbit-build-token",
		GITHUB_REF: "refs/heads/main",
		GITHUB_SHA: SOURCE_SHA,
		GITHUB_REPOSITORY: "nexu-io/openmotion",
		GITHUB_REPOSITORY_OWNER: "Nexu-IO",
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_RUN_ID: "4492881234",
		GITHUB_RUN_ATTEMPT: "2",
		...overrides,
	};
}

test("publishes all four image digests and manifests to /api/automation/v1/publications without legacy API key", async () => {
	const { dir, digests, manifests } = await createDigestsFixture({
		trailingNewline: true,
	});
	try {
		const calls = [];
		const outputs = [];
		const summaries = [];

		const accepted = await publishCloudTestToOrbit({
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
							releaseId: "rel_abc123",
							deploymentId: "dep_abc123",
							status: "queued",
							generation: 7,
							blockedReason: null,
						}),
				};
			},
		});
		assert.equal(accepted.skipped, false);
		assert.equal(accepted.releaseId, "rel_abc123");
		assert.equal(accepted.deploymentId, "dep_abc123");
		assert.equal(accepted.receipt, "dep_abc123");

		assert.equal(calls.length, 1);
		const first = calls[0];
		assert.equal(
			first.url,
			`${TEST_ORBIT_API_URL}/api/automation/v1/publications`,
		);
		assert.equal(first.options.method, "POST");
		assert.equal(first.options.redirect, "error");
		assert.deepEqual(Object.keys(first.options.headers).sort(), [
			"Authorization",
			"Content-Type",
			"Idempotency-Key",
		]);
		assert.equal(first.options.headers["X-Orbit-API-Key"], undefined);
		assert.equal(first.options.headers["Content-Type"], "application/json");
		assert.equal(
			first.options.headers.Authorization,
			"Bearer orbit-build-token",
		);
		assert.equal(
			first.options.headers["Idempotency-Key"],
			"nexu-io/openmotion:4492881234.2",
		);

		const body = JSON.parse(first.options.body);
		assert.deepEqual(body, {
			app: "openmotion",
			environment: "test",
			sourceSha: SOURCE_SHA,
			sourceRef: "main",
			buildId: "nexu-io/openmotion:4492881234.2",
			buildUrl: "https://github.com/nexu-io/openmotion/actions/runs/4492881234",
			artifact: {
				kind: "container",
				uri: `ghcr.io/nexu-io/openmotion-api@${digests.api}`,
				digest: digests.api,
				manifest: manifests.api,
				images: {
					api: {
						uri: `ghcr.io/nexu-io/openmotion-api@${digests.api}`,
						digest: digests.api,
						manifest: manifests.api,
					},
					workerMedia: {
						uri: `ghcr.io/nexu-io/openmotion-worker-media@${digests["worker-media"]}`,
						digest: digests["worker-media"],
						manifest: manifests["worker-media"],
					},
					workerRender: {
						uri: `ghcr.io/nexu-io/openmotion-worker-render@${digests["worker-render"]}`,
						digest: digests["worker-render"],
						manifest: manifests["worker-render"],
					},
					catalogSync: {
						uri: `ghcr.io/nexu-io/openmotion-catalog-sync@${digests["catalog-sync"]}`,
						digest: digests["catalog-sync"],
						manifest: manifests["catalog-sync"],
					},
				},
			},
		});

		assert.deepEqual(outputs, [
			["publication_result", "orbit_publication_accepted"],
			["publication_receipt", "dep_abc123"],
			["release_id", "rel_abc123"],
		]);
		assert.ok(summaries[0].includes(SOURCE_SHA));
		assert.ok(summaries[0].includes("rel_abc123"));
		assert.ok(summaries[0].includes("dep_abc123"));
		assert.ok(summaries[0].includes("queued"));
		assert.ok(summaries[0].includes("Generation: `7`"));
		assert.ok(!summaries[0].includes("Blocked reason:"));
		assert.ok(!summaries[0].includes("orbit-build-token"));

		// Also verify pending receipts surface blockedReason in step summary.
		const pendingSummaries = [];
		const pending = await publishCloudTestToOrbit({
			digestsDir: dir,
			env: baseEnv(),
			getRemoteHead: () => SOURCE_SHA,
			log: () => {},
			writeOutput: async () => {},
			writeSummary: async (text) => pendingSummaries.push(text),
			fetchImpl: async () => ({
				status: 202,
				text: async () =>
					JSON.stringify({
						releaseId: "rel_pending1",
						deploymentId: "dep_pending1",
						status: "pending",
						generation: null,
						blockedReason: "Diff incomplete",
					}),
			}),
		});
		assert.equal(pending.deploymentId, "dep_pending1");
		assert.ok(pendingSummaries[0].includes("Blocked reason: Diff incomplete"));
		assert.ok(!pendingSummaries[0].includes("Generation:"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("retries HTTP 503 target_busy and succeeds on subsequent 202 response", async () => {
	const { dir } = await createDigestsFixture();
	try {
		const delays = [];
		const headChecks = [];
		let attempts = 0;

		const result = await publishCloudTestToOrbit({
			digestsDir: dir,
			env: baseEnv(),
			maxAttempts: 4,
			retryDelayMs: 25,
			sleep: async (ms) => {
				delays.push(ms);
			},
			getRemoteHead: (ref) => {
				headChecks.push(ref);
				return SOURCE_SHA;
			},
			log: () => {},
			writeOutput: async () => {},
			writeSummary: async () => {},
			fetchImpl: async () => {
				attempts += 1;
				if (attempts < 3) {
					return {
						status: 503,
						text: async () =>
							JSON.stringify({ code: "target_busy", error: "target busy" }),
					};
				}
				return {
					status: 202,
					text: async () =>
						JSON.stringify({
							releaseId: "rel_retry_ok",
							deploymentId: "dep_retry_ok",
							status: "queued",
							generation: 4,
							blockedReason: null,
						}),
				};
			},
		});

		assert.equal(result.skipped, false);
		assert.equal(result.releaseId, "rel_retry_ok");
		assert.equal(result.deploymentId, "dep_retry_ok");
		assert.equal(attempts, 3);
		assert.equal(headChecks.length, 3);
		assert.deepEqual(delays, [25, 25]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("publication retries a lost connection or receipt with the same idempotency key and body", async (t) => {
	const { dir } = await createDigestsFixture();
	t.after(() => rm(dir, { recursive: true, force: true }));
	const requests = [];
	const retryDelays = [];
	const disconnected = new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) });
	const result = await publishCloudTestToOrbit({
		digestsDir: dir,
		env: baseEnv(),
		getRemoteHead: () => SOURCE_SHA,
		retryDelayMs: 1,
		sleep: async ms => retryDelays.push(ms),
		log: () => {},
		fetchImpl: async (_url, request) => {
			requests.push([request.headers["Idempotency-Key"], request.body]);
			if (requests.length === 1) throw disconnected;
			if (requests.length === 2) return { status: 202, text: async () => { throw disconnected; } };
			return Response.json({ releaseId: "rel_retry", deploymentId: "dep_retry", status: "queued" }, { status: 202 });
		},
	});
	assert.equal(result.deploymentId, "dep_retry");
	assert.deepEqual(retryDelays, [1, 1]);
	assert.deepEqual(requests, [requests[0], requests[0], requests[0]]);
});

test("publication bounds transport retries and fails immediately for a certificate error", async (t) => {
	const { dir } = await createDigestsFixture();
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const [code, expected, message] of [
		["UND_ERR_CONNECT_TIMEOUT", 2, /after 2 attempts \(UND_ERR_CONNECT_TIMEOUT\)/],
		["CERT_HAS_EXPIRED", 1, /fetch failed/],
	]) {
		let calls = 0;
		await assert.rejects(() => publishCloudTestToOrbit({
			digestsDir: dir,
			env: baseEnv(),
			getRemoteHead: () => SOURCE_SHA,
			maxAttempts: 2,
			sleep: async () => {},
			log: () => {},
			fetchImpl: async () => {
				calls++;
				throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code }) });
			},
		}), message);
		assert.equal(calls, expected);
	}
});

test("aborts 503 retry as skipped when remote head advances to a newer commit", async () => {
	const { dir } = await createDigestsFixture();
	try {
		const newerSha = "b".repeat(40);
		const summaries = [];
		const delays = [];
		let headCall = 0;
		let fetchCalls = 0;

		const result = await publishCloudTestToOrbit({
			digestsDir: dir,
			env: baseEnv(),
			maxAttempts: 4,
			retryDelayMs: 10,
			sleep: async (ms) => {
				delays.push(ms);
			},
			getRemoteHead: () => {
				headCall += 1;
				return headCall === 1 ? SOURCE_SHA : newerSha;
			},
			log: () => {},
			writeOutput: async () => {
				throw new Error("superseded retry must not emit outputs");
			},
			writeSummary: async (text) => summaries.push(text),
			fetchImpl: async () => {
				fetchCalls += 1;
				return {
					status: 503,
					text: async () => JSON.stringify({ code: "target_busy" }),
				};
			},
		});

		assert.deepEqual(result, {
			skipped: true,
			reason: "superseded",
			remoteSha: newerSha,
		});
		assert.equal(fetchCalls, 1);
		assert.equal(headCall, 2);
		assert.deepEqual(delays, [10]);
		assert.match(summaries[0], /superseded/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("throws when HTTP 503 retries are exhausted", async () => {
	const { dir } = await createDigestsFixture();
	try {
		const delays = [];
		let fetchCalls = 0;

		await assert.rejects(
			() =>
				publishCloudTestToOrbit({
					digestsDir: dir,
					env: baseEnv(),
					maxAttempts: 3,
					retryDelayMs: 5,
					sleep: async (ms) => {
						delays.push(ms);
					},
					getRemoteHead: () => SOURCE_SHA,
					log: () => {},
					writeOutput: async () => {},
					writeSummary: async () => {},
					fetchImpl: async () => {
						fetchCalls += 1;
						return {
							status: 503,
							text: async () =>
								JSON.stringify({ code: "target_busy", error: "still busy" }),
						};
					},
				}),
			/HTTP status 503.*still busy/,
		);
		assert.equal(fetchCalls, 3);
		assert.deepEqual(delays, [5, 5]);
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

test("rejects tampered manifests, missing artifacts, wrong branch or endpoint, 4xx errors, and invalid receipts", async () => {
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
					baseEnv({ ORBIT_OPENMOTION_BUILD_TOKEN: "" }),
					dir,
				),
			/ORBIT_OPENMOTION_BUILD_TOKEN/,
		);
		await assert.rejects(
			() =>
				buildOpenMotionOrbitPayload(
					baseEnv({ GITHUB_REF: "refs/heads/feat/cloud-container-p1" }),
					dir,
				),
			/refs\/heads\/main/,
		);

		let nonRetryCalls = 0;
		await assert.rejects(
			() =>
				publishCloudTestToOrbit({
					digestsDir: dir,
					env: baseEnv(),
					maxAttempts: 4,
					retryDelayMs: 1,
					sleep: async () => {
						throw new Error("4xx must not retry");
					},
					getRemoteHead: () => SOURCE_SHA,
					log: () => {},
					fetchImpl: async () => {
						nonRetryCalls += 1;
						return {
							status: 409,
							text: async () => JSON.stringify({ error: "not enrolled" }),
						};
					},
				}),
			/HTTP status 409/,
		);
		assert.equal(nonRetryCalls, 1);

		for (const badReceipt of [
			{ releaseId: "bad-rel", deploymentId: "dep_abc123", status: "queued" },
			{ releaseId: "rel_abc123", deploymentId: "bad-dep", status: "queued" },
			{ releaseId: "rel_abc123", deploymentId: "dep_abc123", status: "   " },
			{ releaseId: "rel_abc123", deploymentId: "dep_abc123" },
		]) {
			await assert.rejects(
				() =>
					publishCloudTestToOrbit({
						digestsDir: dir,
						env: baseEnv(),
						getRemoteHead: () => SOURCE_SHA,
						log: () => {},
						fetchImpl: async () => ({
							status: 202,
							text: async () => JSON.stringify(badReceipt),
						}),
					}),
				/Invalid Orbit publication receipt/,
			);
		}

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

const PROMOTE_ENV_PATTERN = /\n    environment:\s*orbit-cloud-test(?:\s|$)/;

function extractJobBlock(workflowYaml, jobName) {
	const normalized = workflowYaml.replace(/\r\n/g, "\n");
	const jobsMatch = /^jobs:\s*$/m.exec(normalized);
	assert.ok(jobsMatch, "workflow must define a top-level jobs block");
	const afterJobsHeader = normalized.slice(
		jobsMatch.index + jobsMatch[0].length,
	);
	const nextTopLevel = /\n[^\s#]/.exec(afterJobsHeader);
	const jobsBody =
		nextTopLevel === null
			? afterJobsHeader
			: afterJobsHeader.slice(0, nextTopLevel.index);
	const escapedName = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const jobMatch = new RegExp(`^  ${escapedName}:\\s*$`, "m").exec(jobsBody);
	assert.ok(jobMatch, `workflow must define jobs.${jobName}`);
	const start = jobMatch.index;
	const rest = jobsBody.slice(start + jobMatch[0].length);
	const nextSiblingJob = /\n  [A-Za-z0-9_-]+:\s*(?:\n|$)/.exec(rest);
	return nextSiblingJob === null
		? jobsBody.slice(start)
		: jobsBody.slice(start, start + jobMatch[0].length + nextSiblingJob.index);
}

test("release and container image workflows wire CI + 4-image gate, manifests, and ORBIT_OPENMOTION_PULL toggle without legacy API key", async () => {
	const releaseWorkflow = await readFile(
		new URL("../.github/workflows/deploy-cloud-test.yml", import.meta.url),
		"utf8",
	);
	assert.match(releaseWorkflow, /branches:\s*\[main\]/);
	for (const expectedPath of [
		"deploy/Dockerfile",
		"src/**",
		".github/workflows/container-images.yml",
		".github/workflows/deploy-cloud-test.yml",
		".github/scripts/orbit-publish-cloud-test.mjs",
	]) {
		assert.match(
			releaseWorkflow,
			new RegExp(`^      - ${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
		);
	}
	for (const jobName of ["checks", "images", "promote"]) {
		assert.match(
			extractJobBlock(releaseWorkflow, jobName),
			/\n    if:.*github\.ref == 'refs\/heads\/main'/,
		);
	}
	const promoteJob = extractJobBlock(releaseWorkflow, "promote");
	assert.match(promoteJob, PROMOTE_ENV_PATTERN);
	assert.match(promoteJob, /\n    needs:\s*\[checks,\s*images\]/);

	const movedToSiblingJob = `${releaseWorkflow.replace(
		/\n    environment:\s*orbit-cloud-test\b/,
		"",
	)}\n  trailing_job:\n    runs-on: ubuntu-24.04\n    environment: orbit-cloud-test\n    steps: []\n`;
	assert.doesNotMatch(
		extractJobBlock(movedToSiblingJob, "promote"),
		PROMOTE_ENV_PATTERN,
	);
	assert.match(
		extractJobBlock(movedToSiblingJob, "trailing_job"),
		PROMOTE_ENV_PATTERN,
	);

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
	assert.match(
		releaseWorkflow,
		/ORBIT_OPENMOTION_BUILD_TOKEN:\s*\$\{\{\s*secrets\.ORBIT_OPENMOTION_BUILD_TOKEN\s*\}\}/,
	);
	assert.doesNotMatch(releaseWorkflow, /powerformer\./i);
	assert.doesNotMatch(releaseWorkflow, new RegExp(["ORBIT", "API", "KEY"].join("_")));

	const publishScript = await readFile(
		new URL("../.github/scripts/orbit-publish-cloud-test.mjs", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(publishScript, /powerformer\./i);
	assert.doesNotMatch(publishScript, new RegExp(["ORBIT", "API", "KEY"].join("_")));
	assert.doesNotMatch(publishScript, /X-Orbit-API-Key/i);
	assert.doesNotMatch(publishScript, /\/api\/app\/sync/);
	assert.match(publishScript, /\/api\/automation\/v1\/publications/);

	const imagesWorkflow = await readFile(
		new URL("../.github/workflows/container-images.yml", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(imagesWorkflow, /^  push:\s*$/m);
	const digestIfMatches = imagesWorkflow.match(
		/^\s+if:.*github\.ref == 'refs\/heads\/main'$/gm,
	);
	assert.equal(digestIfMatches?.length, 2);
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

	const ciWorkflow = await readFile(
		new URL("../.github/workflows/ci.yml", import.meta.url),
		"utf8",
	);
	assert.match(
		ciWorkflow,
		/concurrency:\n\s+group:\s*motion-\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.event\.pull_request\.number \|\| github\.ref\s*\}\}/,
	);
});

test("parseDeployPushPaths and matchesWorkflowPath match runtime/workflow inputs and ignore docs/test-only files", async () => {
	const releaseWorkflow = await readFile(
		new URL("../.github/workflows/deploy-cloud-test.yml", import.meta.url),
		"utf8",
	);
	const patterns = parseDeployPushPaths(releaseWorkflow);
	for (const matchedFile of [
		"deploy/Dockerfile",
		"src/entrypoints/api.ts",
		"packages/design-system/index.ts",
		"docs/transcripts.md",
		".github/workflows/deploy-cloud-test.yml",
		".github/scripts/orbit-publish-cloud-test.mjs",
	]) {
		assert.equal(
			patterns.some((pattern) => matchesWorkflowPath(pattern, matchedFile)),
			true,
			`${matchedFile} should match on.push.paths`,
		);
	}
	for (const ignoredFile of [
		"README.md",
		"docs/architecture.md",
		"tests/orbit-cloud-test-sync.test.mjs",
		"src-extra/helper.ts",
		"deploy/README.md",
	]) {
		assert.equal(
			patterns.some((pattern) => matchesWorkflowPath(pattern, ignoredFile)),
			false,
			`${ignoredFile} must not match on.push.paths`,
		);
	}
});

test("supersession check preserves publication across excluded-path commits (including shallow checkouts and reverts)", async (t) => {
	const workRoot = await mkdtemp(join(tmpdir(), "openmotion-supersede-"));
	const { dir: digestsDir } = await createDigestsFixture();
	t.after(async () => {
		await rm(workRoot, { recursive: true, force: true });
		await rm(digestsDir, { recursive: true, force: true });
	});

	const bareDir = join(workRoot, "origin.git");
	const authorDir = join(workRoot, "author");
	const shallowDir = join(workRoot, "shallow");
	execFileSync("git", ["init", "--quiet", "--bare", bareDir]);
	execFileSync("git", ["init", "--quiet", authorDir]);
	execFileSync("git", ["config", "user.name", "test"], { cwd: authorDir });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: authorDir,
	});
	execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: authorDir });

	const commitAndPush = async (relPath, content, message) => {
		const target = join(authorDir, relPath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
		execFileSync("git", ["add", relPath], { cwd: authorDir });
		execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: authorDir });
		execFileSync("git", ["push", "--quiet", "origin", "HEAD:refs/heads/main"], {
			cwd: authorDir,
		});
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: authorDir,
			encoding: "utf8",
		}).trim();
	};

	const shaA = await commitAndPush("src/app.ts", "v1\n", "runtime v1");
	execFileSync(
		"git",
		["clone", "--quiet", "--depth=1", "--branch", "main", `file://${bareDir}`, shallowDir],
	);
	const shaB = await commitAndPush("README.md", "docs update\n", "docs only");

	assert.equal(
		isSupersededByRemoteHead({
			sourceRef: "refs/heads/main",
			sourceSha: shaA,
			remoteSha: shaB,
			cwd: shallowDir,
		}),
		false,
	);

	let publishedCalls = 0;
	const acceptedAfterDocs = await publishCloudTestToOrbit({
		digestsDir,
		env: baseEnv({ GITHUB_SHA: shaA }),
		getRemoteHead: () => shaB,
		isSuperseded: ({ sourceRef, sourceSha, remoteSha }) =>
			isSupersededByRemoteHead({
				sourceRef,
				sourceSha,
				remoteSha,
				cwd: shallowDir,
			}),
		log: () => {},
		fetchImpl: async () => {
			publishedCalls += 1;
			return {
				status: 202,
				text: async () =>
					JSON.stringify({
						releaseId: "rel_docs_ok",
						deploymentId: "dep_docs_ok",
						status: "queued",
						generation: 11,
						blockedReason: null,
					}),
			};
		},
	});
	assert.equal(acceptedAfterDocs.skipped, false);
	assert.equal(acceptedAfterDocs.releaseId, "rel_docs_ok");
	assert.equal(publishedCalls, 1);

	const shaC = await commitAndPush("src/app.ts", "v2\n", "runtime v2");
	assert.equal(
		isSupersededByRemoteHead({
			sourceRef: "refs/heads/main",
			sourceSha: shaA,
			remoteSha: shaC,
			cwd: shallowDir,
		}),
		true,
	);
	const skippedAfterRuntime = await publishCloudTestToOrbit({
		digestsDir,
		env: baseEnv({ GITHUB_SHA: shaA }),
		getRemoteHead: () => shaC,
		isSuperseded: ({ sourceRef, sourceSha, remoteSha }) =>
			isSupersededByRemoteHead({
				sourceRef,
				sourceSha,
				remoteSha,
				cwd: shallowDir,
			}),
		log: () => {},
		fetchImpl: async () => {
			throw new Error("must not publish once superseded by runtime commit");
		},
	});
	assert.equal(skippedAfterRuntime.skipped, true);
	assert.equal(skippedAfterRuntime.reason, "superseded");

	// GitHub evaluates push path filters via two-dot diff(sourceSha, remoteSha): reverting shaC back to shaA's
	// runtime tree plus README-only changes leaves zero net runtime diff, so shaD does not supersede shaA.
	const shaD = await commitAndPush("src/app.ts", "v1\n", "revert runtime v2");
	assert.equal(
		isSupersededByRemoteHead({
			sourceRef: "refs/heads/main",
			sourceSha: shaA,
			remoteSha: shaD,
			cwd: shallowDir,
		}),
		false,
	);
});
