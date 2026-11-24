#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SOURCE_REF = "refs/heads/main";
const DEFAULT_DEPLOY_WORKFLOW_PATH = new URL(
	"../workflows/deploy-cloud-test.yml",
	import.meta.url,
);
const ORBIT_APP = "openmotion";
const ORBIT_ENVIRONMENT = "test";
const RELEASE_ID_PATTERN = /^rel_[A-Za-z0-9_-]{1,80}$/;
const DEPLOYMENT_ID_PATTERN = /^dep_[A-Za-z0-9_-]{1,80}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 15_000;
const PUBLICATION_TIMEOUT_MS = 30_000;
const TRANSIENT_NETWORK_CODES = new Set([
	"ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
	"UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

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

export function parseDeployPushPaths(workflowYaml) {
	const normalized = workflowYaml.replace(/\r\n/g, "\n");
	const pathsMatch = /\n  push:\n[\s\S]*?\n    paths:\n/.exec(normalized);
	if (!pathsMatch) {
		throw new Error("deploy-cloud-test.yml must define on.push.paths");
	}
	const rest = normalized.slice(pathsMatch.index + pathsMatch[0].length);
	const patterns = [];
	for (const line of rest.split("\n")) {
		if (!line.trim() || /^\s*#/.test(line)) continue;
		const itemMatch = /^      -\s+(.+?)\s*$/.exec(line);
		if (!itemMatch) break;
		let value = itemMatch[1].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		} else {
			value = value.replace(/\s+#.*$/, "").trim();
		}
		if (value) patterns.push(value);
	}
	if (patterns.length === 0) {
		throw new Error("deploy-cloud-test.yml on.push.paths must not be empty");
	}
	return patterns;
}

function globToRegExp(pattern) {
	let regex = "^";
	for (let i = 0; i < pattern.length; i += 1) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					regex += "(?:.*/)?";
					i += 2;
				} else {
					regex += ".*";
					i += 1;
				}
			} else {
				regex += "[^/]*";
			}
		} else if (ch === "?") {
			regex += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(ch)) {
			regex += `\\${ch}`;
		} else {
			regex += ch;
		}
	}
	regex += "$";
	return new RegExp(regex);
}

export function matchesWorkflowPath(pattern, filePath) {
	const normalizedFile = filePath.replace(/^\.\//, "").replace(/^\/+/, "");
	const normalizedPattern = pattern.replace(/^\.\//, "").replace(/^\/+/, "");
	if (!normalizedFile || !normalizedPattern) return false;
	if (normalizedPattern.endsWith("/**")) {
		const dirPrefix = normalizedPattern.slice(0, -3);
		if (!dirPrefix.includes("*") && !dirPrefix.includes("?")) {
			return normalizedFile.startsWith(`${dirPrefix}/`);
		}
	}
	return globToRegExp(normalizedPattern).test(normalizedFile);
}

function gitCommitExists(cwd, sha) {
	try {
		execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
			cwd,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

function gitIsAncestor(cwd, ancestorSha, descendantSha) {
	try {
		execFileSync(
			"git",
			["merge-base", "--is-ancestor", ancestorSha, descendantSha],
			{ cwd, stdio: "ignore" },
		);
		return true;
	} catch {
		return false;
	}
}

export function isSupersededByRemoteHead({
	sourceRef,
	sourceSha,
	remoteSha,
	cwd = process.cwd(),
	workflowPath = DEFAULT_DEPLOY_WORKFLOW_PATH,
}) {
	if (!remoteSha) {
		throw new Error(`Missing remote branch ${sourceRef}`);
	}
	if (remoteSha === sourceSha) {
		return false;
	}
	if (!gitCommitExists(cwd, remoteSha)) {
		execFileSync("git", ["fetch", "--no-tags", "--quiet", "origin", sourceRef], {
			cwd,
			stdio: "ignore",
		});
	}
	if (
		!gitCommitExists(cwd, sourceSha) ||
		!gitCommitExists(cwd, remoteSha) ||
		!gitIsAncestor(cwd, sourceSha, remoteSha)
	) {
		return true;
	}
	const raw = execFileSync(
		"git",
		[
			"-c",
			"core.quotePath=false",
			"diff",
			"--name-only",
			"-z",
			sourceSha,
			remoteSha,
		],
		{ cwd, encoding: "utf8" },
	);
	const changedFiles = raw
		.split("\0")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const workflowYaml = readFileSync(workflowPath, "utf8");
	const paths = parseDeployPushPaths(workflowYaml);
	return changedFiles.some((file) =>
		paths.some((pattern) => matchesWorkflowPath(pattern, file)),
	);
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
	isSuperseded = getRemoteHead === resolveRemoteHead
		? isSupersededByRemoteHead
		: ({ sourceSha, remoteSha }) => remoteSha !== sourceSha,
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
		if (
			remoteSha !== payload.sourceSha &&
			isSuperseded({
				sourceRef: allowedRef,
				sourceSha: payload.sourceSha,
				remoteSha,
			})
		) {
			const message = `A newer deployment-eligible merge (${remoteSha}) superseded ${payload.sourceSha}; skipped Orbit publication.`;
			log(message);
			await writeSummary(message);
			return { skipped: true, reason: "superseded", remoteSha };
		}
		if (remoteSha !== payload.sourceSha) {
			log(
				`Remote head ${remoteSha} has no deployment-eligible changes after ${payload.sourceSha}; continuing Orbit publication.`,
			);
		}

		let response;
		let rawBody;
		const signal = AbortSignal.timeout(PUBLICATION_TIMEOUT_MS);
		try {
			response = await fetchImpl(endpoint, {
				method: "POST",
				redirect: "error",
				headers,
				body,
				signal,
			});
			rawBody = await response.text();
		} catch (error) {
			const code = error.cause?.code ?? error.code;
			if (!signal.aborted && !TRANSIENT_NETWORK_CODES.has(code)) throw error;
			const reason = signal.aborted ? "request timeout" : code;
			if (attempt === maxAttempts) {
				throw new Error(`Orbit publication failed after ${attempt} attempts (${reason})`, { cause: error });
			}
			log(`Orbit publication interrupted (${reason}); retrying in ${retryDelayMs}ms`);
			await sleep(retryDelayMs);
			continue;
		}
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
		if (process.argv[2] === "--check-superseded") {
			const [, , , sourceRef, sourceSha, remoteSha] = process.argv;
			const superseded = isSupersededByRemoteHead({
				sourceRef: requireNonEmpty(sourceRef, "sourceRef"),
				sourceSha: requireNonEmpty(sourceSha, "sourceSha"),
				remoteSha: requireNonEmpty(remoteSha, "remoteSha"),
			});
			process.stdout.write(`${superseded ? "true" : "false"}\n`);
		} else {
			await publishCloudTestToOrbit({ digestsDir: process.argv[2] });
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
