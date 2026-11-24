import { confirmedSource, observeSourceRead } from "./confirmedTextSources";
import { readVersionedSource, type SourceVersion } from "./readVersionedSource";

type FileBody = { content?: string; version?: string | null; missing?: boolean };
type Pending = { project: string; path: string; changed?: { version?: string } };
const pending = new Set<Pending>();

// Only outstanding reads need a fence. A cold, unopened project file costs no read or buffer.
export function invalidatePendingSourceReads(project: string, paths: readonly string[] | null, versions: Readonly<Record<string, string | null>> | null) {
  for (const read of pending) {
    if (read.project === project && (!paths || paths.includes(read.path))) {
      read.changed = { version: versions?.[read.path] ?? undefined };
    }
  }
}

export async function readCurrentProjectSource(
  project: string, path: string, url = `/api/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(path)}`, base?: SourceVersion,
): Promise<{ response: Response; data?: FileBody }> {
  const read: Pending = { project, path };
  pending.add(read);
  try {
    for (;;) {
      const started = read.changed;
      const cached = confirmedSource(project, path);
      const response = await readVersionedSource(url, cached ?? base);
      let data: FileBody | undefined;
      if (response.ok) {
        try { data = await response.json(); } catch { /* Caller reports invalid source JSON. */ }
      }
      const latest = confirmedSource(project, path);
      const version = data?.version ?? response.headers?.get("etag");
      if (started !== read.changed && (!version || version !== read.changed?.version)) {
        if (latest && latest.version === read.changed?.version) return { response: Response.json(latest), data: latest };
        base = undefined;
        continue;
      }
      if (latest?.version !== cached?.version && latest?.version !== version) {
        base = undefined;
        continue;
      }
      if (data) observeSourceRead(project, path, response, data);
      return { response, data };
    }
  } finally {
    pending.delete(read);
  }
}
