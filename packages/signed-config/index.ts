/**
 * Two-Tier Signed Configuration Package (Design Doc unit K8).
 */

export { canonicalJson, canonicalJsonBytes } from './canonical.ts';
export {
  BUILTIN_REVOKED_KEY_IDS,
  createBundledDefaultConfigPayload,
  EMBEDDED_ROOT_PUBLIC_KEY_SPKI_BASE64,
  isEmbeddedRootPublicKeyPlaceholder,
  resolveEmbeddedRootPublicKeySpki,
} from './default-config.ts';
export {
  exportPublicKeySpkiBase64,
  generateEd25519KeyPair,
  parseEd25519PrivateKey,
  parseEd25519PublicKey,
  signConfigEnvelope,
  signDailyCertificate,
  signRevocationList,
  verifySignedConfigEnvelope,
  type Ed25519KeyPair,
  type SignedConfigFailureCode,
  type VerifySignedConfigFailure,
  type VerifySignedConfigOptions,
  type VerifySignedConfigResult,
  type VerifySignedConfigSuccess,
} from './verifier.ts';
export {
  SignedConfigManager,
  type ActiveConfigSource,
  type SignedConfigApplyFailure,
  type SignedConfigApplyResult,
  type SignedConfigApplySuccess,
  type SignedConfigFetchFn,
  type SignedConfigFetchResponse,
  type SignedConfigLastError,
  type SignedConfigManagerErrorCode,
  type SignedConfigManagerOptions,
  type SignedConfigStatus,
} from './store.ts';
