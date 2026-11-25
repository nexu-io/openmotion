/**
 * Privacy-safe, zero-PII Edge Health Telemetry Contract.
 *
 * Strictly records bounded operational counters and latency metrics (startup,
 * PKCE auth handoff, auto-updater, signed config refresh, Connect Script pairing,
 * and local Agent connect outcomes). Never captures tokens, emails, user prompts,
 * hostnames, or filesystem paths.
 */

import type { HostPlatform, HostReleaseChannel } from './desktop-contract.ts';

export const DESKTOP_TELEMETRY_CATEGORIES = [
  'app.startup',
  'auth.handoff',
  'updater.check',
  'updater.download',
  'updater.install',
  'signed_config.refresh',
  'connect_script.pair',
  'connect_script.pna_preflight',
  'agent.connect',
] as const;

export type DesktopTelemetryCategory = (typeof DESKTOP_TELEMETRY_CATEGORIES)[number];

export const DESKTOP_TELEMETRY_OUTCOMES = [
  'ok',
  'applied',
  'unchanged',
  'authenticated',
  'cancelled',
  'timeout',
  'fallback',
  'conflict',
  'user_denied',
  'version_too_old',
  'rejected',
  'network_error',
  'error',
] as const;

export type DesktopTelemetryOutcome = (typeof DESKTOP_TELEMETRY_OUTCOMES)[number];

export type DesktopTelemetryRecordInput = {
  category: DesktopTelemetryCategory;
  outcome: DesktopTelemetryOutcome;
  durationMs?: number;
  agentId?: string;
  connectMode?: 'cli' | 'config';
  pairMethod?: 'hash' | 'manual';
  targetVersion?: string;
  sequence?: number;
  errorCode?: string;
};

export type DesktopTelemetryEvent = DesktopTelemetryRecordInput & {
  timestamp: string;
  channel: HostReleaseChannel;
  platform: HostPlatform;
  arch: string;
  shellVersion: string;
};

export type DesktopTelemetryCategoryCounters = {
  total: number;
  outcomes: Partial<Record<DesktopTelemetryOutcome, number>>;
  avgDurationMs?: number;
  maxDurationMs?: number;
};

export type DesktopTelemetrySummary = {
  schemaVersion: 1;
  enabled: boolean;
  channel: HostReleaseChannel;
  platform: HostPlatform;
  arch: string;
  shellVersion: string;
  totalEvents: number;
  retainedEvents: number;
  updatedAt: string;
  categories: Partial<Record<DesktopTelemetryCategory, DesktopTelemetryCategoryCounters>>;
  recentEvents: DesktopTelemetryEvent[];
};
