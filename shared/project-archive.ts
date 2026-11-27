/** Portable source packages, separate from rendered-video exports. */
export const PROJECT_ARCHIVE_LIMITS = { bytes: 500_000_000, files: 5000, projects: 100 } as const;
export const PROJECT_ARCHIVE_VALIDATION_UNAVAILABLE = 'PROJECT_ARCHIVE_VALIDATION_UNAVAILABLE';
export type ProjectArchiveInput = {
  action: 'export' | 'import'; requestId: string; projectIds?: string[]; all?: boolean;
  expectedRevisions?: Record<string, string>; sourcePath?: string;
};
const archiveName = 'openmotion_project_archive';
const archiveTitle = 'OpenMotion · Project Archive';
const archiveExportProperties = {
  requestId: { type: 'string', pattern: '^[\\w-]{1,100}$' },
  projectIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', pattern: '^(project|[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12})$' } },
  all: { type: 'boolean' }, expectedRevisions: { type: 'object', additionalProperties: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
};
const archiveRequiredProperties = ['action', 'requestId'];

export const cloudProjectArchiveDownloadInstructions = 'To download, open downloadUrl in a browser signed in to the same OpenMotion workspace, or GET it with an OAuth access token or workspace PAT in the Authorization: Bearer header (projects:read). Follow the short-lived storage redirect and verify the ZIP bytes against sha256.';

export function cloudProjectArchiveImportInstructions(publicOrigin: string) {
  const url = new URL('/motion-api/project-archives/import', publicOrigin).href;
  return `To import a ZIP as independent copies, upload it in Studio or POST ${url}?requestId=<stable-id> with the ZIP bytes and Content-Type: application/zip. Use an OAuth access token or workspace PAT in the Authorization: Bearer header with projects:write and an editor or higher role in the target workspace. Studio uses its signed-in browser session.`;
}

export function cloudProjectArchiveTool(publicOrigin: string) {
  return {
    name: archiveName,
    title: archiveTitle,
    description: `Export editable projects as a ZIP with current source, assets, fonts and Studio editing metadata. List projects with openmotion_get_project, then pass projectIds or all=true and a stable requestId. Optionally pin expectedRevisions. The export call requires a token with projects:write and at least editor access in the workspace; a connection that only holds projects:read must be re-authorized with a wider scope before it can export. Downloading the finished ZIP still needs only projects:read. The result includes an absolute downloadUrl, byte count and SHA-256. ${cloudProjectArchiveDownloadInstructions} ${cloudProjectArchiveImportInstructions(publicOrigin)} Limits: 500 MB archive and expanded content, 5000 files, 100 projects. Remote URLs remain external dependencies.`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { action: { enum: ['export'] }, ...archiveExportProperties },
      required: archiveRequiredProperties,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

export const projectArchiveTool = {
  name: archiveName, title: archiveTitle,
  description: 'Share editable projects offline as ZIP packages. List projects first with openmotion_get_project. Export explicit projectIds or all=true; optionally pin expectedRevisions. Validates the finished ZIP with the same rules as import before returning an immutable local ZIP path and download URL with current sources, local assets, fonts and Studio editing metadata. Excludes credentials, conversations, history, caches and renders. Import an absolute local ZIP sourcePath, either an OpenMotion package or a HyperFrames composition folder with index.html; hyperframes.json, meta.json or project.json markers are supported and optional for index-only compositions. Validate paths, sizes, checksums and native composition structure before adding independent projects; never overwrite or automatically open them. Stable requestId deduplicates retries. Limits: 500 MB archive and expanded content, 5000 files, 100 projects. Remote URLs remain external dependencies; importing does not fetch them or run package scripts.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { enum: ['export', 'import'] }, ...archiveExportProperties,
    sourcePath: { type: 'string', minLength: 1, maxLength: 4096 },
  }, required: archiveRequiredProperties },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
