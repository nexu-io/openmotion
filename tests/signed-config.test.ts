import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalJson,
  createBundledDefaultConfigPayload,
  EMBEDDED_ROOT_PUBLIC_KEY_SPKI_BASE64,
  generateEd25519KeyPair,
  isEmbeddedRootPublicKeyPlaceholder,
  signConfigEnvelope,
  signDailyCertificate,
  SignedConfigManager,
  signRevocationList,
  verifySignedConfigEnvelope,
} from '../packages/signed-config/index.ts';
import { DEFAULT_STUDIO_URLS } from '../shared/desktop-builtin-rules.ts';
import {
  SIGNED_CONFIG_FORMAT_VERSION,
  validateSignedConfigPayloadBounds,
  type SignedConfigEnvelope,
  type SignedConfigPayload,
} from '../shared/signed-config.ts';
import { runCli } from '../scripts/sign-desktop-config.mjs';

const BASE_TIME = Date.parse('2026-11-23T12:00:00.000Z');
const HOUR_MS = 3600 * 1000;

function isoAt(offsetHours: number): string {
  return new Date(BASE_TIME + offsetHours * HOUR_MS).toISOString();
}

function createTempDir(prefix = 'openmotion-signed-config-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTestPki(keyId = 'daily-2026-11-23', notBeforeOffset = -1, notAfterOffset = 72) {
  const root = generateEd25519KeyPair();
  const daily = generateEd25519KeyPair();
  const cert = signDailyCertificate({
    keyId,
    publicKeySpkiBase64: daily.publicKeySpkiBase64,
    notBefore: isoAt(notBeforeOffset),
    notAfter: isoAt(notAfterOffset),
    rootPrivateKey: root.privateKey,
  });
  return { root, daily, cert };
}

test('canonicalJson produces deterministic cross-platform output and rejects invalid inputs', () => {
  const a = {
    z: 1,
    a: { y: true, x: null, omitted: undefined },
    m: [3, undefined, { b: 'two', a: 'one', skip: undefined }],
    zero: -0,
  };
  const b = {
    m: [3, null, { a: 'one', b: 'two' }],
    zero: 0,
    a: { x: null, y: true },
    z: 1,
  };

  const outA = canonicalJson(a);
  const outB = canonicalJson(b);
  assert.equal(outA, outB);
  assert.equal(outA, '{"a":{"x":null,"y":true},"m":[3,null,{"a":"one","b":"two"}],"z":1,"zero":0}');

  assert.throws(() => canonicalJson(undefined), TypeError);
  assert.throws(() => canonicalJson({ bad: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ bad: Number.POSITIVE_INFINITY }), TypeError);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), TypeError);
});

test('bundled default config passes bounds validation for all channels and marks root key as placeholder', () => {
  assert.equal(isEmbeddedRootPublicKeyPlaceholder(EMBEDDED_ROOT_PUBLIC_KEY_SPKI_BASE64), true);

  const stable = createBundledDefaultConfigPayload('stable');
  assert.deepEqual(validateSignedConfigPayloadBounds(stable, { channel: 'stable' }), []);
  assert.equal(stable.studioUrl, 'https://motion.open-design.ai');
  assert.deepEqual(stable.allowedOrigins, ['https://motion.open-design.ai']);

  assert.equal(stable.agents?.codex?.versionTemplateId, 'codex.version');
  assert.equal(stable.agents?.codex?.mcpAddTemplateId, 'codex.mcp.add_remote');
  assert.equal(stable.agents?.codex?.mcpRemoveTemplateId, 'codex.mcp.remove');
  assert.equal(stable.agents?.claude?.versionTemplateId, 'claude.version');
  assert.equal(stable.agents?.claude?.mcpAddTemplateId, 'claude.mcp.add_remote');
  assert.equal(stable.agents?.claude?.mcpRemoveTemplateId, 'claude.mcp.remove');

  assert.deepEqual(stable.configRules?.codex_mcp, {
    ruleId: 'codex_mcp',
    agentId: 'codex',
    displayName: 'Codex MCP Configuration',
    fileFormat: 'toml',
    homeRelativePath: '.codex/config.toml',
    fieldType: 'remote_mcp_entry',
    sectionPath: 'mcp_servers',
  });
  assert.deepEqual(stable.configRules?.claude_mcp, {
    ruleId: 'claude_mcp',
    agentId: 'claude',
    displayName: 'Claude Code MCP Configuration',
    fileFormat: 'json',
    homeRelativePath: '.claude.json',
    fieldType: 'remote_mcp_entry',
    sectionPath: 'mcpServers',
  });

  assert.equal(stable.features?.mcp_connect?.version, '1.0.0');
  assert.ok(stable.features?.mcp_connect?.commandTemplateIds?.includes('codex.mcp.add_remote'));
  assert.ok(stable.features?.mcp_connect?.commandTemplateIds?.includes('claude.mcp.add_remote'));
  assert.deepEqual(stable.features?.mcp_connect?.configRuleIds, [
    'codex_mcp',
    'claude_mcp',
    'cursor_mcp',
    'windsurf_mcp',
    'opencode_mcp',
    'antigravity_mcp',
  ]);

  const testPayload = createBundledDefaultConfigPayload('test');
  assert.deepEqual(validateSignedConfigPayloadBounds(testPayload, { channel: 'test' }), []);

  const devPayload = createBundledDefaultConfigPayload('dev');
  assert.deepEqual(
    validateSignedConfigPayloadBounds(devPayload, { channel: 'dev', allowLocalDevLoopback: true }),
    [],
  );
});

test('two-tier Ed25519 cert + config signing passes verification with PEM, SPKI base64, and KeyObject', () => {
  const { root, daily, cert } = createTestPki();
  const payload = createBundledDefaultConfigPayload('stable');
  const envelope = signConfigEnvelope({
    sequence: 1,
    issuedAt: isoAt(0),
    expiresAt: isoAt(48),
    certificate: cert,
    payload,
    dailyPrivateKey: daily.privateKey,
  });

  for (const rootOpt of [
    { rootPublicKey: root.publicKey },
    { rootPublicKey: root.publicKeyPem },
    { rootPublicKey: root.publicKeySpkiBase64 },
    { rootPublicKeyPem: root.publicKeyPem },
  ]) {
    const verified = verifySignedConfigEnvelope(envelope, {
      ...rootOpt,
      channel: 'stable',
      now: BASE_TIME,
    });
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.sequence, 1);
      assert.equal(verified.certificateKeyId, 'daily-2026-11-23');
      assert.equal(verified.payload.studioUrl, 'https://motion.open-design.ai');
    }
  }
});

test('rejects tampered payload and tampered envelope metadata', () => {
  const { root, daily, cert } = createTestPki();
  const envelope = signConfigEnvelope({
    sequence: 5,
    issuedAt: isoAt(0),
    certificate: cert,
    payload: createBundledDefaultConfigPayload('stable'),
    dailyPrivateKey: daily.privateKey,
  });

  const tamperedPayload = structuredClone(envelope);
  tamperedPayload.payload.featureFlags = { mcpConnect: false };
  const res1 = verifySignedConfigEnvelope(tamperedPayload, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
  });
  assert.equal(res1.ok, false);
  if (!res1.ok) assert.equal(res1.code, 'INVALID_ENVELOPE_SIGNATURE');

  const tamperedSeq = structuredClone(envelope);
  tamperedSeq.sequence = 6;
  const res2 = verifySignedConfigEnvelope(tamperedSeq, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
  });
  assert.equal(res2.ok, false);
  if (!res2.ok) assert.equal(res2.code, 'INVALID_ENVELOPE_SIGNATURE');
});

test('rejects wrong root key and forged daily signing certificate', () => {
  const realRoot = generateEd25519KeyPair();
  const attackerRoot = generateEd25519KeyPair();
  const attackerDaily = generateEd25519KeyPair();

  const forgedCert = signDailyCertificate({
    keyId: 'daily-forged',
    publicKeySpkiBase64: attackerDaily.publicKeySpkiBase64,
    notBefore: isoAt(-1),
    notAfter: isoAt(72),
    rootPrivateKey: attackerRoot.privateKey,
  });

  const envelope = signConfigEnvelope({
    sequence: 1,
    issuedAt: isoAt(0),
    certificate: forgedCert,
    payload: createBundledDefaultConfigPayload('stable'),
    dailyPrivateKey: attackerDaily.privateKey,
  });

  const res = verifySignedConfigEnvelope(envelope, {
    rootPublicKey: realRoot.publicKeySpkiBase64,
    now: BASE_TIME,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'INVALID_CERTIFICATE_SIGNATURE');
});

test('rejects expired and not-yet-valid daily certs on verification unless ignoreExpiration is set', () => {
  const { root, daily, cert } = createTestPki('daily-window', 0, 24);
  const envelope = signConfigEnvelope({
    sequence: 1,
    issuedAt: isoAt(0),
    certificate: cert,
    payload: createBundledDefaultConfigPayload('stable'),
    dailyPrivateKey: daily.privateKey,
  });

  const tooEarly = verifySignedConfigEnvelope(envelope, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME - HOUR_MS,
  });
  assert.equal(tooEarly.ok, false);
  if (!tooEarly.ok) assert.equal(tooEarly.code, 'CERTIFICATE_NOT_YET_VALID');

  const expired = verifySignedConfigEnvelope(envelope, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME + 25 * HOUR_MS,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, 'CERTIFICATE_EXPIRED');

  const cachedReuse = verifySignedConfigEnvelope(envelope, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME + 25 * HOUR_MS,
    ignoreExpiration: true,
  });
  assert.equal(cachedReuse.ok, true);
});

test('rejects revoked daily key via root-signed revocation list and rejects forged revocation list', () => {
  const { root, daily, cert } = createTestPki('daily-compromised');
  const revocations = signRevocationList({
    issuedAt: isoAt(0),
    revokedKeyIds: ['daily-compromised'],
    rootPrivateKey: root.privateKey,
  });

  const envelopeWithRevocation = signConfigEnvelope({
    sequence: 2,
    issuedAt: isoAt(0),
    certificate: cert,
    revocations,
    payload: createBundledDefaultConfigPayload('stable'),
    dailyPrivateKey: daily.privateKey,
  });

  const revokedRes = verifySignedConfigEnvelope(envelopeWithRevocation, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
  });
  assert.equal(revokedRes.ok, false);
  if (!revokedRes.ok) {
    assert.equal(revokedRes.code, 'CERTIFICATE_REVOKED');
    assert.deepEqual(revokedRes.verifiedRevokedKeyIds, ['daily-compromised']);
  }

  // Forged revocation list signed by a non-root key must fail verification.
  const attacker = generateEd25519KeyPair();
  const forgedRevocations = signRevocationList({
    issuedAt: isoAt(0),
    revokedKeyIds: ['some-other-key'],
    rootPrivateKey: attacker.privateKey,
  });
  const envelopeWithForgedRev = signConfigEnvelope({
    sequence: 3,
    issuedAt: isoAt(0),
    certificate: cert,
    revocations: forgedRevocations,
    payload: createBundledDefaultConfigPayload('stable'),
    dailyPrivateKey: daily.privateKey,
  });

  const forgedRes = verifySignedConfigEnvelope(envelopeWithForgedRev, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
  });
  assert.equal(forgedRes.ok, false);
  if (!forgedRes.ok) assert.equal(forgedRes.code, 'INVALID_REVOCATION_LIST');
});

test('enforces monotonic sequence anti-rollback protection', () => {
  const { root, daily, cert } = createTestPki();
  const env5 = signConfigEnvelope({
    sequence: 5,
    issuedAt: isoAt(0),
    certificate: cert,
    payload: createBundledDefaultConfigPayload('stable'),
    dailyPrivateKey: daily.privateKey,
  });

  const rollback = verifySignedConfigEnvelope(env5, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
    lastAcceptedSequence: 6,
  });
  assert.equal(rollback.ok, false);
  if (!rollback.ok) assert.equal(rollback.code, 'SEQUENCE_ROLLBACK');

  const equalAllowed = verifySignedConfigEnvelope(env5, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
    lastAcceptedSequence: 5,
  });
  assert.equal(equalAllowed.ok, true);

  const equalRejected = verifySignedConfigEnvelope(env5, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
    lastAcceptedSequence: 5,
    allowEqualSequence: false,
  });
  assert.equal(equalRejected.ok, false);
  if (!equalRejected.ok) assert.equal(equalRejected.code, 'SEQUENCE_ROLLBACK');
});

test('returns UNSUPPORTED_FORMAT_VERSION for higher/unknown formatVersion', () => {
  const { root, daily, cert } = createTestPki();
  const futureEnv = signConfigEnvelope({
    formatVersion: SIGNED_CONFIG_FORMAT_VERSION + 1,
    sequence: 10,
    issuedAt: isoAt(0),
    certificate: cert,
    payload: createBundledDefaultConfigPayload('stable'),
    dailyPrivateKey: daily.privateKey,
  });

  const res = verifySignedConfigEnvelope(futureEnv, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'UNSUPPORTED_FORMAT_VERSION');
});

test('tolerates unknown payload fields for forward compatibility while protecting them under signature', () => {
  const { root, daily, cert } = createTestPki();
  const payloadWithFutureFields = {
    ...createBundledDefaultConfigPayload('stable'),
    futureExperiment: { rollout: 0.5, mode: 'adaptive' },
    agents: {
      ...createBundledDefaultConfigPayload('stable').agents,
      codex: {
        ...createBundledDefaultConfigPayload('stable').agents!.codex,
        futureHint: 'v2-metadata',
      },
    },
  };

  const envelope = signConfigEnvelope({
    sequence: 1,
    issuedAt: isoAt(0),
    certificate: cert,
    payload: payloadWithFutureFields,
    dailyPrivateKey: daily.privateKey,
  });

  const verified = verifySignedConfigEnvelope(envelope, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
  });
  assert.equal(verified.ok, true);

  // Tampering with an unknown field must still invalidate the signature.
  const tamperedUnknown = structuredClone(envelope);
  (tamperedUnknown.payload as Record<string, unknown>).futureExperiment = { rollout: 1.0 };
  const tamperedRes = verifySignedConfigEnvelope(tamperedUnknown, {
    rootPublicKey: root.publicKeySpkiBase64,
    now: BASE_TIME,
  });
  assert.equal(tamperedRes.ok, false);
  if (!tamperedRes.ok) assert.equal(tamperedRes.code, 'INVALID_ENVELOPE_SIGNATURE');
});

test('rejects out-of-bounds payloads even when validly signed by root + daily keys', () => {
  const { root, daily, cert } = createTestPki();

  const makeSigned = (payload: SignedConfigPayload) =>
    signConfigEnvelope({
      sequence: 1,
      issuedAt: isoAt(0),
      certificate: cert,
      payload,
      dailyPrivateKey: daily.privateKey,
    });

  const invalidCases: Array<{ name: string; payload: SignedConfigPayload; expectedPath: string }> = [
    {
      name: 'bad studioUrl domain',
      payload: {
        ...createBundledDefaultConfigPayload('stable'),
        studioUrl: 'https://evil.example.com',
      },
      expectedPath: 'studioUrl',
    },
    {
      name: 'staging domain disallowed on stable channel',
      payload: {
        ...createBundledDefaultConfigPayload('stable'),
        studioUrl: DEFAULT_STUDIO_URLS.test,
      },
      expectedPath: 'studioUrl',
    },
    {
      name: 'unknown third-party command template',
      payload: {
        ...createBundledDefaultConfigPayload('stable'),
        agents: {
          codex: {
            agentId: 'codex',
            displayName: 'Codex CLI',
            binaryName: 'codex',
            mcpAddTemplateId: 'shell.arbitrary_exec',
          },
        },
      },
      expectedPath: 'agents.codex.mcpAddTemplateId',
    },
    {
      name: 'untrusted component publisher',
      payload: {
        ...createBundledDefaultConfigPayload('stable'),
        components: {
          'murmur-engine': {
            componentId: 'murmur-engine',
            displayName: 'Murmur Engine',
            minVersion: '1.0.0',
            platforms: {
              'darwin-arm64': {
                url: 'https://releases.open-design.ai/murmur/1.0.0/murmur.tar.gz',
                sha256: 'a'.repeat(64),
                publisherId: 'untrusted-publisher',
              },
            },
          },
        },
      },
      expectedPath: 'components.murmur-engine.platforms.darwin-arm64.publisherId',
    },
    {
      name: 'path traversal in configRules',
      payload: {
        ...createBundledDefaultConfigPayload('stable'),
        configRules: {
          evil: {
            ruleId: 'evil',
            agentId: 'codex',
            displayName: 'Evil Rule',
            fileFormat: 'json',
            homeRelativePath: '../.ssh/authorized_keys',
            fieldType: 'remote_mcp_entry',
            sectionPath: 'mcpServers',
          },
        },
      },
      expectedPath: 'configRules.evil.homeRelativePath',
    },
    {
      name: 'absolute path in configRules',
      payload: {
        ...createBundledDefaultConfigPayload('stable'),
        configRules: {
          evil_abs: {
            ruleId: 'evil_abs',
            agentId: 'codex',
            displayName: 'Evil Abs',
            fileFormat: 'json',
            homeRelativePath: '/etc/hosts',
            fieldType: 'remote_mcp_entry',
            sectionPath: 'mcpServers',
          },
        },
      },
      expectedPath: 'configRules.evil_abs.homeRelativePath',
    },
  ];

  for (const tc of invalidCases) {
    const res = verifySignedConfigEnvelope(makeSigned(tc.payload), {
      rootPublicKey: root.publicKeySpkiBase64,
      channel: 'stable',
      now: BASE_TIME,
    });
    assert.equal(res.ok, false, `Expected failure for: ${tc.name}`);
    if (!res.ok) {
      assert.equal(res.code, 'PAYLOAD_OUT_OF_BOUNDS', `Expected PAYLOAD_OUT_OF_BOUNDS for: ${tc.name}`);
      assert.ok(
        res.issues?.some(i => i.path === tc.expectedPath),
        `Expected issue at ${tc.expectedPath} for ${tc.name}, got ${JSON.stringify(res.issues)}`,
      );
    }
  }
});

test('SignedConfigManager handles fallback, persistence, expired cert survival, rollback, formatVersion fallback, and revocation', async () => {
  const dataDir = createTempDir();
  try {
    const { root, daily, cert } = createTestPki('daily-v1', -1, 24);
    let currentTime = BASE_TIME;

    // 1. Fresh start falls back to bundled default.
    const manager1 = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => currentTime,
      fetchFn: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(manager1.getStatus().source, 'bundled-default');
    assert.equal(manager1.getActiveConfig().studioUrl, 'https://motion.open-design.ai');

    // 2. Network failure preserves bundled default and records error.
    const offlineRes = await manager1.fetchAndApply('https://releases.open-design.ai/config/stable.json');
    assert.equal(offlineRes.applied, false);
    if (!offlineRes.applied) assert.equal(offlineRes.code, 'FETCH_FAILED');
    assert.equal(manager1.getStatus().source, 'bundled-default');
    assert.equal(manager1.getStatus().lastError?.code, 'FETCH_FAILED');

    // 3. Valid fetch applies verified config and persists to <dataDir>/signed-config/state.json.
    const payloadV10: SignedConfigPayload = {
      ...createBundledDefaultConfigPayload('stable'),
      studioUrl: 'https://studio.open-design.ai',
      allowedOrigins: ['https://studio.open-design.ai'],
      featureFlags: { mcpConnect: true, desktopBridgeV2: true },
    };
    const envV10 = signConfigEnvelope({
      sequence: 10,
      issuedAt: isoAt(0),
      certificate: cert,
      payload: payloadV10,
      dailyPrivateKey: daily.privateKey,
    });

    const manager2 = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => currentTime,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(envV10),
      }),
    });
    const applyV10 = await manager2.fetchAndApply('https://releases.open-design.ai/config/stable.json');
    assert.equal(applyV10.applied, true);
    if (applyV10.applied) {
      assert.equal(applyV10.sequence, 10);
      assert.equal(applyV10.unchanged, false);
    }
    assert.equal(manager2.getStatus().source, 'verified');
    assert.equal(manager2.getActiveConfig().studioUrl, 'https://studio.open-design.ai');

    // 4. Restart after daily cert expires: previously accepted config stays usable!
    currentTime = BASE_TIME + 48 * HOUR_MS; // 24 hours past cert.notAfter
    const managerAfterExpiry = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => currentTime,
    });
    const statusAfterExpiry = managerAfterExpiry.getStatus();
    assert.equal(statusAfterExpiry.source, 'last-known-good');
    assert.equal(statusAfterExpiry.activeSequence, 10);
    assert.equal(statusAfterExpiry.highestAcceptedSequence, 10);
    assert.equal(statusAfterExpiry.certificateExpired, true);
    assert.equal(managerAfterExpiry.getActiveConfig().studioUrl, 'https://studio.open-design.ai');

    // 5. New incoming config signed by expired cert is rejected; last-known-good remains active.
    const envV11Expired = signConfigEnvelope({
      sequence: 11,
      issuedAt: isoAt(48),
      certificate: cert,
      payload: createBundledDefaultConfigPayload('stable'),
      dailyPrivateKey: daily.privateKey,
    });
    const rejectedExpired = managerAfterExpiry.applyEnvelope(envV11Expired);
    assert.equal(rejectedExpired.applied, false);
    if (!rejectedExpired.applied) assert.equal(rejectedExpired.code, 'CERTIFICATE_EXPIRED');
    assert.equal(managerAfterExpiry.getStatus().source, 'last-known-good');
    assert.equal(managerAfterExpiry.getActiveConfig().studioUrl, 'https://studio.open-design.ai');

    // 6. Fresh daily cert succeeds on sequence 11, then rollback to sequence 10 is rejected.
    const daily2 = generateEd25519KeyPair();
    const cert2 = signDailyCertificate({
      keyId: 'daily-v2',
      publicKeySpkiBase64: daily2.publicKeySpkiBase64,
      notBefore: isoAt(40),
      notAfter: isoAt(120),
      rootPrivateKey: root.privateKey,
    });
    const envV11Valid = signConfigEnvelope({
      sequence: 11,
      issuedAt: isoAt(48),
      certificate: cert2,
      payload: {
        ...payloadV10,
        featureFlags: { mcpConnect: true, desktopBridgeV2: true, upgraded: true },
      },
      dailyPrivateKey: daily2.privateKey,
    });
    const applyV11 = managerAfterExpiry.applyEnvelope(envV11Valid);
    assert.equal(applyV11.applied, true);
    assert.equal(managerAfterExpiry.getStatus().activeSequence, 11);

    const envV10Rollback = signConfigEnvelope({
      sequence: 10,
      issuedAt: isoAt(48),
      certificate: cert2,
      payload: payloadV10,
      dailyPrivateKey: daily2.privateKey,
    });
    const rollbackRes = managerAfterExpiry.applyEnvelope(envV10Rollback);
    assert.equal(rollbackRes.applied, false);
    if (!rollbackRes.applied) assert.equal(rollbackRes.code, 'SEQUENCE_ROLLBACK');
    assert.equal(managerAfterExpiry.getStatus().activeSequence, 11);

    // 7. Unsupported formatVersion falls back cleanly to active config without clobbering it.
    const envFutureFormat = signConfigEnvelope({
      formatVersion: 99,
      sequence: 12,
      issuedAt: isoAt(48),
      certificate: cert2,
      payload: payloadV10,
      dailyPrivateKey: daily2.privateKey,
    });
    const futureRes = managerAfterExpiry.applyEnvelope(envFutureFormat);
    assert.equal(futureRes.applied, false);
    if (!futureRes.applied) assert.equal(futureRes.code, 'UNSUPPORTED_FORMAT_VERSION');
    assert.equal(managerAfterExpiry.getStatus().activeSequence, 11);

    // 8. Emergency revocation of active key `daily-v2` evicts active config & persists revocation!
    const revokeV2 = signRevocationList({
      issuedAt: isoAt(48),
      revokedKeyIds: ['daily-v2'],
      rootPrivateKey: root.privateKey,
    });
    const envRevokingV2 = signConfigEnvelope({
      sequence: 12,
      issuedAt: isoAt(48),
      certificate: cert2,
      revocations: revokeV2,
      payload: payloadV10,
      dailyPrivateKey: daily2.privateKey,
    });
    const revokeRes = managerAfterExpiry.applyEnvelope(envRevokingV2);
    assert.equal(revokeRes.applied, false);
    if (!revokeRes.applied) assert.equal(revokeRes.code, 'CERTIFICATE_REVOKED');
    assert.equal(managerAfterExpiry.getStatus().source, 'bundled-default');
    assert.ok(managerAfterExpiry.getStatus().revokedKeyIds.includes('daily-v2'));

    // Restart still remembers revocation and highestAcceptedSequence.
    const managerAfterRevoke = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => currentTime,
    });
    assert.equal(managerAfterRevoke.getStatus().source, 'bundled-default');
    assert.equal(managerAfterRevoke.getStatus().highestAcceptedSequence, 11);
    assert.ok(managerAfterRevoke.getStatus().revokedKeyIds.includes('daily-v2'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('SignedConfigManager handles fetch timeout and disk tampering gracefully', async () => {
  const dataDir = createTempDir();
  try {
    const { root, daily, cert } = createTestPki();
    const env1 = signConfigEnvelope({
      sequence: 1,
      issuedAt: isoAt(0),
      certificate: cert,
      payload: {
        ...createBundledDefaultConfigPayload('stable'),
        studioUrl: 'https://custom.open-design.ai',
        allowedOrigins: ['https://custom.open-design.ai'],
      },
      dailyPrivateKey: daily.privateKey,
    });

    const manager = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => BASE_TIME,
      fetchTimeoutMs: 25,
      fetchFn: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        }),
    });

    const applyRes = manager.applyEnvelope(env1);
    assert.equal(applyRes.applied, true);

    const timeoutRes = await manager.fetchAndApply('https://releases.open-design.ai/config/stable.json');
    assert.equal(timeoutRes.applied, false);
    if (!timeoutRes.applied) assert.equal(timeoutRes.code, 'FETCH_TIMEOUT');
    assert.equal(manager.getActiveConfig().studioUrl, 'https://custom.open-design.ai');

    // Tamper with persisted state.json on disk and ensure restart rejects it.
    const statePath = manager.getStatus().stateFilePath;
    const rawState = JSON.parse(readFileSync(statePath, 'utf8')) as {
      lastKnownGood: SignedConfigEnvelope;
    };
    rawState.lastKnownGood.payload.studioUrl = 'https://evil.example.com';
    writeFileSync(statePath, JSON.stringify(rawState, null, 2), 'utf8');

    const restarted = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: root.publicKeySpkiBase64,
      now: () => BASE_TIME,
    });
    assert.equal(restarted.getStatus().source, 'bundled-default');
    assert.equal(restarted.getActiveConfig().studioUrl, 'https://motion.open-design.ai');
    assert.equal(restarted.getStatus().lastError?.code, 'INVALID_ENVELOPE_SIGNATURE');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sign-desktop-config.mjs CLI issues daily cert, signs config, and verifies end-to-end', () => {
  const workDir = createTempDir('openmotion-sign-cli-');
  try {
    const root = generateEd25519KeyPair();
    const daily = generateEd25519KeyPair();

    const rootPrivPath = path.join(workDir, 'root-private.pem');
    const rootPubPath = path.join(workDir, 'root-public.pem');
    const dailyPrivPath = path.join(workDir, 'daily-private.pem');
    const dailyPubPath = path.join(workDir, 'daily-public.pem');
    const certPath = path.join(workDir, 'daily-cert.json');
    const payloadPath = path.join(workDir, 'payload.json');
    const configPath = path.join(workDir, 'signed-config.json');

    writeFileSync(rootPrivPath, root.privateKeyPem, 'utf8');
    writeFileSync(rootPubPath, root.publicKeyPem, 'utf8');
    writeFileSync(dailyPrivPath, daily.privateKeyPem, 'utf8');
    writeFileSync(dailyPubPath, daily.publicKeyPem, 'utf8');
    writeFileSync(payloadPath, JSON.stringify(createBundledDefaultConfigPayload('stable'), null, 2), 'utf8');

    const capture = () => {
      let out = '';
      let err = '';
      return {
        io: {
          stdout: (s: string) => {
            out += s;
          },
          stderr: (s: string) => {
            err += s;
          },
          env: {},
        },
        getOut: () => out,
        getErr: () => err,
      };
    };

    const c1 = capture();
    const code1 = runCli(
      [
        'issue-daily-cert',
        '--key-id',
        'daily-cli-01',
        '--root-key',
        rootPrivPath,
        '--daily-pub',
        dailyPubPath,
        '--not-before',
        isoAt(-1),
        '--not-after',
        isoAt(72),
        '--out',
        certPath,
      ],
      c1.io,
    );
    assert.equal(code1, 0, c1.getErr());

    const c2 = capture();
    const code2 = runCli(
      [
        'sign-config',
        '--daily-key',
        dailyPrivPath,
        '--cert',
        certPath,
        '--payload',
        payloadPath,
        '--sequence',
        '42',
        '--issued-at',
        isoAt(0),
        '--channel',
        'stable',
        '--out',
        configPath,
      ],
      c2.io,
    );
    assert.equal(code2, 0, c2.getErr());

    const c3 = capture();
    const code3 = runCli(
      [
        'verify-config',
        '--config',
        configPath,
        '--root-pub',
        rootPubPath,
        '--channel',
        'stable',
        '--now',
        isoAt(0),
      ],
      c3.io,
    );
    assert.equal(code3, 0, c3.getErr());
    const verifyOut = JSON.parse(c3.getOut()) as { ok: boolean; sequence: number; certificateKeyId: string };
    assert.equal(verifyOut.ok, true);
    assert.equal(verifyOut.sequence, 42);
    assert.equal(verifyOut.certificateKeyId, 'daily-cli-01');

    // Out-of-bounds payload must be refused by sign-config before signing.
    const badPayloadPath = path.join(workDir, 'bad-payload.json');
    writeFileSync(
      badPayloadPath,
      JSON.stringify({ studioUrl: 'https://malicious.example.com' }, null, 2),
      'utf8',
    );
    const c4 = capture();
    const code4 = runCli(
      [
        'sign-config',
        '--daily-key',
        dailyPrivPath,
        '--cert',
        certPath,
        '--payload',
        badPayloadPath,
        '--sequence',
        '43',
        '--channel',
        'stable',
      ],
      c4.io,
    );
    assert.equal(code4, 1);
    assert.match(c4.getErr(), /bounds/i);

    // keygen subcommand generates an Ed25519 keypair with private key on disk and SPKI base64 on stdout.
    const genPrivPath = path.join(workDir, 'gen-root.pem');
    const genPubPath = path.join(workDir, 'gen-root.pub.pem');
    const genSpkiPath = path.join(workDir, 'gen-root.spki.txt');
    const c5 = capture();
    const code5 = runCli(
      ['keygen', '--private-out', genPrivPath, '--public-out', genPubPath, '--spki-out', genSpkiPath],
      c5.io,
    );
    assert.equal(code5, 0, c5.getErr());
    const keygenOut = JSON.parse(c5.getOut()) as { algorithm: string; publicKeySpkiBase64: string };
    assert.equal(keygenOut.algorithm, 'Ed25519');
    assert.equal(readFileSync(genSpkiPath, 'utf8').trim(), keygenOut.publicKeySpkiBase64);
    assert.match(readFileSync(genPrivPath, 'utf8'), /BEGIN PRIVATE KEY/);
    assert.match(readFileSync(genPubPath, 'utf8'), /BEGIN PUBLIC KEY/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
