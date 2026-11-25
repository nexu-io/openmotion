/**
 * Q1 Frozen Contract — Web Connect Script Loopback Bridge Protocol (K9 <-> S2).
 *
 * Allows cloud Studio in a normal browser to call the exact same four universal
 * bridge methods (`info`, `capabilities`, `invoke`, `subscribe`) against a local
 * Connect Script process running the shared K7 atomic capabilities engine.
 */

import type {
  HostCapabilityDescriptor,
  HostInvokeResult,
  HostRuntimeInfo,
} from './desktop-contract.ts';

export const CONNECT_SCRIPT_PROTOCOL_VERSION = '1.0.0' as const;
export const CONNECT_SCRIPT_DEFAULT_PORT = 43118 as const;
export const CONNECT_SCRIPT_HOST = '127.0.0.1' as const;

export const CONNECT_SCRIPT_ENDPOINTS = {
  HEALTH: '/v1/health',
  INFO: '/v1/info',
  CAPABILITIES: '/v1/capabilities',
  INVOKE: '/v1/invoke',
  EVENTS: '/v1/events',
} as const;

export const CONNECT_SCRIPT_TOKEN_HEADER = 'x-openmotion-connect-token' as const;

export type ConnectScriptHealthResponse = {
  ok: true;
  protocolVersion: string;
  hostKind: 'connect-script';
  requiresToken: true;
};

export type ConnectScriptInvokeRequest = {
  capability: string;
  method: string;
  params?: Record<string, unknown>;
};

export type ConnectScriptInvokeResponse<T = unknown> = HostInvokeResult<T>;
export type ConnectScriptInfoResponse = HostRuntimeInfo;
export type ConnectScriptCapabilitiesResponse = HostCapabilityDescriptor[];

export type ConnectScriptEventMessage = {
  capability: string;
  event: string;
  payload: unknown;
};
