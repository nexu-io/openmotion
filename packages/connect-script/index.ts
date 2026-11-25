/**
 * K9 — Web Connect Script Package Entrypoint.
 */

export {
  CONNECT_SCRIPT_DEFAULT_HEARTBEAT_MS,
  CONNECT_SCRIPT_MAX_BODY_BYTES,
  buildStudioPairingUrl,
  createConnectScriptServer,
  generateSessionToken,
  isOriginAllowed,
  startConnectScriptServer,
  type ConnectEventSubscription,
  type ConnectScriptServerHandle,
  type ConnectScriptServerOptions,
} from './server.ts';

export {
  CONFIRMATION_FACT_KIND_LABELS,
  confirmInTerminal,
  createTerminalConfirm,
  formatConfirmationRequest,
  type ConfirmFn,
  type TerminalConfirmOptions,
} from './terminal-confirm.ts';

export {
  CONNECT_FEATURE_ID,
  CONNECT_FEATURE_VERSION,
  CONNECT_SCRIPT_VERSION,
  createStubConnectBridge,
  formatConnectCliHelp,
  parseConnectCliArgs,
  runConnectCli,
  runConnectFlow,
  runServeFlow,
  type ConnectAgentOutcome,
  type ConnectAgentTarget,
  type ConnectBridgeFactory,
  type ConnectBridgeFactoryOptions,
  type ConnectCliArgs,
  type ConnectCliParseResult,
  type ConnectCliRuntime,
  type ConnectFlowResult,
} from './cli.ts';
