#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SOURCE_REF = "refs/heads/feat/cloud-container-p1";
const GITOPS_REPOSITORY = "infra/apps";
const GITOPS_ENVIRONMENT = "test";
const GITOPS_APPLICATION = "openmotion";
const GITOPS_VALUES_FILE_PATH = "kubernetes/envs/test/openmotion/values.yaml";
const RECEIPT_ID_PATTERN = /^(?:dep|batch)_[A-Za-z0-9_-]{1,80}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseOrbitApiUrl(value) {
	const raw = requireNonEmpty(value, "ORBIT_API_URL");
	let parsed;
	try {
		parsed = new URL(raw);
	} catch (error) {
		throw new Error("ORBIT_API_URL must be a valid HTTPS origin URL", {
			cause: error,
		});
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		parsed.pathname.replace(/\/+$/, "") !== ""
	) {
		throw new Error(
			"ORBIT_API_URL must be an HTTPS origin URL without credentials, path, query, or fragment",
		);
	}
	return parsed.origin;
}

export const COMPONENT_TARGETS = [
	{
		target: "api",
		helmKey: "api",
		imageName: "openmotion-api",
	},
	{
		target: "worker-media",
		helmKey: "workerMedia",
		imageName: "openmotion-worker-media",
	},
	{
		target: "worker-render",
		helmKey: "workerRender",
		imageName: "openmotion-worker-render",
	},
	{
		target: "catalog-sync",
		helmKey: "catalogSync",
		imageName: "openmotion-catalog-sync",
	},
];

function sha256(text) {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function requireNonEmpty(value, name) {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`${name} is required`);
	}
	return trimmed;
}

export function resolveRemoteHead(sourceRef) {
	const out = execFileSync(
		"git",
		["ls-remote", "--heads", "origin", sourceRef],
		{ encoding: "utf8" },
	);
	const firstLine = out
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	return firstLine ? firstLine.split(/\s+/)[0] : "";
}

export async function readComponentArtifacts(digestsDir, registryOwner) {
	const images = {};
	const valuesImages = {};
	for (const { target, helmKey, imageName } of COMPONENT_TARGETS) {
		const digest = (
			await readFile(join(digestsDir, target), "utf8")
		).trim();
		if (!DIGEST_PATTERN.test(digest)) {
			throw new Error(`Invalid ${target} digest: ${digest}`);
		}
		const rawManifest = await readFile(
			join(digestsDir, `${target}.manifest.json`),
			"utf8",
		);
		const manifest =
			sha256(rawManifest) === digest
				? rawManifest
				: rawManifest.replace(/\r?\n$/, "");
		if (sha256(manifest) !== digest) {
			throw new Error(
				`Registry manifest does not match the pushed image digest for ${target}`,
			);
		}
		images[helmKey] = {
			uri: `ghcr.io/${registryOwner}/${imageName}@${digest}`,
			digest,
			manifest,
		};
		valuesImages[helmKey] = { digest };
	}
	return { images, valuesImages };
}

export async function buildOpenMotionOrbitPayload(env, digestsDir) {
	const orbitApiUrl = parseOrbitApiUrl(env.ORBIT_API_URL);
	requireNonEmpty(env.ORBIT_API_KEY, "ORBIT_API_KEY");
	requireNonEmpty(
		env.ORBIT_OPENMOTION_BUILD_TOKEN,
		"ORBIT_OPENMOTION_BUILD_TOKEN",
	);

	const allowedRef = env.ORBIT_ALLOWED_SOURCE_REF?.trim() || DEFAULT_SOURCE_REF;
	const ref = requireNonEmpty(env.GITHUB_REF, "GITHUB_REF");
	if (ref !== allowedRef) {
		throw new Error(`Expected ${allowedRef}, got ${ref}`);
	}
	const sourceRef = allowedRef.replace(/^refs\/heads\//, "");

	const sourceSha = requireNonEmpty(env.GITHUB_SHA, "GITHUB_SHA");
	if (!SHA_PATTERN.test(sourceSha)) {
		throw new Error("GITHUB_SHA must be a 40-char lowercase hex commit SHA");
	}
	const repository = requireNonEmpty(
		env.GITHUB_REPOSITORY,
		"GITHUB_REPOSITORY",
	);
	const serverUrl = (env.GITHUB_SERVER_URL?.trim() || "https://github.com").replace(
		/\/+$/,
		"",
	);
	const owner = requireNonEmpty(
		env.GITHUB_REPOSITORY_OWNER,
		"GITHUB_REPOSITORY_OWNER",
	).toLowerCase();
	const runId = requireNonEmpty(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
	const runAttempt = env.GITHUB_RUN_ATTEMPT?.trim() || "1";
	if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)) {
		throw new Error("Missing numeric GitHub Actions run identity");
	}

	const { images, valuesImages } = await readComponentArtifacts(
		digestsDir,
		owner,
	);
	const sourceTag = `sha-${sourceSha}`;
	const taggedImages = Object.fromEntries(
		Object.entries(valuesImages).map(([key, item]) => [
			key,
			{ tag: sourceTag, digest: item.digest },
		]),
	);

	return {
		orbitApiUrl,
		payload: {
			repository: GITOPS_REPOSITORY,
			environment: GITOPS_ENVIRONMENT,
			syncMode: "publishVersion",
			changes: [
				{
					application: GITOPS_APPLICATION,
					valuesFilePath: GITOPS_VALUES_FILE_PATH,
					valuesContent: JSON.stringify({ images: taggedImages }),
				},
			],
			build: {
				sourceSha,
				sourceRef,
				buildId: `${repository}:${runId}.${runAttempt}`,
				buildUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
				artifact: {
					kind: "container",
					uri: images.api.uri,
					digest: images.api.digest,
					manifest: images.api.manifest,
					images,
				},
			},
		},
	};
}

export async function publishCloudTestToOrbit({
	digestsDir,
	env = process.env,
	fetchImpl = globalThis.fetch,
	getRemoteHead = resolveRemoteHead,
	log = console.log,
	writeOutput = async (name, value) => {
		if (!env.GITHUB_OUTPUT) return;
		await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
	},
	writeSummary = async (markdown) => {
		if (!env.GITHUB_STEP_SUMMARY) return;
		await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
	},
} = {}) {
	requireNonEmpty(digestsDir, "digestsDir");
	const { orbitApiUrl, payload } = await buildOpenMotionOrbitPayload(
		env,
		digestsDir,
	);
	const allowedRef = env.ORBIT_ALLOWED_SOURCE_REF?.trim() || DEFAULT_SOURCE_REF;
	const remoteSha = getRemoteHead(allowedRef);
	if (!remoteSha) {
		throw new Error(`Missing remote branch ${allowedRef}`);
	}
	if (remoteSha !== payload.build.sourceSha) {
		const message = `A newer merge (${remoteSha}) superseded ${payload.build.sourceSha}; skipped Orbit publication.`;
		log(message);
		await writeSummary(message);
		return { skipped: true, reason: "superseded", remoteSha };
	}

	const response = await fetchImpl(`${orbitApiUrl}/api/app/sync`, {
		method: "POST",
		redirect: "error",
		headers: {
			"Content-Type": "application/json",
			"X-Orbit-API-Key": env.ORBIT_API_KEY.trim(),
			Authorization: `Bearer ${env.ORBIT_OPENMOTION_BUILD_TOKEN.trim()}`,
			"Idempotency-Key": payload.build.buildId,
		},
		body: JSON.stringify(payload),
	});
	const rawBody = await response.text();
	let responseBody = {};
	if (rawBody.trim()) {
		try {
			responseBody = JSON.parse(rawBody);
		} catch (error) {
			throw new Error(
				`Orbit sync returned invalid JSON: ${rawBody.slice(0, 2000)}`,
				{ cause: error },
			);
		}
	}

	log(`Orbit sync HTTP status: ${response.status}`);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(
			`Orbit sync failed with HTTP status ${response.status}: ${responseBody?.error ?? responseBody?.message ?? rawBody.slice(0, 500)}`,
		);
	}
	if (responseBody.success !== true || responseBody.mode !== "desired") {
		throw new Error(
			`Orbit sync did not accept a cluster-pull desired publication: ${responseBody?.error ?? responseBody?.message ?? "unexpected mode"}`,
		);
	}

	const updates = Array.isArray(responseBody.updates) ? responseBody.updates : [];
	const matching = updates.filter(
		(entry) =>
			entry?.application === GITOPS_APPLICATION &&
			entry?.filePath === GITOPS_VALUES_FILE_PATH,
	);
	const update = matching[0];
	const receipt = update?.deploymentId ?? update?.batchId;
	if (
		matching.length !== 1 ||
		typeof receipt !== "string" ||
		!RECEIPT_ID_PATTERN.test(receipt) ||
		typeof update?.status !== "string" ||
		!update.status.trim()
	) {
		throw new Error(
			`Missing matching Orbit publication receipt; updates=${JSON.stringify(responseBody.updates ?? null).slice(0, 2000)}`,
		);
	}

	log(`Orbit accepted ${receipt} (${update.status})`);
	await writeOutput("publication_result", "orbit_publication_accepted");
	await writeOutput("publication_receipt", receipt);
	await writeSummary(
		[
			"## OpenMotion Orbit Cluster-Pull Publication",
			"",
			`- Commit: \`${payload.build.sourceSha}\``,
			`- Orbit receipt: \`${receipt}\` (\`${update.status}\`)`,
			update.generation != null ? `- Generation: \`${update.generation}\`` : "",
			"",
			"| Component | Image |",
			"| --- | --- |",
			...Object.entries(payload.build.artifact.images).map(
				([key, img]) => `| \`${key}\` | \`${img.uri}\` |`,
			),
		]
			.filter(Boolean)
			.join("\n"),
	);
	return { skipped: false, payload, response: responseBody, receipt };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await publishCloudTestToOrbit({ digestsDir: process.argv[2] });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
