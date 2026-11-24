import { readOrderedFile } from './orderedFileChanges';
import { changedFilePaths, changedFileVersion } from "../components/editor/manualEditsParsing";
import { readProjectFileContentWithVersion } from "./useProjectFileWriter";

type FileRead = ReturnType<typeof readProjectFileContentWithVersion>;
export type RemoteFileRead = (projectId: string, path: string) => FileRead | undefined;

/** One outstanding GET per file. Changes delivered while it runs share a trailing read. */
export function createRemoteFileReader(read = readProjectFileContentWithVersion) {
  const active = new Map<string, { latestHint?: string; request: FileRead; next?: FileRead }>();
  function latest(projectId: string, path: string, version?: string): FileRead {
    const key = projectId + "\0" + path;
    const current = active.get(key);
    if (current) {
      current.latestHint = version;
      const again = () => latest(projectId, path);
      return current.next ??= current.request.then(
        file => current.latestHint && file.version === current.latestHint ? file : again(),
        again,
      );
    }
    const request = read(projectId, path, "?optional=1").finally(() => active.delete(key));
    active.set(key, { request });
    return request;
  }

  // The timeline, the SDK session and an open source panel share one result per delivery.
  return function forChange(projectId: string, payload: unknown): RemoteFileRead {
    const paths = changedFilePaths(payload);
    const results = new Map<string, FileRead>();
    return (project, path) => {
      if (project !== projectId || (paths && !paths.includes(path))) return;
      let result = results.get(path);
      if (!result) {
        // An older GET could still write the confirmed cache. Let its trailing read win in that case.
        const warm = !active.has(project + "\0" + path) && readOrderedFile(project, path, payload);
        result = warm ? Promise.resolve({ ...warm, missing: false }) : latest(project, path, changedFileVersion(payload, path));
        results.set(path, result);
      }
      return result;
    };
  };
}
