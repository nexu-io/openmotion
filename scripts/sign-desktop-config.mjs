#!/usr/bin/env node
/**
 * Release-pipeline CLI for OpenMotion Desktop Two-Tier Signed Configuration.
 *
 * Subcommands:
 *   issue-daily-cert   Sign a time-bounded daily Ed25519 certificate with the root key
 *   sign-revocations   Sign a root-authenticated daily key revocation list
 *   sign-config        Validate bounds and sign a config payload with a daily key
 *   verify-config      Verify a signed config envelope against a root public key
 *
 * Keys are always read from explicit file paths or environment variables;
 * never hardcode or commit production private keys.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportPublicKeySpkiBase64,
  generateEd25519KeyPair,
  signConfigEnvelope,
  signDailyCertificate,
  signRevocationList,
  verifySignedConfigEnvelope,
} from '../packages/signed-config/index.ts';
import { validateSignedConfigPayloadBounds } from '../shared/signed-config.ts';

const VALID_CHANNELS = new Set(['stable', 'test', 'dev']);

function printUsage() {
  return [
    'Usage: node --experimental-strip-types scripts/sign-desktop-config.mjs <command> [options]',
    '',
    'Commands:',
    '  keygen             Generate a fresh Ed25519 keypair (root or daily signing key)',
    '    --private-out <path>        Write private key PEM with mode 0600 (required)',
    '    --public-out <path>         Optional path to write public key PEM',
    '    --spki-out <path>           Optional path to write base64 SPKI DER public key',
    '',
    '  issue-daily-cert   Sign a daily signing certificate using the offline root private key',
    '    --key-id <id>               Unique daily key identifier (required)',
    '    --root-key <path>           Root private key PEM file (or env OPENMOTION_ROOT_PRIVATE_KEY_PATH / _PEM)',
    '    --daily-pub <path>          Daily public key PEM/SPKI file (or --daily-pub-spki / env OPENMOTION_DAILY_PUBLIC_KEY_*)',
    '    --daily-pub-spki <base64>   Daily public key as base64 SPKI DER',
    '    --not-before <iso>          Validity start ISO timestamp (default: now)',
    '    --not-after <iso>           Validity end ISO timestamp (default: notBefore + --ttl-hours)',
    '    --ttl-hours <hours>         Certificate lifetime in hours when --not-after omitted (default: 72)',
    '    --out <path>                Write certificate JSON to path (default: stdout)',
    '',
    '  sign-revocations   Sign a revocation list using the offline root private key',
    '    --root-key <path>           Root private key PEM file (or env OPENMOTION_ROOT_PRIVATE_KEY_PATH / _PEM)',
    '    --revoked <id1,id2>         Comma-separated revoked daily key IDs (repeatable)',
    '    --issued-at <iso>           Issued ISO timestamp (default: now)',
    '    --out <path>                Write revocation list JSON to path (default: stdout)',
    '',
    '  sign-config        Validate bounds and sign a config payload with a daily private key',
    '    --daily-key <path>          Daily private key PEM file (or env OPENMOTION_DAILY_PRIVATE_KEY_PATH / _PEM)',
    '    --cert <path>               Signed DailySigningCertificate JSON file (required)',
    '    --payload <path>            SignedConfigPayload JSON file (required)',
    '    --sequence <int>            Monotonic positive integer sequence number (required)',
    '    --issued-at <iso>           Issued ISO timestamp (default: now)',
    '    --expires-at <iso>          Optional envelope expiration ISO timestamp',
    '    --revocations <path>        Optional SignedRevocationList JSON file',
    '    --channel <stable|test|dev> Target channel for bounds check (default: stable)',
    '    --allow-local-dev-loopback  Allow 127.0.0.1/localhost URLs on dev channel',
    '    --out <path>                Write signed config envelope JSON to path (default: stdout)',
    '',
    '  verify-config      Verify a signed config envelope against a root public key',
    '    --config <path>             SignedConfigEnvelope JSON file (required)',
    '    --root-pub <path>           Root public key PEM/SPKI file (or --root-pub-spki / env OPENMOTION_ROOT_PUBLIC_KEY_*)',
    '    --root-pub-spki <base64>    Root public key as base64 SPKI DER',
    '    --channel <stable|test|dev> Target channel for bounds check (default: stable)',
    '    --allow-local-dev-loopback  Allow 127.0.0.1/localhost URLs on dev channel',
    '    --min-sequence <int>        Last accepted sequence floor (default: 0)',
    '    --now <iso>                 Override verification timestamp',
    '    --ignore-expiration         Skip daily cert / envelope expiration checks',
  ].join('\n');
}

function parseArgs(argv) {
  const flags = new Map();
  const multiFlags = new Map();
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eqIndex = token.indexOf('=');
    let key;
    let value;
    if (eqIndex !== -1) {
      key = token.slice(2, eqIndex);
      value = token.slice(eqIndex + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = 'true';
      }
    }
    flags.set(key, value);
    const list = multiFlags.get(key) ?? [];
    list.push(value);
    multiFlags.set(key, list);
  }

  return { positional, flags, multiFlags };
}

function readKeyMaterial({ flagPath, flagInline, envPath, envInline, label, env = process.env }) {
  if (flagInline) return flagInline.trim();
  if (flagPath) return readFileSync(flagPath, 'utf8').trim();
  if (envInline && env[envInline]) return env[envInline].trim();
  if (envPath && env[envPath]) return readFileSync(env[envPath], 'utf8').trim();
  throw new Error(`Missing ${label}: pass the CLI flag or set ${envPath ?? envInline}`);
}

function readJsonFile(filePath, label) {
  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJsonOutput(data, outPath, stdout) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (outPath) {
    mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    writeFileSync(outPath, serialized, 'utf8');
  } else {
    stdout(serialized);
  }
}

function parseChannel(raw) {
  const channel = raw ?? 'stable';
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`Invalid --channel "${channel}" (expected stable, test, or dev)`);
  }
  return channel;
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? (msg => process.stdout.write(msg));
  const stderr = io.stderr ?? (msg => process.stderr.write(msg));
  const env = io.env ?? process.env;

  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    stdout(printUsage() + '\n');
    return 0;
  }

  const { flags, multiFlags } = parseArgs(rest);
  if (flags.get('help') === 'true') {
    stdout(printUsage() + '\n');
    return 0;
  }

  try {
    if (command === 'keygen') {
      const privateOut = flags.get('private-out');
      if (!privateOut) {
        throw new Error('Missing required --private-out <path> (private key is never printed to stdout)');
      }
      const pair = generateEd25519KeyPair();
      mkdirSync(path.dirname(path.resolve(privateOut)), { recursive: true });
      writeFileSync(privateOut, pair.privateKeyPem, { encoding: 'utf8', mode: 0o600 });

      const publicOut = flags.get('public-out');
      if (publicOut) {
        mkdirSync(path.dirname(path.resolve(publicOut)), { recursive: true });
        writeFileSync(publicOut, pair.publicKeyPem, 'utf8');
      }
      const spkiOut = flags.get('spki-out');
      if (spkiOut) {
        mkdirSync(path.dirname(path.resolve(spkiOut)), { recursive: true });
        writeFileSync(spkiOut, `${pair.publicKeySpkiBase64}\n`, 'utf8');
      }

      stdout(
        JSON.stringify(
          {
            algorithm: 'Ed25519',
            privateKeyPath: privateOut,
            ...(publicOut ? { publicKeyPath: publicOut } : {}),
            ...(spkiOut ? { spkiPath: spkiOut } : {}),
            publicKeySpkiBase64: pair.publicKeySpkiBase64,
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    if (command === 'issue-daily-cert') {
      const keyId = flags.get('key-id');
      if (!keyId) throw new Error('Missing required --key-id');

      const rootPrivateKey = readKeyMaterial({
        flagPath: flags.get('root-key'),
        envPath: 'OPENMOTION_ROOT_PRIVATE_KEY_PATH',
        envInline: 'OPENMOTION_ROOT_PRIVATE_KEY_PEM',
        label: 'root private key (--root-key)',
        env,
      });

      const rawDailyPub = readKeyMaterial({
        flagPath: flags.get('daily-pub'),
        flagInline: flags.get('daily-pub-spki'),
        envPath: 'OPENMOTION_DAILY_PUBLIC_KEY_PATH',
        envInline: 'OPENMOTION_DAILY_PUBLIC_KEY_SPKI',
        label: 'daily public key (--daily-pub or --daily-pub-spki)',
        env,
      });
      const publicKeySpkiBase64 = exportPublicKeySpkiBase64(rawDailyPub);

      const notBefore = flags.get('not-before') ?? new Date().toISOString();
      const notBeforeMs = Date.parse(notBefore);
      if (!Number.isFinite(notBeforeMs)) {
        throw new Error(`Invalid --not-before timestamp: ${notBefore}`);
      }

      let notAfter = flags.get('not-after');
      if (!notAfter) {
        const ttlHours = Number(flags.get('ttl-hours') ?? '72');
        if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
          throw new Error(`Invalid --ttl-hours: ${flags.get('ttl-hours')}`);
        }
        notAfter = new Date(notBeforeMs + ttlHours * 3600 * 1000).toISOString();
      }

      const cert = signDailyCertificate({
        keyId,
        publicKeySpkiBase64,
        notBefore,
        notAfter,
        rootPrivateKey,
      });

      writeJsonOutput(cert, flags.get('out'), stdout);
      return 0;
    }

    if (command === 'sign-revocations') {
      const rootPrivateKey = readKeyMaterial({
        flagPath: flags.get('root-key'),
        envPath: 'OPENMOTION_ROOT_PRIVATE_KEY_PATH',
        envInline: 'OPENMOTION_ROOT_PRIVATE_KEY_PEM',
        label: 'root private key (--root-key)',
        env,
      });

      const rawRevoked = multiFlags.get('revoked') ?? [];
      const revokedKeyIds = rawRevoked
        .flatMap(entry => entry.split(','))
        .map(s => s.trim())
        .filter(Boolean);
      const issuedAt = flags.get('issued-at') ?? new Date().toISOString();

      const revocations = signRevocationList({
        issuedAt,
        revokedKeyIds,
        rootPrivateKey,
      });

      writeJsonOutput(revocations, flags.get('out'), stdout);
      return 0;
    }

    if (command === 'sign-config') {
      const dailyPrivateKey = readKeyMaterial({
        flagPath: flags.get('daily-key'),
        envPath: 'OPENMOTION_DAILY_PRIVATE_KEY_PATH',
        envInline: 'OPENMOTION_DAILY_PRIVATE_KEY_PEM',
        label: 'daily private key (--daily-key)',
        env,
      });

      const certificate = readJsonFile(flags.get('cert'), '--cert');
      const payload = readJsonFile(flags.get('payload'), '--payload');
      const revocationsPath = flags.get('revocations');
      const revocations = revocationsPath ? readJsonFile(revocationsPath, '--revocations') : undefined;

      const rawSeq = flags.get('sequence');
      const sequence = Number(rawSeq);
      if (!rawSeq || !Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error(`Invalid --sequence "${rawSeq ?? ''}" (must be a positive integer)`);
      }

      const channel = parseChannel(flags.get('channel'));
      const allowLocalDevLoopback = flags.get('allow-local-dev-loopback') === 'true';

      const issues = validateSignedConfigPayloadBounds(payload, {
        channel,
        allowLocalDevLoopback,
      });
      if (issues.length > 0) {
        throw new Error(
          `Payload violates built-in shell security bounds for channel "${channel}": ${issues
            .map(i => `${i.path}: ${i.message}`)
            .join('; ')}`,
        );
      }

      const issuedAt = flags.get('issued-at') ?? new Date().toISOString();
      const expiresAt = flags.get('expires-at');

      const envelope = signConfigEnvelope({
        sequence,
        issuedAt,
        ...(expiresAt ? { expiresAt } : {}),
        certificate,
        ...(revocations ? { revocations } : {}),
        payload,
        dailyPrivateKey,
      });

      writeJsonOutput(envelope, flags.get('out'), stdout);
      return 0;
    }

    if (command === 'verify-config') {
      const envelope = readJsonFile(flags.get('config'), '--config');
      const rootPublicKey = readKeyMaterial({
        flagPath: flags.get('root-pub'),
        flagInline: flags.get('root-pub-spki'),
        envPath: 'OPENMOTION_ROOT_PUBLIC_KEY_PATH',
        envInline: 'OPENMOTION_ROOT_PUBLIC_KEY_SPKI',
        label: 'root public key (--root-pub or --root-pub-spki)',
        env: env.OPENMOTION_ROOT_PUBLIC_KEY_PEM
          ? { ...env, OPENMOTION_ROOT_PUBLIC_KEY_SPKI: env.OPENMOTION_ROOT_PUBLIC_KEY_SPKI ?? env.OPENMOTION_ROOT_PUBLIC_KEY_PEM }
          : env,
      });

      const channel = parseChannel(flags.get('channel'));
      const allowLocalDevLoopback = flags.get('allow-local-dev-loopback') === 'true';
      const ignoreExpiration = flags.get('ignore-expiration') === 'true';
      const now = flags.get('now');
      const rawMinSeq = flags.get('min-sequence');
      const lastAcceptedSequence = rawMinSeq !== undefined ? Number(rawMinSeq) : undefined;

      const result = verifySignedConfigEnvelope(envelope, {
        rootPublicKey,
        channel,
        allowLocalDevLoopback,
        ignoreExpiration,
        ...(now ? { now } : {}),
        ...(lastAcceptedSequence !== undefined ? { lastAcceptedSequence } : {}),
      });

      if (result.ok) {
        stdout(
          JSON.stringify(
            {
              ok: true,
              sequence: result.sequence,
              certificateKeyId: result.certificateKeyId,
              verifiedRevokedKeyIds: result.verifiedRevokedKeyIds,
            },
            null,
            2,
          ) + '\n',
        );
        return 0;
      }

      stderr(
        JSON.stringify(
          {
            ok: false,
            code: result.code,
            message: result.message,
            ...(result.issues ? { issues: result.issues } : {}),
          },
          null,
          2,
        ) + '\n',
      );
      return 1;
    }

    stderr(`Unknown command: ${command}\n\n${printUsage()}\n`);
    return 1;
  } catch (err) {
    stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
