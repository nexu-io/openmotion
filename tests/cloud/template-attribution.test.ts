import assert from 'node:assert/strict';
import test from 'node:test';
import { phase1Tools, validateInput } from '../../shared/phase1-tools.ts';
import { withTemplateAttribution } from '../../shared/template-attribution.ts';
import { toolInputFields } from '../../tracking/tool-fields.ts';
import { validProperties } from '../../tracking/core.ts';
import { omEvents } from '../../tracking/events.ts';
import { trackTemplateRead } from '../../src/mcp/tracking.ts';
import type { CloudTrackingHandle } from '../../src/cloud-tracking.ts';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const templateId = 'motion-46f34492-8ba1-4ba5-ac6e-4b4a13c80373';
const schema = phase1Tools.find(tool => tool.name === 'openmotion_get_template')!.inputSchema;

test('copied metadata survives tool validation and the event registry for both entry points', async () => {
  for (const templateEntry of ['website', 'editor'] as const) {
    for (const copyAttemptId of [first, second]) {
      const prompt = withTemplateAttribution('My requirements:\n', templateId, copyAttemptId, templateEntry);
      const args = JSON.parse(prompt.split('\n')[1]!);
      validateInput(schema, args);
      const rows: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const tracking: Pick<CloudTrackingHandle, 'trackMcpTool'> = {
        trackMcpTool(event, fields) {
          assert.equal(validProperties(omEvents, event, fields), true, JSON.stringify(fields));
          rows.push({ event, fields });
        },
      };
      const result = { content: [], structuredContent: { id: templateId } };
      assert.equal(await trackTemplateRead('openmotion_get_template', args, { name: 'codex' }, tracking, async () => result), result);
      assert.deepEqual(rows.map(row => row.event), ['mcp_tool_started', 'mcp_tool_finished']);
      for (const { fields } of rows) {
        assert.equal(fields.template_id, templateId);
        assert.equal(fields.copy_attempt_id, copyAttemptId);
        assert.equal(fields.template_entry, templateEntry);
      }
      assert.equal(rows[0]!.fields.call_id, rows[1]!.fields.call_id);
      assert.equal(rows[1]!.fields.copy_attempt_id, copyAttemptId);
      assert.equal(rows[1]!.fields.template_id, templateId);
      assert.equal(rows[1]!.fields.outcome, 'success');
    }
  }
});

test('legacy reads stay unattributed and aliases map the same template ID', async () => {
  validateInput(schema, { templateId });
  const rows: Array<Record<string, unknown>> = [];
  await trackTemplateRead('motion_get_template', { templateId }, null, {
    trackMcpTool(_event, fields) { rows.push(fields); },
  }, async () => ({ content: [] }));
  assert.equal(rows[1]!.template_id, templateId);
  assert.equal('copy_attempt_id' in rows[1]!, false);
  assert.equal('template_entry' in rows[1]!, false);
});

test('invalid copy metadata is rejected, and failed reads or telemetry cannot become success', async () => {
  for (const args of [{ templateId, copyAttemptId: 'invalid' }, { templateId, templateEntry: 'last_install' }, { templateId, extra: true }]) {
    assert.throws(() => validateInput(schema, args));
  }
  const rows: Array<Record<string, unknown>> = [];
  const failed = { content: [], isError: true };
  await trackTemplateRead('openmotion_get_template', { templateId, copyAttemptId: 'bad' }, null, {
    trackMcpTool(_event, fields) { rows.push(fields); },
  }, async () => failed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.accepted, false);
  assert.equal(rows[0]!.outcome, 'failure');
  const result = { content: [] };
  assert.equal(await trackTemplateRead('openmotion_get_template', { templateId }, null, {
    trackMcpTool() { throw new Error('offline'); },
  }, async () => result), result);
  await assert.rejects(trackTemplateRead('openmotion_get_template', { templateId }, null, {
    trackMcpTool(_event, fields) { rows.push(fields); },
  }, async () => { throw new Error('read failed'); }), /read failed/);
  assert.equal(rows.at(-1)!.outcome, 'failure');
  assert.deepEqual(toolInputFields('openmotion_get_project', { templateId, copyAttemptId: first }), {});
});

test('cloud read attribution reaches the PostHog transport and honors environment opt-out', { timeout: 8000 }, async () => {
  const { createServer } = await import('node:http');
  const { createCloudTracking } = await import('../../src/cloud-tracking.ts');
  let received!: (body: any) => void;
  const batch = new Promise<any>(resolve => { received = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200); response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const env = {
    OPENMOTION_TRACKING_ENABLED: '1', OPENMOTION_POSTHOG_TOKEN: 'phc_testToken123',
    OPENMOTION_POSTHOG_HOST: `http://127.0.0.1:${address.port}`,
    OPENMOTION_TRACKING_ENV: 'test', OPENMOTION_TRACKING_TEST_RUN_ID: first,
    DO_NOT_TRACK: '0',
  };
  try {
    const tracking = createCloudTracking('test-attribution', env);
    await trackTemplateRead('openmotion_get_template', { templateId, copyAttemptId: first, templateEntry: 'website' },
      { name: 'codex', version: '1.0.0' }, tracking, async () => ({ content: [] }));
    const payload = await batch;
    assert.equal(payload.batch.length, 2);
    for (const event of payload.batch) {
      assert.equal(event.properties.template_id, templateId);
      assert.equal(event.properties.copy_attempt_id, first);
      assert.equal(event.properties.template_entry, 'website');
      assert.equal(event.properties.host_agent, 'codex');
    }
    env.DO_NOT_TRACK = '1';
    assert.equal(tracking.isEnabled(), false);
    assert.equal(await trackTemplateRead('openmotion_get_template', { templateId }, null, tracking, async () => ({ content: [] })).then(() => true), true);
  } finally {
    env.DO_NOT_TRACK = '1';
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
