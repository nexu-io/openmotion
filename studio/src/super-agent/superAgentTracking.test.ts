// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { validProperties } from '../../../tracking/core.ts';
import { studioEvents } from '../../../tracking/events.ts';

const sent: { event: string; properties: Record<string, unknown> }[] = [];
vi.mock('../motion/tracking', () => ({ trackMotion: vi.fn(async (event: string, properties: Record<string, unknown>) => { sent.push({ event, properties }); return 'queued'; }) }));

const superAgent = await import('./superAgentTracking');
const workflow = await import('../scenario/workflowTracking');
const review = await import('../motion/reviewCommentTracking');
const { ScenarioApiError } = await import('../scenario/scenarioClient');
await (await import('../motion/reporting')).loadReportingTransport();

function expectAdmitted() {
  for (const row of sent) expect(validProperties(studioEvents, row.event, row.properties), `${row.event} ${JSON.stringify(row.properties)}`).toBe(true);
  expect(JSON.stringify(sent)).not.toMatch(/secret prompt|private comment|\/Users\//);
}

beforeEach(() => { sent.length = 0; });

it('reports Super Agent sends and stops with the mode, engine and counts only', () => {
  const chat = '3F1C2A4B-5D6E-4F70-8A9B-0C1D2E3F4A5B';
  superAgent.reportSuperAgentSend('new_chat', 'success', { mode: 'game', chatId: chat, engine: 'codex', model: 'gpt-5.5', permissionMode: 'on-request', attachmentCount: 2, contextTagCount: 1, handoff: true });
  superAgent.reportSuperAgentSend('queue', 'failure', { mode: null, chatId: 'not-a-uuid', engine: 'Custom Engine!', model: '/Users/me/secret prompt', permissionMode: 'auto' });
  superAgent.reportSuperAgentStop('success', { mode: 'design', chatId: chat, engine: 'claude-code', model: 'default', permissionMode: 'auto' });
  expect(sent.map(row => row.properties)).toEqual([
    { page_name: 'creative_studio', studio_id: 'super-agent', scene_id: 'game', chat_id: chat.toLowerCase(), agent_engine: 'codex', model_id: 'gpt-5.5',
      permission_mode: 'on_request', action: 'send', turn_kind: 'new_chat', outcome: 'success', attachment_count: 2, context_tag_count: 1, handoff: true },
    { page_name: 'creative_studio', studio_id: 'super-agent', permission_mode: 'auto', action: 'send', turn_kind: 'queue', outcome: 'failure',
      attachment_count: 0, context_tag_count: 0, handoff: false },
    { page_name: 'creative_studio', studio_id: 'super-agent', scene_id: 'design', chat_id: chat.toLowerCase(), agent_engine: 'claude-code', model_id: 'default',
      permission_mode: 'auto', action: 'stop', outcome: 'success' },
  ]);
  expectAdmitted();
});

it('reports workflow Generate attempts on the shared generation event with origin and error kind', () => {
  workflow.reportWorkflowGenerate('product-launch', 'generate:step-1', { modality: 'video', model: 'fal:kling-4', prompt: 'secret prompt', referencePoolItemIds: ['a', 'b'] }, 'success');
  workflow.reportWorkflowGenerate('product-launch', 'quick-gen:step-2:image', { modality: 'image', model: 'gpt-image-2' }, 'failure', new ScenarioApiError('PROVIDER_UNAVAILABLE', 'x'));
  workflow.reportWorkflowGenerate('product-launch', 'retry:step-1:it-1:123', { modality: 'audio', model: 'custom-1:mine' }, 'failure', new Error('network'));
  expect(sent.map(row => row.properties)).toEqual([
    { page_name: 'creative_studio', studio_id: 'workflows', scene_id: 'product-launch', model_provider: 'fal', model_id: 'kling-4',
      modality: 'video', outcome: 'success', reference_count: 2, new_version: false, generate_origin: 'step' },
    { page_name: 'creative_studio', studio_id: 'workflows', scene_id: 'product-launch', model_id: 'gpt-image-2',
      modality: 'image', outcome: 'failure', reference_count: 0, new_version: false, generate_origin: 'quick', error_kind: 'provider_unavailable' },
    { page_name: 'creative_studio', studio_id: 'workflows', scene_id: 'product-launch',
      modality: 'audio', outcome: 'failure', reference_count: 0, new_version: false, generate_origin: 'retry', error_kind: 'other' },
  ]);
  expectAdmitted();
});

it('reports review comment writes by action and anchor scope, never their text', () => {
  const project = '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  review.reportReviewComment(project, { operation: 'create', requestId: 'r1', expectedRevision: 'rev', text: 'private comment',
    anchor: { scope: 'frame', compositionPath: 'index.html', time: 1.5, annotation: { kind: 'box' } } } as never, 'success');
  review.reportReviewComment(project, { operation: 'update', requestId: 'r2', commentId: 'c1', expectedCommentRevision: 1, status: 'resolved' }, 'success');
  review.reportReviewComment(project, { operation: 'update', requestId: 'r3', commentId: 'c1', expectedCommentRevision: 2, status: 'open' }, 'success');
  review.reportReviewComment(project, { operation: 'update', requestId: 'r4', commentId: 'c1', expectedCommentRevision: 3, text: 'private comment' }, 'failure', new Error('COMMENT_CONFLICT: stale'));
  review.reportReviewComment('/Users/me', { operation: 'delete', requestId: 'r5', commentId: 'c1', expectedCommentRevision: 4 }, 'failure', new Error('COMMENT_NOT_FOUND: gone'));
  review.reportReviewComment(project, { operation: 'list' }, 'success');
  expect(sent.map(row => row.properties)).toEqual([
    { page_name: 'studio', action: 'create', outcome: 'success', project_id: project, comment_scope: 'frame', has_annotation: true },
    { page_name: 'studio', action: 'resolve', outcome: 'success', project_id: project },
    { page_name: 'studio', action: 'reopen', outcome: 'success', project_id: project },
    { page_name: 'studio', action: 'edit', outcome: 'failure', project_id: project, error_kind: 'conflict' },
    { page_name: 'studio', action: 'delete', outcome: 'failure', error_kind: 'not_found' },
  ]);
  expectAdmitted();
});
