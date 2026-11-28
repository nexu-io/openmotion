import type { renderFailureReasons } from '../tracking/tool-fields.ts';

export function classifyRenderFailure(output: string): (typeof renderFailureReasons)[number] {
  if (/listen (?:EPERM|EACCES).*?(?:127\.0\.0\.1|::1|localhost)/i.test(output)) return 'local_port_denied';
  if (/Chrome cannot start|Failed to launch (?:the )?browser/i.test(output)) return 'browser_start';
  if (/Error while opening encoder|Unknown encoder|Error initializing output stream/i.test(output)) return 'encoder';
  return 'unclassified';
}
