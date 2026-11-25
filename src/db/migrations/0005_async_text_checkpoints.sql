ALTER TABLE project_text_revisions ADD COLUMN checkpoint_due_at timestamptz,
  ADD COLUMN checkpoint_pending_sha char(64),
  DROP CONSTRAINT project_text_revisions_depth_check,
  ADD CONSTRAINT project_text_revisions_depth_check CHECK (depth >= 1),
  DROP CONSTRAINT project_text_revisions_chain_patch_bytes_check,
  ADD CONSTRAINT project_text_revisions_chain_patch_bytes_check CHECK (chain_patch_bytes >= 1);
--> statement-breakpoint
UPDATE project_text_revisions SET checkpoint_due_at = now()
WHERE checkpoint_sha IS NULL AND (depth = 32 OR chain_patch_bytes = 262144);
--> statement-breakpoint
CREATE INDEX idx_text_revisions_checkpoint_due ON project_text_revisions(checkpoint_due_at)
WHERE checkpoint_due_at IS NOT NULL AND checkpoint_sha IS NULL;
--> statement-breakpoint
CREATE INDEX idx_text_revisions_checkpoint_pending ON project_text_revisions(workspace_id, checkpoint_pending_sha)
WHERE checkpoint_pending_sha IS NOT NULL;
