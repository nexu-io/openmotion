import { readCurrentProjectSource } from "../utils/readCurrentProjectSource";
import { confirmedSource, supportsOrderedTextEdits } from "../utils/confirmedTextSources";
import { runOrderedProjectBarrier } from "../utils/orderedProjectEdits";
import { tryStudioTextEdit, tryStudioCommandPatches, resolveEditSource, saveOrderedStudioFile } from "../utils/studioTextEdits";
import type { ProjectEditCommand } from "../../../packages/edit-core/commands";
import type { StudioWriteHistory } from "../utils/studioFileHistory";
import { acceptFileEditReceipt, type RebasedFileEdit } from "../utils/rebasedFileEdit";
import { useCallback, useMemo } from "react";
import {
  createStudioSaveHttpError,
  retryStudioSave,
  StudioFileConflictError,
  StudioSaveNetworkError,
} from "../utils/studioSaveDiagnostics";
import { studioExpectedFileVersion, studioWriteHeaders } from "../utils/studioFileVersion";
import { studioApiFetch } from "../utils/studioApiFetch";
import { hasIndexSharedRenderContextChanged } from "../../../shared/preview-impact";
import { trackStudioProjectSave } from "../utils/studioSaveState";
import { updateCachedCompositionRevisions } from "../player/lib/clientCompositionCapture";

export interface UseProjectFileWriterOptions {
  projectId: string | null;
  onSavedContent?: (projectId: string, path: string, content: string, submitted?: string) => void;
}

export async function readProjectFileContentWithVersion(projectId: string | null, path: string, query: string) {
  if (!projectId) throw new Error("No active project");
  const { response, data } = await readCurrentProjectSource(projectId, path,
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(path)}${query}`);
  if (!response.ok) throw new Error(`Failed to read ${path}`);
  if (!data) throw new Error(`Invalid source response for ${path}`);
  return { content: data.content, version: data.version ?? response.headers.get("etag"), missing: data.missing };
}

// The etag-guarded project-file read/write pair every Studio save path
// shares. A host mounting hand editing outside Studio needs only this, not
// the full file manager (file tree, editor tabs, uploads, font assets).
export function useProjectFileWriter({ projectId, onSavedContent }: UseProjectFileWriterOptions) {
  const fileVersionScope = useMemo(
    () => ({ projectId, versions: new Map<string, string | null>() }),
    [projectId],
  );
  const fileVersions = fileVersionScope.versions;

  const observeProjectFileVersion = useCallback(
    (path: string, version: string | null) => {
      fileVersions.set(path, version);
    },
    [fileVersions],
  );

  const readProjectFile = useCallback(
    async (path: string): Promise<string> => {
      const { content, version } = await readProjectFileContentWithVersion(projectId, path, "");
      if (typeof content !== "string") throw new Error(`Missing file contents for ${path}`);
      fileVersions.set(path, version);
      return content;
    },
    [fileVersions, projectId],
  );

  const readOptionalProjectFile = useCallback(
    async (path: string, observe?: (base: { content: string; version: string | null }) => void): Promise<string> => {
      const { content, version, missing } = await readProjectFileContentWithVersion(projectId, path, "?optional=1");
      if (missing === true) observe?.({ content: "", version: null });
      else if (typeof content === "string" && version) observe?.({ content, version });
      fileVersions.set(path, version);
      return typeof content === "string" ? content : "";
    },
    [fileVersions, projectId],
  );

  const writeProjectFile = useMemo(() => {
    function write(path: string, content: string, expectedContent?: string): Promise<void>;
    function write(path: string, content: string, expectedContent: string | undefined, command: ProjectEditCommand | undefined, history?: StudioWriteHistory): Promise<void | RebasedFileEdit>;
    async function write(path: string, content: string, expectedContent?: string, command?: ProjectEditCommand, history?: StudioWriteHistory): Promise<void | RebasedFileEdit> {
      if (!projectId) throw new Error("No active project");
      // Reserve the gesture's place before any asynchronous read. Its predecessor
      // may still exist only in this browser's ordered edits.
      if (supportsOrderedTextEdits(projectId)) {
        const cached = confirmedSource(projectId, path);
        const seen = fileVersions.get(path);
        const version = cached && cached.content === expectedContent ? cached.version : seen;
        const before = expectedContent ?? cached?.content;
        const result = command
          ? await tryStudioCommandPatches(projectId, [{ ...command, compositionPath: path }], version ? { [path]: version } : {},
              history, () => content, () => expectedContent)
          : await saveOrderedStudioFile(projectId, path, content, expectedContent, version, history);
        if (!result) throw new Error('Could not prepare the edit for ' + path);
        const saved = result.versions[path];
        const latest = confirmedSource(projectId, path);
        if (latest && saved !== latest.version) return;
        if (saved) fileVersions.set(path, saved);
        updateCachedCompositionRevisions(projectId, result.versions, before !== undefined && path === 'index.html' &&
          hasIndexSharedRenderContextChanged(before, content) ? {indexHeadChanged: true} : undefined);
        if ('divergent' in result && Array.isArray(result.divergent) && result.divergent.length) return result.divergent[0];
        if (latest && latest.content !== content) onSavedContent?.(projectId, path, latest.content, content);
        else onSavedContent?.(projectId, path, content);
        return;
      }
      const source = expectedContent !== undefined && fileVersions.get(path) !== null
        ? await resolveEditSource(projectId, path, current => current.content === expectedContent, content)
        : confirmedSource(projectId, path);
      const trustedBase = source && (expectedContent === undefined ? fileVersions.get(path) === source.version : expectedContent === source.content);
      const before = trustedBase ? source.content : undefined;
      if (before !== undefined) {
        const saved = command && source
          ? await tryStudioCommandPatches(projectId, [{ ...command, compositionPath: path }], { [path]: source.version }, history, () => content)
          : await tryStudioTextEdit(projectId, [{ path, before, after: content }], history);
        if (saved) {
          fileVersions.set(path, saved.versions[path]);
          const indexHeadChanged =
            path === "index.html" && hasIndexSharedRenderContextChanged(before, content);
          updateCachedCompositionRevisions(
            projectId,
            saved.versions,
            indexHeadChanged ? { indexHeadChanged: true } : undefined,
          );
          if (saved.divergent.length) return saved.divergent[0];
          const accepted = confirmedSource(projectId, path)?.content ?? content;
          if (accepted === content) onSavedContent?.(projectId, path, content);
          else onSavedContent?.(projectId, path, accepted, content);
          return;
        }
      }
      return trackStudioProjectSave(projectId, path, () => runOrderedProjectBarrier(projectId, async () => {
        const writeProjectId = projectId;
        let expectedVersion = source && source.content === expectedContent ? source.version : await studioExpectedFileVersion(fileVersions, path, expectedContent);
        if (expectedVersion === undefined) {
          const preflight = await studioApiFetch(
            `/api/projects/${encodeURIComponent(writeProjectId)}/files/${encodeURIComponent(path)}`,
          );
          if (preflight.ok) {
            const data = (await preflight.json()) as { content?: string; version?: string };
            throw new StudioFileConflictError({
              filePath: path,
              currentVersion: data.version ?? preflight.headers.get("etag"),
              currentContent: data.content ?? null,
              attemptedContent: content,
            });
          } else if (preflight.status === 404) {
            expectedVersion = null;
          } else {
            throw await createStudioSaveHttpError(preflight, `Failed to read ${path} before save`);
          }
        }
        const requestId = command ? crypto.randomUUID() : undefined;
        // fallow-ignore-next-line complexity
        const divergent = await retryStudioSave(async () => {
          // Each request gets its own receipt identity. If a committed request loses its response,
          // the retry can produce a second filesystem receipt that must be suppressed independently.
          let response: Response;
          try {
            response = await studioApiFetch(
              `/api/projects/${encodeURIComponent(writeProjectId)}/${command ? "edits" : "files"}/${encodeURIComponent(path)}`,
              {
                method: command ? "POST" : "PUT",
                headers: {
                  "Content-Type": command ? "application/json" : "text/plain",
                  ...(requestId && { "Idempotency-Key": requestId }),
                  ...studioWriteHeaders(history),
                  ...(expectedVersion ? { "If-Match": expectedVersion } : { "If-None-Match": "*" }),
                },
                body: command ? JSON.stringify(command) : content,
              },
            );
          } catch (error) {
            throw new StudioSaveNetworkError(`Failed to save ${path}: network error`, {
              cause: error,
            });
          }
          if (response.status === 409) {
            const conflict = (await response.json().catch(() => null)) as {
              currentVersion?: string | null;
              currentContent?: string | null;
            } | null;
            const currentVersion = conflict?.currentVersion ?? null;
            if (currentVersion && conflict?.currentContent === content) {
              fileVersions.set(path, currentVersion);
              const indexHeadChanged =
                path === "index.html" &&
                source != null &&
                hasIndexSharedRenderContextChanged(source.content, content);
              updateCachedCompositionRevisions(
                writeProjectId,
                { [path]: currentVersion },
                indexHeadChanged ? { indexHeadChanged: true } : undefined,
              );
              return;
            }
            throw new StudioFileConflictError({
              filePath: path,
              currentVersion,
              currentContent: conflict?.currentContent ?? null,
              attemptedContent: content,
            });
          }
          if (!response.ok) throw await createStudioSaveHttpError(response, `Failed to save ${path}`);
          const result = (await response.json()) as { version?: string; rebased?: boolean; changedPaths?: string[] };
          const version = result.version ?? response.headers.get("etag");
          if (!version)
            throw new Error(`Save response for ${path} did not include a content version`);
          const rebased = await acceptFileEditReceipt(writeProjectId, path, expectedVersion, content, version, result);
          if (rebased) {
            fileVersions.delete(path);
            return rebased;
          }
          fileVersions.set(path, version);
          const indexHeadChanged =
            path === "index.html" &&
            source != null &&
            hasIndexSharedRenderContextChanged(source.content, content);
          updateCachedCompositionRevisions(
            writeProjectId,
            { [path]: version },
            indexHeadChanged ? { indexHeadChanged: true } : undefined,
          );
        });
        if (divergent) return divergent;
        onSavedContent?.(writeProjectId, path, content);
      }));
    }
    return write;
  }, [fileVersions, onSavedContent, projectId]);

  return useMemo(
    () => ({
      fileVersions,
      readProjectFile,
      writeProjectFile,
      readOptionalProjectFile,
      observeProjectFileVersion,
    }),
    [
      fileVersions,
      readProjectFile,
      writeProjectFile,
      readOptionalProjectFile,
      observeProjectFileVersion,
    ],
  );
}
