/**
 * Two-Tier Ed25519 Signed Configuration Verifier & Signing Helpers.
 *
 * Trust chain (Design Doc §5.6):
 * 1. Offline Root Ed25519 key signs a time-bounded DailySigningCertificate
 *    and optional SignedRevocationList.
 * 2. Daily Ed25519 key signs the config envelope containing a monotonic
 *    sequence number and payload.
 * 3. After cryptographic & sequence checks pass, the payload is validated
 *    against the shell's built-in security rules (domain scope, publishers,
 *    built-in templates, field types, safe paths).
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import type { HostReleaseChannel } from '../../shared/desktop-contract.ts';
import {
  SIGNED_CONFIG_FORMAT_VERSION,
  validateSignedConfigPayloadBounds,
  type DailySigningCertificate,
  type SignedConfigEnvelope,
  type SignedConfigPayload,
  type SignedConfigValidationIssue,
  type SignedRevocationList,
} from '../../shared/signed-config.ts';
import { canonicalJsonBytes } from './canonical.ts';
import { BUILTIN_REVOKED_KEY_IDS, resolveEmbeddedRootPublicKeySpki } from './default-config.ts';

export type SignedConfigFailureCode =
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_FORMAT_VERSION'
  | 'INVALID_ROOT_KEY'
  | 'INVALID_CERTIFICATE'
  | 'INVALID_CERTIFICATE_SIGNATURE'
  | 'CERTIFICATE_NOT_YET_VALID'
  | 'CERTIFICATE_EXPIRED'
  | 'INVALID_REVOCATION_LIST'
  | 'CERTIFICATE_REVOKED'
  | 'INVALID_ENVELOPE_SIGNATURE'
  | 'ENVELOPE_EXPIRED'
  | 'INVALID_SEQUENCE'
  | 'SEQUENCE_ROLLBACK'
  | 'PAYLOAD_OUT_OF_BOUNDS';

export type VerifySignedConfigOptions = {
  /** Root Ed25519 public key as PEM, base64 SPKI DER, or KeyObject. */
  rootPublicKey?: string | KeyObject;
  /** Alias for rootPublicKey accepting PEM or base64 SPKI DER. */
  rootPublicKeyPem?: string;
  /** Release channel for built-in domain bounds validation (default: 'stable'). */
  channel?: HostReleaseChannel;
  /** Allow http://127.0.0.1 and http://localhost when channel === 'dev'. */
  allowLocalDevLoopback?: boolean;
  /** Current timestamp for validity window checks (default: Date.now()). */
  now?: Date | number | string;
  /** Highest previously accepted sequence number (rejects sequence < this value). */
  lastAcceptedSequence?: number;
  /**
   * When false, rejects `sequence === lastAcceptedSequence` as SEQUENCE_ROLLBACK
   * (useful when strictly requiring a newer incoming sequence). Defaults to true.
   */
  allowEqualSequence?: boolean;
  /** Additional persisted or built-in revoked daily signing key IDs. */
  revokedKeyIds?: Iterable<string>;
  /**
   * Skip expiration checks (daily cert notAfter and envelope expiresAt).
   * Intended ONLY for re-verifying already-accepted last-known-good cached configs
   * on startup; never enable for freshly fetched configs.
   */
  ignoreExpiration?: boolean;
};

export type VerifySignedConfigSuccess = {
  ok: true;
  envelope: SignedConfigEnvelope;
  payload: SignedConfigPayload;
  sequence: number;
  certificateKeyId: string;
  verifiedRevokedKeyIds: string[];
};

export type VerifySignedConfigFailure = {
  ok: false;
  code: SignedConfigFailureCode;
  message: string;
  issues?: SignedConfigValidationIssue[];
  /**
   * If the envelope included a validly root-signed revocation list, its merged
   * revoked key IDs are returned even when the envelope itself fails later checks.
   */
  verifiedRevokedKeyIds?: string[];
};

export type VerifySignedConfigResult = VerifySignedConfigSuccess | VerifySignedConfigFailure;

export type Ed25519KeyPair = {
  publicKey: KeyObject;
  privateKey: KeyObject;
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeySpkiBase64: string;
};

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseIsoTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveNowMs(now: Date | number | string | undefined): number {
  if (now === undefined) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function decodeStrictBase64(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || !BASE64_RE.test(trimmed)) {
    return null;
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length === 0) return null;
  return buf;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeySpkiBase64 = exportPublicKeySpkiBase64(publicKey);
  return {
    publicKey,
    privateKey,
    publicKeyPem,
    privateKeyPem,
    publicKeySpkiBase64,
  };
}

export function exportPublicKeySpkiBase64(key: string | KeyObject): string {
  const pub = parseEd25519PublicKey(key);
  const der = pub.export({ type: 'spki', format: 'der' });
  return Buffer.from(der).toString('base64');
}

export function parseEd25519PublicKey(key: string | KeyObject): KeyObject {
  let keyObj: KeyObject;
  if (typeof key !== 'string') {
    keyObj = key;
  } else {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error('Ed25519 public key is empty');
    }
    if (trimmed.startsWith('-----BEGIN ')) {
      keyObj = createPublicKey({ key: trimmed, format: 'pem' });
    } else {
      const der = decodeStrictBase64(trimmed);
      if (!der) {
        throw new Error('Invalid base64 SPKI public key encoding');
      }
      keyObj = createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
  }
  if (keyObj.type !== 'public' || keyObj.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Expected Ed25519 public key, received ${keyObj.type}/${String(keyObj.asymmetricKeyType)}`);
  }
  return keyObj;
}

export function parseEd25519PrivateKey(key: string | KeyObject): KeyObject {
  let keyObj: KeyObject;
  if (typeof key !== 'string') {
    keyObj = key;
  } else {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error('Ed25519 private key is empty');
    }
    if (trimmed.startsWith('-----BEGIN ')) {
      keyObj = createPrivateKey({ key: trimmed, format: 'pem' });
    } else {
      const der = decodeStrictBase64(trimmed);
      if (!der) {
        throw new Error('Invalid base64 PKCS8 private key encoding');
      }
      keyObj = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    }
  }
  if (keyObj.type !== 'private' || keyObj.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Expected Ed25519 private key, received ${keyObj.type}/${String(keyObj.asymmetricKeyType)}`);
  }
  return keyObj;
}

function verifyEd25519Canonical(publicKey: KeyObject, body: unknown, signatureBase64: string): boolean {
  try {
    const sigBytes = decodeStrictBase64(signatureBase64);
    if (!sigBytes || sigBytes.length !== 64) {
      return false;
    }
    const data = canonicalJsonBytes(body);
    return cryptoVerify(null, data, publicKey, sigBytes);
  } catch {
    return false;
  }
}

function signEd25519Canonical(privateKey: KeyObject, body: unknown): string {
  const data = canonicalJsonBytes(body);
  return cryptoSign(null, data, privateKey).toString('base64');
}

function certificateSigningBody(cert: Pick<DailySigningCertificate, 'keyId' | 'publicKeySpkiBase64' | 'notBefore' | 'notAfter'>) {
  return {
    keyId: cert.keyId,
    publicKeySpkiBase64: cert.publicKeySpkiBase64,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
  };
}

function revocationSigningBody(revocations: Pick<SignedRevocationList, 'issuedAt' | 'revokedKeyIds'>) {
  return {
    issuedAt: revocations.issuedAt,
    revokedKeyIds: revocations.revokedKeyIds,
  };
}

function envelopeSigningBody(
  envelope: Pick<SignedConfigEnvelope, 'formatVersion' | 'sequence' | 'issuedAt' | 'expiresAt' | 'payload'>,
) {
  const body: {
    formatVersion: number;
    sequence: number;
    issuedAt: string;
    expiresAt?: string;
    payload: SignedConfigPayload;
  } = {
    formatVersion: envelope.formatVersion,
    sequence: envelope.sequence,
    issuedAt: envelope.issuedAt,
    payload: envelope.payload,
  };
  if (envelope.expiresAt !== undefined) {
    body.expiresAt = envelope.expiresAt;
  }
  return body;
}

export function signDailyCertificate(params: {
  keyId: string;
  publicKeySpkiBase64: string;
  notBefore: string;
  notAfter: string;
  rootPrivateKey: string | KeyObject;
}): DailySigningCertificate {
  if (!isNonEmptyString(params.keyId)) {
    throw new Error('Certificate keyId must be a non-empty string');
  }
  const notBeforeMs = parseIsoTimestampMs(params.notBefore);
  const notAfterMs = parseIsoTimestampMs(params.notAfter);
  if (notBeforeMs === null || notAfterMs === null || notAfterMs < notBeforeMs) {
    throw new Error('Certificate notBefore/notAfter must be valid ISO timestamps with notBefore <= notAfter');
  }
  // Ensure daily public key is valid SPKI DER Ed25519.
  const dailyPubDer = decodeStrictBase64(params.publicKeySpkiBase64);
  if (!dailyPubDer) {
    throw new Error('Certificate publicKeySpkiBase64 must be valid base64 SPKI DER');
  }
  parseEd25519PublicKey(params.publicKeySpkiBase64);

  const rootPriv = parseEd25519PrivateKey(params.rootPrivateKey);
  const body = certificateSigningBody(params);
  const rootSignature = signEd25519Canonical(rootPriv, body);
  return {
    ...body,
    rootSignature,
  };
}

export function signRevocationList(params: {
  issuedAt: string;
  revokedKeyIds: readonly string[];
  rootPrivateKey: string | KeyObject;
}): SignedRevocationList {
  if (parseIsoTimestampMs(params.issuedAt) === null) {
    throw new Error('Revocation list issuedAt must be a valid ISO timestamp');
  }
  const revokedKeyIds = params.revokedKeyIds.map(id => {
    if (!isNonEmptyString(id)) {
      throw new Error('Revoked key IDs must be non-empty strings');
    }
    return id;
  });
  const rootPriv = parseEd25519PrivateKey(params.rootPrivateKey);
  const body = revocationSigningBody({ issuedAt: params.issuedAt, revokedKeyIds });
  const rootSignature = signEd25519Canonical(rootPriv, body);
  return {
    ...body,
    rootSignature,
  };
}

export function signConfigEnvelope<TPayload extends SignedConfigPayload = SignedConfigPayload>(params: {
  formatVersion?: number;
  sequence: number;
  issuedAt: string;
  expiresAt?: string;
  certificate: DailySigningCertificate;
  revocations?: SignedRevocationList;
  payload: TPayload;
  dailyPrivateKey: string | KeyObject;
}): SignedConfigEnvelope {
  const formatVersion = params.formatVersion ?? SIGNED_CONFIG_FORMAT_VERSION;
  if (!Number.isSafeInteger(params.sequence) || params.sequence < 1) {
    throw new Error('Envelope sequence must be a positive safe integer');
  }
  if (parseIsoTimestampMs(params.issuedAt) === null) {
    throw new Error('Envelope issuedAt must be a valid ISO timestamp');
  }
  if (params.expiresAt !== undefined && parseIsoTimestampMs(params.expiresAt) === null) {
    throw new Error('Envelope expiresAt must be a valid ISO timestamp');
  }
  if (!isPlainRecord(params.payload)) {
    throw new Error('Envelope payload must be a plain object');
  }

  const dailyPriv = parseEd25519PrivateKey(params.dailyPrivateKey);
  const body = envelopeSigningBody({
    formatVersion,
    sequence: params.sequence,
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt,
    payload: params.payload,
  });
  const signature = signEd25519Canonical(dailyPriv, body);

  const envelope: SignedConfigEnvelope = {
    formatVersion,
    sequence: params.sequence,
    issuedAt: params.issuedAt,
    certificate: params.certificate,
    payload: params.payload,
    signature,
  };
  if (params.expiresAt !== undefined) {
    envelope.expiresAt = params.expiresAt;
  }
  if (params.revocations !== undefined) {
    envelope.revocations = params.revocations;
  }
  return envelope;
}

function validateKnownPayloadContainers(payload: Record<string, unknown>): SignedConfigValidationIssue[] {
  const issues: SignedConfigValidationIssue[] = [];

  if (payload.studioUrl !== undefined && typeof payload.studioUrl !== 'string') {
    issues.push({ path: 'studioUrl', message: 'studioUrl must be a string' });
  }
  if (payload.allowedOrigins !== undefined) {
    if (!Array.isArray(payload.allowedOrigins) || payload.allowedOrigins.some(v => typeof v !== 'string')) {
      issues.push({ path: 'allowedOrigins', message: 'allowedOrigins must be an array of strings' });
    }
  }
  if (payload.windowPolicy !== undefined) {
    if (!isPlainRecord(payload.windowPolicy)) {
      issues.push({ path: 'windowPolicy', message: 'windowPolicy must be an object' });
    } else {
      for (const arrayField of ['allowedPopupOrigins', 'allowedAuthOrigins'] as const) {
        const val = payload.windowPolicy[arrayField];
        if (val !== undefined && (!Array.isArray(val) || val.some(v => typeof v !== 'string'))) {
          issues.push({
            path: `windowPolicy.${arrayField}`,
            message: `windowPolicy.${arrayField} must be an array of strings`,
          });
        }
      }
    }
  }

  for (const mapField of [
    'agents',
    'configRules',
    'components',
    'firstPartyCommands',
    'credentials',
    'features',
  ] as const) {
    const val = payload[mapField];
    if (val === undefined) continue;
    if (!isPlainRecord(val)) {
      issues.push({ path: mapField, message: `${mapField} must be an object` });
      continue;
    }
    for (const [entryKey, entryVal] of Object.entries(val)) {
      if (!isPlainRecord(entryVal)) {
        issues.push({ path: `${mapField}.${entryKey}`, message: `${mapField}.${entryKey} must be an object` });
      }
    }
  }

  return issues;
}

/**
 * Verifies a two-tier Ed25519 signed configuration envelope against the embedded
 * root key, daily signing certificate, revocation lists, monotonic sequence,
 * and built-in shell security boundaries.
 */
export function verifySignedConfigEnvelope(
  rawEnvelope: unknown,
  options: VerifySignedConfigOptions = {},
): VerifySignedConfigResult {
  if (!isPlainRecord(rawEnvelope)) {
    return {
      ok: false,
      code: 'INVALID_ENVELOPE',
      message: 'Signed config envelope must be a JSON object',
    };
  }

  // 1. Format version check first so future formats trigger clean fallback.
  const formatVersion = rawEnvelope.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    return {
      ok: false,
      code: 'INVALID_ENVELOPE',
      message: 'Signed config envelope formatVersion must be an integer',
    };
  }
  if (formatVersion !== SIGNED_CONFIG_FORMAT_VERSION) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FORMAT_VERSION',
      message: `Unsupported signed config formatVersion: ${formatVersion} (supported: ${SIGNED_CONFIG_FORMAT_VERSION})`,
    };
  }

  // 2. Parse root Ed25519 public key.
  let rootPublicKey: KeyObject;
  try {
    const rawRootKey = options.rootPublicKey ?? options.rootPublicKeyPem ?? resolveEmbeddedRootPublicKeySpki();
    rootPublicKey = parseEd25519PublicKey(rawRootKey);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_ROOT_KEY',
      message: err instanceof Error ? err.message : 'Invalid root Ed25519 public key',
    };
  }

  // 3. Collect built-in & caller-supplied revoked key IDs, and verify optional signed revocation list.
  const effectiveRevoked = new Set<string>(BUILTIN_REVOKED_KEY_IDS);
  if (options.revokedKeyIds) {
    for (const id of options.revokedKeyIds) {
      if (isNonEmptyString(id)) {
        effectiveRevoked.add(id);
      }
    }
  }

  let hasVerifiedSignedRevocations = false;
  if (rawEnvelope.revocations !== undefined) {
    const rev = rawEnvelope.revocations;
    if (
      !isPlainRecord(rev) ||
      parseIsoTimestampMs(rev.issuedAt) === null ||
      !Array.isArray(rev.revokedKeyIds) ||
      rev.revokedKeyIds.some(id => !isNonEmptyString(id)) ||
      !isNonEmptyString(rev.rootSignature)
    ) {
      return {
        ok: false,
        code: 'INVALID_REVOCATION_LIST',
        message: 'Revocation list is malformed',
      };
    }

    const revocationBody = revocationSigningBody({
      issuedAt: rev.issuedAt as string,
      revokedKeyIds: rev.revokedKeyIds as string[],
    });
    if (!verifyEd25519Canonical(rootPublicKey, revocationBody, rev.rootSignature)) {
      return {
        ok: false,
        code: 'INVALID_REVOCATION_LIST',
        message: 'Revocation list rootSignature verification failed',
      };
    }

    for (const id of rev.revokedKeyIds as string[]) {
      effectiveRevoked.add(id);
    }
    hasVerifiedSignedRevocations = true;
  }

  const verifiedRevokedKeyIds = Array.from(effectiveRevoked).sort();
  const failWithRevocations = (
    code: SignedConfigFailureCode,
    message: string,
    issues?: SignedConfigValidationIssue[],
  ): VerifySignedConfigFailure => {
    const res: VerifySignedConfigFailure = { ok: false, code, message };
    if (issues) res.issues = issues;
    if (hasVerifiedSignedRevocations) res.verifiedRevokedKeyIds = verifiedRevokedKeyIds;
    return res;
  };

  // 4. Validate daily signing certificate shape and root signature.
  const cert = rawEnvelope.certificate;
  if (
    !isPlainRecord(cert) ||
    !isNonEmptyString(cert.keyId) ||
    !isNonEmptyString(cert.publicKeySpkiBase64) ||
    !isNonEmptyString(cert.notBefore) ||
    !isNonEmptyString(cert.notAfter) ||
    !isNonEmptyString(cert.rootSignature)
  ) {
    return failWithRevocations('INVALID_CERTIFICATE', 'Daily signing certificate is missing required fields');
  }

  const notBeforeMs = parseIsoTimestampMs(cert.notBefore);
  const notAfterMs = parseIsoTimestampMs(cert.notAfter);
  if (notBeforeMs === null || notAfterMs === null || notAfterMs < notBeforeMs) {
    return failWithRevocations('INVALID_CERTIFICATE', 'Daily signing certificate has invalid validity timestamps');
  }

  // Certificate publicKeySpkiBase64 must be base64 SPKI DER (not PEM).
  if (cert.publicKeySpkiBase64.trim().startsWith('-----BEGIN ')) {
    return failWithRevocations('INVALID_CERTIFICATE', 'Daily signing certificate publicKeySpkiBase64 must be base64 SPKI DER');
  }
  let dailyPublicKey: KeyObject;
  try {
    dailyPublicKey = parseEd25519PublicKey(cert.publicKeySpkiBase64);
  } catch (err) {
    return failWithRevocations(
      'INVALID_CERTIFICATE',
      err instanceof Error ? err.message : 'Invalid daily signing public key',
    );
  }

  const certBody = certificateSigningBody({
    keyId: cert.keyId,
    publicKeySpkiBase64: cert.publicKeySpkiBase64,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
  });
  if (!verifyEd25519Canonical(rootPublicKey, certBody, cert.rootSignature)) {
    return failWithRevocations(
      'INVALID_CERTIFICATE_SIGNATURE',
      `Daily signing certificate "${cert.keyId}" failed root signature verification`,
    );
  }

  // 5. Reject revoked daily signing keys.
  if (effectiveRevoked.has(cert.keyId)) {
    return failWithRevocations(
      'CERTIFICATE_REVOKED',
      `Daily signing certificate "${cert.keyId}" has been revoked`,
    );
  }

  // 6. Check daily signing certificate validity window.
  const nowMs = resolveNowMs(options.now);
  if (!options.ignoreExpiration) {
    if (nowMs < notBeforeMs) {
      return failWithRevocations(
        'CERTIFICATE_NOT_YET_VALID',
        `Daily signing certificate "${cert.keyId}" is not valid until ${cert.notBefore}`,
      );
    }
    if (nowMs > notAfterMs) {
      return failWithRevocations(
        'CERTIFICATE_EXPIRED',
        `Daily signing certificate "${cert.keyId}" expired at ${cert.notAfter}`,
      );
    }
  }

  // 7. Validate envelope metadata and payload container.
  const sequence = rawEnvelope.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
    return failWithRevocations('INVALID_SEQUENCE', 'Envelope sequence must be a positive safe integer');
  }

  const issuedAt = rawEnvelope.issuedAt;
  if (!isNonEmptyString(issuedAt) || parseIsoTimestampMs(issuedAt) === null) {
    return failWithRevocations('INVALID_ENVELOPE', 'Envelope issuedAt must be a valid ISO timestamp');
  }

  const expiresAt = rawEnvelope.expiresAt;
  let expiresAtMs: number | null = null;
  if (expiresAt !== undefined) {
    if (!isNonEmptyString(expiresAt)) {
      return failWithRevocations('INVALID_ENVELOPE', 'Envelope expiresAt must be a valid ISO timestamp when present');
    }
    expiresAtMs = parseIsoTimestampMs(expiresAt);
    if (expiresAtMs === null) {
      return failWithRevocations('INVALID_ENVELOPE', 'Envelope expiresAt must be a valid ISO timestamp');
    }
  }

  if (!isPlainRecord(rawEnvelope.payload)) {
    return failWithRevocations('INVALID_ENVELOPE', 'Envelope payload must be a JSON object');
  }

  if (!isNonEmptyString(rawEnvelope.signature)) {
    return failWithRevocations('INVALID_ENVELOPE', 'Envelope signature must be a non-empty string');
  }

  // 8. Verify daily signing key signature over canonical envelope body.
  const envBody = envelopeSigningBody({
    formatVersion,
    sequence,
    issuedAt,
    expiresAt: expiresAt as string | undefined,
    payload: rawEnvelope.payload as SignedConfigPayload,
  });
  if (!verifyEd25519Canonical(dailyPublicKey, envBody, rawEnvelope.signature)) {
    return failWithRevocations(
      'INVALID_ENVELOPE_SIGNATURE',
      'Signed config envelope signature verification failed',
    );
  }

  // 9. Check optional envelope expiration timestamp.
  if (!options.ignoreExpiration && expiresAtMs !== null && nowMs > expiresAtMs) {
    return failWithRevocations(
      'ENVELOPE_EXPIRED',
      `Signed config envelope expired at ${expiresAt as string}`,
    );
  }

  // 10. Monotonic sequence anti-rollback check.
  if (options.lastAcceptedSequence !== undefined) {
    const lastSeq = options.lastAcceptedSequence;
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
      return failWithRevocations('INVALID_SEQUENCE', 'lastAcceptedSequence must be a non-negative safe integer');
    }
    const allowEqual = options.allowEqualSequence ?? true;
    if (sequence < lastSeq || (!allowEqual && lastSeq > 0 && sequence <= lastSeq)) {
      return failWithRevocations(
        'SEQUENCE_ROLLBACK',
        `Rejected config sequence ${sequence} (last accepted sequence: ${lastSeq})`,
      );
    }
  }

  // 11. Built-in shell security boundary validation (unknown payload fields are tolerated).
  const containerIssues = validateKnownPayloadContainers(rawEnvelope.payload);
  if (containerIssues.length > 0) {
    return failWithRevocations(
      'PAYLOAD_OUT_OF_BOUNDS',
      `Signed config payload structure failed validation (${containerIssues[0]?.message ?? 'invalid payload'})`,
      containerIssues,
    );
  }

  const boundsIssues = validateSignedConfigPayloadBounds(rawEnvelope.payload as SignedConfigPayload, {
    channel: options.channel ?? 'stable',
    allowLocalDevLoopback: options.allowLocalDevLoopback,
  });
  if (boundsIssues.length > 0) {
    return failWithRevocations(
      'PAYLOAD_OUT_OF_BOUNDS',
      `Signed config payload exceeds built-in shell security bounds: ${boundsIssues[0]?.message ?? 'policy violation'}`,
      boundsIssues,
    );
  }

  const envelope = rawEnvelope as unknown as SignedConfigEnvelope;
  return {
    ok: true,
    envelope,
    payload: envelope.payload,
    sequence,
    certificateKeyId: cert.keyId,
    verifiedRevokedKeyIds,
  };
}
