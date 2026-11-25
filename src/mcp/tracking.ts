import { randomUUID } from 'node:crypto';
import { phase1Tools, validateInput } from '../../shared/phase1-tools.ts';
import { publicToolName } from '../../shared/public-names.mjs';
import { toolInputFields } from '../../tracking/tool-fields.ts';
import { identifyHost } from '../../tracking/host.ts';
import type { CloudTrackingHandle } from '../cloud-tracking.ts';
import type { McpToolCallResponse } from './tool-dispatcher.ts';

/** Attribute a read at the transport boundary; never count a copy as a read. */
export async function trackTemplateRead(
  name: string, args: unknown, clientInfo: unknown,
  tracking: Pick<CloudTrackingHandle, 'trackMcpTool'> | undefined,
  invoke: () => Promise<McpToolCallResponse>,
): Promise<McpToolCallResponse> {
  if (!tracking || publicToolName(name) !== 'openmotion_get_template') return invoke();
  let accepted = false;
  try {
    const definition = phase1Tools.find(tool => tool.name === 'openmotion_get_template')!;
    validateInput(definition.inputSchema, args);
    accepted = true;
  } catch { /* The dispatcher owns the validation error response. */ }
  const fields = { tool_name: 'motion_get_template' as const, call_id: randomUUID(), accepted,
    ...toolInputFields('openmotion_get_template', args) };
  const host = identifyHost(clientInfo), started = performance.now();
  function report(event: 'mcp_tool_started' | 'mcp_tool_finished', outcome?: 'success' | 'failure' | 'partial') {
    try {
      if (event === 'mcp_tool_started') tracking!.trackMcpTool(event, fields, host);
      else tracking!.trackMcpTool(event, { ...fields, outcome: outcome ?? 'failure',
        duration_ms: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - started))) }, host);
    } catch { /* A tracking failure must not alter the tool result. */ }
  }
  if (accepted) report('mcp_tool_started');
  let result: McpToolCallResponse;
  try { result = await invoke(); }
  catch (error) { report('mcp_tool_finished', 'failure'); throw error; }
  const status = result.structuredContent?.status;
  report('mcp_tool_finished', !accepted || result.isError || status === 'failed' ? 'failure' : status === 'partial' ? 'partial' : 'success');
  return result;
}
