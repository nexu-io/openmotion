/**
 * Shell-Generated Confirmation Gate (K4 / K7).
 *
 * Security Principle (Design Doc §5.6):
 * - Confirmation prompts (`HostConfirmationRequest`) are ALWAYS built by the
 *   host from built-in shell rules + verified `SignedConfigPayload` + resolved
 *   runtime facts — NEVER from renderer-supplied prose.
 * - Approved `(featureId, featureVersion, definitionHash)` tuples are persisted
 *   in `<dataDir>/approvals.json`.
 * - Any change to `featureVersion` or the canonical hash of the feature's
 *   signed definition (including referenced templates, components, config rules,
 *   or credentials) invalidates prior approval and triggers re-confirmation.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BUILTIN_TEMPLATE_MAP,
  isShellVersionSatisfied,
  type BuiltinThirdPartyTemplate,
} from '../../shared/desktop-builtin-rules.ts';
import {
  hostErr,
  hostOk,
  type ConfirmationFact,
  type ConfirmationFactKind,
  type HostConfirmationRequest,
  type HostInvokeResult,
} from '../../shared/desktop-contract.ts';
import type { SignedConfigPayload, SignedFeatureDefinition } from '../../shared/signed-config.ts';

const APPROVALS_FILE_NAME = 'approvals.json';
const APPROVALS_SCHEMA_VERSION = 1;

const VALID_FACT_KINDS: ReadonlySet<ConfirmationFactKind> = new Set([
  'exec_program',
  'modify_file',
  'connect_url',
  'install_component',
  'store_credential',
]);

export type FeatureApprovalRecord = {
  featureId: string;
  featureVersion: string;
  definitionHash: string;
  approvedAt: string;
};

type PersistedApprovalsFile = {
  schemaVersion: number;
  approvals: FeatureApprovalRecord[];
};

export type ConfirmCallback = (request: HostConfirmationRequest) => Promise<boolean>;

export type FeatureConfirmationGateOptions = {
  dataDir: string;
  confirmCallback: ConfirmCallback;
  shellVersion?: string;
  now?: () => Date;
};

export type FeatureResourceCheck =
  | { kind: 'commandTemplate'; id: string }
  | { kind: 'component'; id: string }
  | { kind: 'configRule'; id: string }
  | { kind: 'credential'; id: string };

function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeJson(item));
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) {
      sorted[key] = canonicalizeJson(entry);
    }
  }
  return sorted;
}

function summarizeBuiltinTemplate(tpl: BuiltinThirdPartyTemplate) {
  return {
    templateId: tpl.templateId,
    program: tpl.program,
    mutating: tpl.mutating,
    argv: [...tpl.argv],
    params: tpl.params,
  };
}

/**
 * Computes a deterministic SHA-256 hash covering the feature definition and all
 * signed config / built-in rule definitions it references. Any material change
 * invalidates existing user approval.
 */
export function computeFeatureDefinitionHash(
  feature: SignedFeatureDefinition,
  signedConfig: SignedConfigPayload,
): string {
  const commandTemplates: Record<string, unknown> = {};
  for (const templateId of [...(feature.commandTemplateIds ?? [])].sort()) {
    const builtin = BUILTIN_TEMPLATE_MAP.get(templateId);
    if (builtin) {
      commandTemplates[templateId] = { source: 'builtin', template: summarizeBuiltinTemplate(builtin) };
      continue;
    }
    const firstParty = signedConfig.firstPartyCommands?.[templateId];
    if (firstParty) {
      commandTemplates[templateId] = { source: 'first-party', template: firstParty };
    }
  }

  const components: Record<string, unknown> = {};
  for (const componentId of [...(feature.componentIds ?? [])].sort()) {
    const manifest = signedConfig.components?.[componentId];
    if (manifest) {
      components[componentId] = manifest;
    }
  }

  const configRules: Record<string, unknown> = {};
  for (const ruleId of [...(feature.configRuleIds ?? [])].sort()) {
    const rule = signedConfig.configRules?.[ruleId];
    if (rule) {
      configRules[ruleId] = rule;
    }
  }

  const credentials: Record<string, unknown> = {};
  for (const credentialId of [...(feature.credentialIds ?? [])].sort()) {
    const cred = signedConfig.credentials?.[credentialId];
    if (cred) {
      credentials[credentialId] = cred;
    }
  }

  const material = canonicalizeJson({
    featureId: feature.featureId,
    version: feature.version,
    title: feature.title,
    summary: feature.summary,
    minShellVersion: feature.minShellVersion,
    commandTemplateIds: [...(feature.commandTemplateIds ?? [])].sort(),
    componentIds: [...(feature.componentIds ?? [])].sort(),
    configRuleIds: [...(feature.configRuleIds ?? [])].sort(),
    credentialIds: [...(feature.credentialIds ?? [])].sort(),
    commandTemplates,
    components,
    configRules,
    credentials,
  });

  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function buildHostConfirmationRequest(
  feature: SignedFeatureDefinition,
  facts: readonly ConfirmationFact[],
): HostConfirmationRequest {
  const normalizedFacts: ConfirmationFact[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (!VALID_FACT_KINDS.has(fact.kind)) continue;
    const label = fact.label.trim();
    const value = fact.value.trim();
    if (!label || !value) continue;
    const dedupeKey = `${fact.kind}\0${label}\0${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalizedFacts.push({ kind: fact.kind, label, value });
  }
  return {
    featureId: feature.featureId,
    featureVersion: feature.version,
    featureTitle: feature.title,
    facts: normalizedFacts,
  };
}

export function assertFeatureAllowsResource(
  featureId: string,
  signedConfig: SignedConfigPayload,
  resource: FeatureResourceCheck,
): HostInvokeResult<SignedFeatureDefinition> {
  if (!featureId || typeof featureId !== 'string') {
    return hostErr('INVALID_PARAMS', 'featureId is required');
  }
  const feature = signedConfig.features?.[featureId];
  if (!feature) {
    return hostErr('POLICY_DENIED', `Unknown featureId in verified signed config: "${featureId}"`, { featureId });
  }

  switch (resource.kind) {
    case 'commandTemplate':
      if (!feature.commandTemplateIds?.includes(resource.id)) {
        return hostErr(
          'POLICY_DENIED',
          `Feature "${featureId}" is not authorized to run template "${resource.id}"`,
          { featureId, templateId: resource.id },
        );
      }
      break;
    case 'component':
      if (!feature.componentIds?.includes(resource.id)) {
        return hostErr(
          'POLICY_DENIED',
          `Feature "${featureId}" is not authorized to manage component "${resource.id}"`,
          { featureId, componentId: resource.id },
        );
      }
      break;
    case 'configRule':
      if (!feature.configRuleIds?.includes(resource.id)) {
        return hostErr(
          'POLICY_DENIED',
          `Feature "${featureId}" is not authorized to modify config rule "${resource.id}"`,
          { featureId, ruleId: resource.id },
        );
      }
      break;
    case 'credential':
      if (!feature.credentialIds?.includes(resource.id)) {
        return hostErr(
          'POLICY_DENIED',
          `Feature "${featureId}" is not authorized to access credential "${resource.id}"`,
          { featureId, credentialId: resource.id },
        );
      }
      break;
  }

  return hostOk(feature);
}

export class FeatureConfirmationGate {
  private readonly approvalsPath: string;
  private readonly confirmCallback: ConfirmCallback;
  private readonly shellVersion?: string;
  private readonly now: () => Date;

  constructor(options: FeatureConfirmationGateOptions) {
    this.approvalsPath = path.join(options.dataDir, APPROVALS_FILE_NAME);
    this.confirmCallback = options.confirmCallback;
    this.shellVersion = options.shellVersion;
    this.now = options.now ?? (() => new Date());
  }

  getApprovalsPath(): string {
    return this.approvalsPath;
  }

  listApprovals(): FeatureApprovalRecord[] {
    return [...this.readApprovals()];
  }

  hasApproval(featureId: string, featureVersion: string, definitionHash: string): boolean {
    return this.readApprovals().some(
      record =>
        record.featureId === featureId &&
        record.featureVersion === featureVersion &&
        record.definitionHash === definitionHash,
    );
  }

  revokeApproval(featureId: string): boolean {
    const existing = this.readApprovals();
    const filtered = existing.filter(record => record.featureId !== featureId);
    if (filtered.length === existing.length) return false;
    this.writeApprovals(filtered);
    return true;
  }

  clearApprovals(): void {
    this.writeApprovals([]);
  }

  assertMinShellVersion(
    signedConfig: SignedConfigPayload,
    feature?: SignedFeatureDefinition,
  ): HostInvokeResult<true> {
    const checks: Array<{ min: string; label: string; featureId?: string }> = [];
    if (typeof signedConfig.minShellVersion === 'string' && signedConfig.minShellVersion.trim()) {
      checks.push({ min: signedConfig.minShellVersion.trim(), label: 'OpenDesign desktop' });
    }
    if (feature && typeof feature.minShellVersion === 'string' && feature.minShellVersion.trim()) {
      checks.push({
        min: feature.minShellVersion.trim(),
        label: `Feature "${feature.title}"`,
        featureId: feature.featureId,
      });
    }

    for (const check of checks) {
      if (!isShellVersionSatisfied(this.shellVersion, check.min)) {
        return hostErr(
          'UNSUPPORTED',
          `${check.label} requires desktop shell v${check.min} or newer${this.shellVersion ? ` (current: v${this.shellVersion})` : ''}`,
          {
            reason: 'SHELL_VERSION_TOO_OLD',
            ...(check.featureId ? { featureId: check.featureId } : {}),
            minShellVersion: check.min,
            requiredShellVersion: check.min,
            ...(this.shellVersion ? { currentShellVersion: this.shellVersion } : {}),
          },
        );
      }
    }

    return hostOk(true);
  }

  async ensureApproved(params: {
    featureId: string;
    signedConfig: SignedConfigPayload;
    facts: readonly ConfirmationFact[];
    forcePrompt?: boolean;
  }): Promise<HostInvokeResult<{ approved: true; prompted: boolean; definitionHash: string }>> {
    const feature = params.signedConfig.features?.[params.featureId];
    if (!feature) {
      return hostErr('POLICY_DENIED', `Unknown featureId in verified signed config: "${params.featureId}"`, {
        featureId: params.featureId,
      });
    }

    const versionCheck = this.assertMinShellVersion(params.signedConfig, feature);
    if (!versionCheck.ok) return versionCheck;

    const definitionHash = computeFeatureDefinitionHash(feature, params.signedConfig);
    if (!params.forcePrompt && this.hasApproval(feature.featureId, feature.version, definitionHash)) {
      return hostOk({ approved: true, prompted: false, definitionHash });
    }

    const request = buildHostConfirmationRequest(feature, params.facts);
    let accepted = false;
    try {
      accepted = Boolean(await this.confirmCallback(request));
    } catch (error) {
      return hostErr(
        'USER_DENIED',
        `Confirmation prompt failed: ${error instanceof Error ? error.message : String(error)}`,
        { featureId: feature.featureId },
      );
    }

    if (!accepted) {
      return hostErr('USER_DENIED', `User denied confirmation for feature "${feature.title}"`, {
        featureId: feature.featureId,
        featureVersion: feature.version,
      });
    }

    const existing = this.readApprovals().filter(record => record.featureId !== feature.featureId);
    existing.push({
      featureId: feature.featureId,
      featureVersion: feature.version,
      definitionHash,
      approvedAt: this.now().toISOString(),
    });
    this.writeApprovals(existing);

    return hostOk({ approved: true, prompted: true, definitionHash });
  }

  private readApprovals(): FeatureApprovalRecord[] {
    if (!existsSync(this.approvalsPath)) {
      return [];
    }
    try {
      const raw = readFileSync(this.approvalsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedApprovalsFile>;
      if (!parsed || !Array.isArray(parsed.approvals)) {
        return [];
      }
      return parsed.approvals.filter(
        (item): item is FeatureApprovalRecord =>
          Boolean(item) &&
          typeof item.featureId === 'string' &&
          typeof item.featureVersion === 'string' &&
          typeof item.definitionHash === 'string' &&
          typeof item.approvedAt === 'string',
      );
    } catch {
      // Fail closed on corrupt approval state: require fresh confirmation.
      return [];
    }
  }

  private writeApprovals(approvals: FeatureApprovalRecord[]): void {
    const dir = path.dirname(this.approvalsPath);
    mkdirSync(dir, { recursive: true });
    const payload: PersistedApprovalsFile = {
      schemaVersion: APPROVALS_SCHEMA_VERSION,
      approvals,
    };
    const tmpPath = `${this.approvalsPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, this.approvalsPath);
  }
}

export function createFeatureConfirmationGate(options: FeatureConfirmationGateOptions): FeatureConfirmationGate {
  return new FeatureConfirmationGate(options);
}
