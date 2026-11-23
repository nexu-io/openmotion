#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SOURCE_REF = "refs/heads/feat/cloud-container-p1";
const ORBIT_APP = "openmotion";
const ORBIT_ENVIRONMENT = "test";
const RELEASE_ID_PATTERN = /^rel_[A-Za-z0-9_-]{1,80}$/;
const DEPLOYMENT_ID_PATTERN = /^dep_[A-Za-z0-9_-]{1,80}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 15_000;

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

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	const serverUrl = (
		env.GITHUB_SERVER_URL?.trim() || "https://github.com"
	).replace(/\/+$/, "");
	const owner = requireNonEmpty(
		env.GITHUB_REPOSITORY_OWNER,
		"GITHUB_REPOSITORY_OWNER",
	).toLowerCase();
	const runId = requireNonEmpty(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
	const runAttempt = env.GITHUB_RUN_ATTEMPT?.trim() || "1";
	if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)) {
		throw new Error("Missing numeric GitHub Actions run identity");
	}

	const { images } = await readComponentArtifacts(digestsDir, owner);

	return {
		orbitApiUrl,
		payload: {
			app: ORBIT_APP,
			environment: ORBIT_ENVIRONMENT,
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
	};
}

export async function publishCloudTestToOrbit({
	digestsDir,
	env = process.env,
	fetchImpl = globalThis.fetch,
	getRemoteHead = resolveRemoteHead,
	maxAttempts = DEFAULT_MAX_ATTEMPTS,
	retryDelayMs = DEFAULT_RETRY_DELAY_MS,
	sleep = defaultSleep,
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
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error("maxAttempts must be a positive integer");
	}
	if (typeof retryDelayMs !== "number" || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
		throw new Error("retryDelayMs must be a non-negative number");
	}

	const { orbitApiUrl, payload } = await buildOpenMotionOrbitPayload(
		env,
		digestsDir,
	);
	const allowedRef = env.ORBIT_ALLOWED_SOURCE_REF?.trim() || DEFAULT_SOURCE_REF;
	const endpoint = `${orbitApiUrl}/api/automation/v1/publications`;
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${env.ORBIT_OPENMOTION_BUILD_TOKEN.trim()}`,
		"Idempotency-Key": payload.buildId,
	};
	const body = JSON.stringify(payload);

	let responseBody = {};
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const remoteSha = getRemoteHead(allowedRef);
		if (!remoteSha) {
			throw new Error(`Missing remote branch ${allowedRef}`);
		}
		if (remoteSha !== payload.sourceSha) {
			const message = `A newer merge (${remoteSha}) superseded ${payload.sourceSha}; skipped Orbit publication.`;
			log(message);
			await writeSummary(message);
			return { skipped: true, reason: "superseded", remoteSha };
		}

		const response = await fetchImpl(endpoint, {
			method: "POST",
			redirect: "error",
			headers,
			body,
		});
		const rawBody = await response.text();
		let parsedBody = {};
		if (rawBody.trim()) {
			try {
				parsedBody = JSON.parse(rawBody);
			} catch (error) {
				if (response.status === 503 && attempt < maxAttempts) {
					log(
						`Orbit publication returned HTTP 503 (attempt ${attempt}/${maxAttempts}); retrying in ${retryDelayMs}ms`,
					);
					await sleep(retryDelayMs);
					continue;
				}
				throw new Error(
					`Orbit publication returned invalid JSON: ${rawBody.slice(0, 2000)}`,
					{ cause: error },
				);
			}
		}

		log(
			`Orbit publication HTTP status: ${response.status} (attempt ${attempt}/${maxAttempts})`,
		);
		if (response.status === 503 && attempt < maxAttempts) {
			const detail =
				parsedBody?.code ??
				parsedBody?.error ??
				parsedBody?.message ??
				rawBody.slice(0, 200);
			log(
				`Orbit publication temporarily unavailable (${detail || "503"}); retrying attempt ${attempt + 1}/${maxAttempts} in ${retryDelayMs}ms`,
			);
			await sleep(retryDelayMs);
			continue;
		}
		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`Orbit publication failed with HTTP status ${response.status}: ${parsedBody?.error ?? parsedBody?.message ?? rawBody.slice(0, 500)}`,
			);
		}
		responseBody = parsedBody;
		break;
	}

	const releaseId =
		responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
			? responseBody.releaseId
			: undefined;
	const deploymentId =
		responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
			? responseBody.deploymentId
			: undefined;
	const status =
		responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
			? responseBody.status
			: undefined;
	if (
		typeof releaseId !== "string" ||
		!RELEASE_ID_PATTERN.test(releaseId) ||
		typeof deploymentId !== "string" ||
		!DEPLOYMENT_ID_PATTERN.test(deploymentId) ||
		typeof status !== "string" ||
		!status.trim()
	) {
		throw new Error(
			`Invalid Orbit publication receipt: ${JSON.stringify(responseBody).slice(0, 2000)}`,
		);
	}

	const generation = responseBody.generation;
	const blockedReason =
		typeof responseBody.blockedReason === "string" &&
		responseBody.blockedReason.trim()
			? responseBody.blockedReason.trim()
			: null;

	log(`Orbit accepted ${deploymentId} (${status}) for release ${releaseId}`);
	await writeOutput("publication_result", "orbit_publication_accepted");
	await writeOutput("publication_receipt", deploymentId);
	await writeOutput("release_id", releaseId);
	await writeSummary(
		[
			"## OpenMotion Orbit Cluster-Pull Publication",
			"",
			`- Commit: \`${payload.sourceSha}\``,
			`- Release: \`${releaseId}\``,
			`- Deployment: \`${deploymentId}\` (\`${status}\`)`,
			generation != null ? `- Generation: \`${generation}\`` : "",
			blockedReason ? `- Blocked reason: ${blockedReason}` : "",
			"",
			"| Component | Image |",
			"| --- | --- |",
			...Object.entries(payload.artifact.images).map(
				([key, img]) => `| \`${key}\` | \`${img.uri}\` |`,
			),
		]
			.filter(Boolean)
			.join("\n"),
	);
	return {
		skipped: false,
		payload,
		response: responseBody,
		releaseId,
		deploymentId,
		receipt: deploymentId,
	};
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
