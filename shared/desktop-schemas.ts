/**
 * Unified Schema-Driven Contract Validation Layer (inspired by T3 Code packages/contracts).
 *
 * Single source of truth using Zod v4 for validating all UniversalHostBridge
 * capability invocations across Electron IPC, Web Connect Script HTTP, and
 * LocalAtomsRuntime dispatch.
 *
 * NOTE: Keep this module outside Studio's static `main.tsx` shell import graph.
 */

import { z } from 'zod';
import {
  DESKTOP_PREFERENCE_KEYS,
  HOST_CAPABILITIES,
  hostErr,
  type HostInvokeFailure,
} from './desktop-contract.ts';
import {
  DESKTOP_TELEMETRY_CATEGORIES,
  DESKTOP_TELEMETRY_OUTCOMES,
} from './desktop-telemetry.ts';

const nonEmptyTrimmedString = z
  .string()
  .trim()
  .min(1, 'must be a non-empty string')
  .max(256, 'must be at most 256 characters');

const safeSingleLineString = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(value => !/[\r\n\0]/.test(value), 'must not contain control characters');

const conflictPolicySchema = z.enum(['abort', 'replace']);

export const ConnectScriptInvokeRequestSchema = z.object({
  capability: nonEmptyTrimmedString,
  method: nonEmptyTrimmedString,
  params: z.record(z.string(), z.unknown()).optional(),
});

export const AtomDetectParamsSchema = z
  .object({
    expectedMcpUrl: safeSingleLineString.optional(),
    serverName: nonEmptyTrimmedString.optional(),
  })
  .strict();

export const AtomExecParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    templateId: nonEmptyTrimmedString,
    args: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    conflictPolicy: conflictPolicySchema.optional(),
  })
  .strict();

export const AtomConfigReadParamsSchema = z
  .object({
    ruleId: nonEmptyTrimmedString,
    serverName: nonEmptyTrimmedString.optional(),
  })
  .strict();

export const AtomConfigWriteParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    ruleId: nonEmptyTrimmedString,
    fieldType: z.enum(['remote_mcp_entry']),
    value: z
      .object({
        serverName: nonEmptyTrimmedString,
        url: safeSingleLineString,
        transport: z.enum(['http', 'streamable-http', 'remote']).optional(),
      })
      .strict(),
    conflictPolicy: conflictPolicySchema.optional(),
  })
  .strict();

export const AtomConfigRestoreParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    backupPath: safeSingleLineString,
  })
  .strict();

export const AtomInstallComponentParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    componentId: nonEmptyTrimmedString,
  })
  .strict();

export const AtomInstallComponentStatusParamsSchema = z
  .object({
    componentId: nonEmptyTrimmedString,
  })
  .strict();

export const AtomCredentialStartParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    credentialId: nonEmptyTrimmedString,
  })
  .strict();

export const AtomCredentialPollParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    credentialId: nonEmptyTrimmedString,
    sessionId: nonEmptyTrimmedString,
  })
  .strict();

export const AtomCredentialStatusParamsSchema = z
  .object({
    credentialId: nonEmptyTrimmedString,
    installationId: nonEmptyTrimmedString.optional(),
  })
  .strict();

export const AtomCredentialInjectParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    credentialId: nonEmptyTrimmedString,
    templateId: nonEmptyTrimmedString,
    args: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  })
  .strict();

export const AtomCredentialRevokeParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    credentialId: nonEmptyTrimmedString,
    accountId: nonEmptyTrimmedString.optional(),
  })
  .strict();

export const AtomCredentialRetryPendingRevokesParamsSchema = z
  .object({
    featureId: nonEmptyTrimmedString,
    credentialId: nonEmptyTrimmedString.optional(),
    accountId: nonEmptyTrimmedString.optional(),
  })
  .strict();

export const TelemetryRecordEventParamsSchema = z
  .object({
    category: z.enum(DESKTOP_TELEMETRY_CATEGORIES),
    outcome: z.enum(DESKTOP_TELEMETRY_OUTCOMES),
    durationMs: z.number().finite().min(0).max(86_400_000).optional(),
    agentId: nonEmptyTrimmedString.optional(),
    connectMode: z.enum(['cli', 'config']).optional(),
    pairMethod: z.enum(['hash', 'manual']).optional(),
    targetVersion: nonEmptyTrimmedString.optional(),
    sequence: z.number().int().min(0).optional(),
    errorCode: nonEmptyTrimmedString.optional(),
  })
  .strict();

export const TelemetrySetEnabledParamsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const WindowSetThemeParamsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']),
  })
  .strict();

export const WindowOpenExternalParamsSchema = z
  .object({
    url: safeSingleLineString,
  })
  .strict();

export const WindowSetTaskProgressParamsSchema = z
  .object({
    taskId: nonEmptyTrimmedString,
    progress: z.union([z.number().finite().min(-1).max(1), z.literal('indeterminate'), z.null()]),
  })
  .strict();

export const WindowAcquireWakeLockParamsSchema = z
  .object({
    taskId: nonEmptyTrimmedString,
    reason: nonEmptyTrimmedString.optional(),
    ttlMs: z.number().int().min(5_000).max(3_600_000).optional(),
  })
  .strict();

export const WindowReleaseWakeLockParamsSchema = z
  .object({
    taskId: nonEmptyTrimmedString,
  })
  .strict();

export const WindowNotifyParamsSchema = z
  .object({
    title: nonEmptyTrimmedString,
    body: z
      .string()
      .trim()
      .max(512, 'must be at most 512 characters')
      .refine(value => !/[\0]/.test(value), 'must not contain null bytes')
      .optional(),
    bounce: z.boolean().optional(),
    silent: z.boolean().optional(),
    whenUnfocusedOnly: z.boolean().optional(),
  })
  .strict();

export const AccountStartLoginParamsSchema = z
  .object({
    switchAccount: z.boolean().optional(),
  })
  .strict();

const desktopLocaleValueSchema = z
  .string()
  .trim()
  .min(2, 'must be a valid locale tag')
  .max(32, 'must be at most 32 characters')
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'must be a valid BCP-47 locale tag');

export const PreferencesSetParamsSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('confirmBeforeQuit'), value: z.boolean() }).strict(),
  z.object({ key: z.literal('openAtLogin'), value: z.boolean() }).strict(),
  z.object({ key: z.literal('autoCheckUpdates'), value: z.boolean() }).strict(),
  z.object({ key: z.literal('hardwareAcceleration'), value: z.boolean() }).strict(),
  z
    .object({
      key: z.literal('locale'),
      value: z.union([desktopLocaleValueSchema, z.null()]),
    })
    .strict(),
]);

export const PreferencesResetParamsSchema = z
  .object({
    key: z.enum(DESKTOP_PREFERENCE_KEYS).optional(),
  })
  .strict();

const EmptyParamsSchema = z.object({}).strict();

const HOST_METHOD_SCHEMA_REGISTRY: Record<string, Record<string, z.ZodType>> = {
  [HOST_CAPABILITIES.ATOM_DETECT]: {
    scan: AtomDetectParamsSchema,
    detect: AtomDetectParamsSchema,
  },
  [HOST_CAPABILITIES.ATOM_EXEC]: {
    run: AtomExecParamsSchema,
    preview: AtomExecParamsSchema,
  },
  [HOST_CAPABILITIES.ATOM_CONFIG]: {
    read: AtomConfigReadParamsSchema,
    write: AtomConfigWriteParamsSchema,
    previewWrite: AtomConfigWriteParamsSchema,
    restoreBackup: AtomConfigRestoreParamsSchema,
  },
  [HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT]: {
    install: AtomInstallComponentParamsSchema,
    preview: AtomInstallComponentParamsSchema,
    status: AtomInstallComponentStatusParamsSchema,
    uninstall: AtomInstallComponentParamsSchema,
  },
  [HOST_CAPABILITIES.ATOM_CREDENTIAL]: {
    start: AtomCredentialStartParamsSchema,
    poll: AtomCredentialPollParamsSchema,
    status: AtomCredentialStatusParamsSchema,
    inject: AtomCredentialInjectParamsSchema,
    revoke: AtomCredentialRevokeParamsSchema,
    retryPendingRevokes: AtomCredentialRetryPendingRevokesParamsSchema,
  },
  [HOST_CAPABILITIES.TELEMETRY]: {
    getSummary: EmptyParamsSchema,
    recordEvent: TelemetryRecordEventParamsSchema,
    setEnabled: TelemetrySetEnabledParamsSchema,
    reset: EmptyParamsSchema,
  },
  [HOST_CAPABILITIES.WINDOW]: {
    setTheme: WindowSetThemeParamsSchema,
    openExternal: WindowOpenExternalParamsSchema,
    setTaskProgress: WindowSetTaskProgressParamsSchema,
    acquireWakeLock: WindowAcquireWakeLockParamsSchema,
    releaseWakeLock: WindowReleaseWakeLockParamsSchema,
    notify: WindowNotifyParamsSchema,
  },
  [HOST_CAPABILITIES.ACCOUNT]: {
    startLogin: AccountStartLoginParamsSchema,
  },
  [HOST_CAPABILITIES.PREFERENCES]: {
    getAll: EmptyParamsSchema,
    set: PreferencesSetParamsSchema,
    reset: PreferencesResetParamsSchema,
    pickDownloadDir: EmptyParamsSchema,
    relaunch: EmptyParamsSchema,
  },
};

export function getHostMethodSchema(capability: string, method: string): z.ZodType | undefined {
  return HOST_METHOD_SCHEMA_REGISTRY[capability]?.[method];
}

export function validateHostMethodParams<T = Record<string, unknown>>(
  capability: string,
  method: string,
  rawParams: unknown,
): { ok: true; data: T } | HostInvokeFailure {
  const schema = getHostMethodSchema(capability, method);
  if (!schema) {
    return { ok: true, data: ((rawParams ?? {}) as T) };
  }
  const normalized = rawParams === undefined ? {} : rawParams;
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const issuePath = firstIssue?.path.length ? `${firstIssue.path.join('.')}: ` : '';
    const detailMessage = firstIssue ? `${issuePath}${firstIssue.message}` : 'Invalid method parameters';
    return hostErr('INVALID_PARAMS', `Invalid parameters for ${capability}.${method}: ${detailMessage}`, {
      capability,
      method,
      issues: parsed.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return { ok: true, data: parsed.data as T };
}
