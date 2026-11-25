import { expect, it, vi } from "vitest";
import { confirmedSource, rememberSource } from "./confirmedTextSources";
import { invalidatePendingSourceReads, readCurrentProjectSource } from "./readCurrentProjectSource";
import { readVersionedSource } from "./readVersionedSource";

vi.mock("./readVersionedSource", () => ({ readVersionedSource: vi.fn() }));

const file = (version: string) => Response.json({ version, content: version }, { headers: { "X-OpenMotion-Text-Edits": "1" } });

it.each(["cached", "cold", "reconnected"])("a delayed %s read cannot publish a superseded version", async project => {
  const path = "clip.html";
  let finish!: (response: Response) => void;
  const fetch = vi.mocked(readVersionedSource).mockReset()
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(file("v2"));
  const read = readCurrentProjectSource(project, path);
  invalidatePendingSourceReads(project, project === "reconnected" ? null : [path], { [path]: "v2" });
  if (project === "cached") rememberSource(project, path, { content: "v2", version: "v2" });
  finish(file("v1"));
  expect((await read).data?.version).toBe("v2");
  expect(confirmedSource(project, path)?.version).toBe("v2");
  expect(fetch).toHaveBeenCalledTimes(project === "cached" ? 1 : 2);
});
