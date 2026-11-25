// The editor's review comments report one result per write (create, edit, resolve, reopen, delete) after the workspace answered.
// Comment text, element metadata, annotations and times never leave the browser; only the action, the anchor scope and fixed categories do.
import type { ReviewCommentsInput } from '../../../shared/review-comments';
import { send, type Fields } from './reporting';

type Result = Fields<'review_comment_result'>;
type Write = Omit<ReviewCommentsInput, 'action' | 'projectId'>;
const projectId = /^(project|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function reviewCommentAction(input: Write): Result['action'] | null {
  if (input.operation === 'create') return 'create';
  if (input.operation === 'delete') return 'delete';
  if (input.operation !== 'update') return null;
  if (input.status === 'resolved') return 'resolve';
  if (input.status === 'open') return 'reopen';
  return 'edit';
}

function errorKind(error: unknown): NonNullable<Result['error_kind']> {
  const message = error instanceof Error ? error.message : '';
  if (/^COMMENT_CONFLICT:/.test(message) || /^REQUEST_ID_CONFLICT:/.test(message)) return 'conflict';
  if (/^COMMENT_NOT_FOUND:/.test(message)) return 'not_found';
  return 'other';
}

export function reportReviewComment(project: string, input: Write, outcome: Result['outcome'], error?: unknown) {
  const action = reviewCommentAction(input);
  if (!action) return;
  send('review_comment_result', {
    page_name: 'studio', action, outcome,
    ...(projectId.test(project) ? { project_id: project } : {}),
    ...(input.operation === 'create' && input.anchor ? { comment_scope: input.anchor.scope, has_annotation: input.anchor.annotation !== undefined } : {}),
    ...(outcome === 'failure' ? { error_kind: errorKind(error) } : {}),
  });
}
