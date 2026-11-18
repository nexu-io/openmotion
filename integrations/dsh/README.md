# OpenMotion for DSH

An optional local plugin that brings the OpenMotion workspace into DeepSeek Harness (DSH). Browse projects, templates, Brand Kits and Assets, then edit in Studio alongside the native Agent conversation. Hide Agent expands Studio without reloading its iframe; narrow windows show one usable surface at a time.

This source-checkout integration targets DSH **0.2.2-rc.1**. It is separate from the OpenMotion npm application and Agent-plugin ZIPs. Building a tarball does not publish it to npm.

## Prerequisites

- Node 26 (the OpenMotion CI runtime), npm and a working OpenMotion source checkout with this integration.
- Run `npm ci` and `npm run build:studio` at the OpenMotion repository root.
- A model configured in DSH. The plugin neither supplies model access nor copies credentials from another Agent. Media generation additionally needs an OpenMotion media provider.

## Try from source

From the OpenMotion checkout:

```sh
npm ci --prefix integrations/dsh
npm start --prefix integrations/dsh
```

Open the authenticated URL printed by DSH. Its isolated profile, configuration and project data default to `~/.openmotion-dsh/`; existing DSH profiles remain separate. Choose a workspace folder in DSH before using **Create with agent**. The action prepares an unsent draft and preserves an existing draft. Pick a project to open Studio, or use **Studio** in a conversation.

The host plugin uses OpenMotion's maintained `preview.ts` entrypoint to discover or start the local service on each platform, then connects DSH's maintained stdio MCP adapter to the same data directory. Discovery reuses a compatible, healthy service for that directory and leaves unrelated occupied ports alone. Use **Refresh** on the workspace after an Agent creates a project, then select it. New projects do not automatically replace the selected Studio tab. DSH and Studio retain their own theme preferences.

Press Ctrl+C to stop this DSH instance and disconnect its MCP child. The shared OpenMotion editor can remain running and projects are retained. If the launcher crashed, confirm its DSH process has stopped before removing `launch.lock` from the configured integration home.

Optional environment variables:

| Variable | Meaning |
| --- | --- |
| `OPENMOTION_DSH_HOME` | Isolated integration state/profile home. |
| `OPENMOTION_DSH_PORT` | DSH loopback port; defaults to `3080`, refuses an occupied port. |
| `MOTION_DATA_DIR` | Existing OpenMotion data directory to share; otherwise uses the integration home's `data/`. |
| `MOTION_TEMPLATE_SOURCE` | Optional OpenMotion template source override, e.g. `hosted`. Unset uses OpenMotion's normal source-checkout behavior. |

## Download and install the plugin

Users do not need to build the plugin themselves. The maintained public entry is:

<https://releases.open-design.ai/open-motion/integrations/dsh/main/latest.json>

This small JSON records the plugin version, supported DSH version, exact OpenMotion `sourceCommit`, immutable `tarballUrl`, byte length and SHA-256. Download the `.tgz` at `tarballUrl`; no GitHub login is required. For a new installation, use a separate OpenMotion checkout at `sourceCommit`, install its root dependencies and build Studio as described in Prerequisites. Preserve an existing checkout and use the local build below when you want to keep its version. The tarball still requires that built source runtime; it does not contain the full OpenMotion application.

From a prepared checkout, this helper downloads and verifies the published package before writing it to a new file:

```sh
node integrations/dsh/download.ts /absolute/path/to/downloads
```

Use the returned `filename` with the DSH installation command below. It also returns `sourceCommit` and `dshVersion` so the Agent can check the runtime and host before enabling. A checksum, network or version mismatch must be reported rather than silently switching an existing installation. Existing downloads are not overwritten.

**Availability:** the first public download appears after this PR merges to `main` and **DSH integration** succeeds. Before merging, download the `openmotion-dsh` artifact from the PR's successful [DSH integration run](https://github.com/nexu-io/openmotion/actions/workflows/dsh-integration.yml), extract GitHub's outer ZIP, and use the `.tgz` inside. GitHub artifact downloads require sign-in and expire; the public R2 download is the maintained user entry.

### Build locally instead

After the prerequisites, install the optional build dependencies and pack:

```sh
npm ci --prefix integrations/dsh
npm run pack --prefix integrations/dsh
```

This produces `integrations/dsh/dist/openmotion-dsh-0.1.0.tgz`. It can also be copied to another machine with the matching source runtime.

### Install and enable in DSH

With DSH installed, install the downloaded or locally built tarball in the desired profile:

```sh
dsh plugin --profile web add /absolute/path/to/openmotion-dsh-0.1.0.tgz
```

Add this entry to that profile's `cordis.patch.yml`, preserving existing entries:

```yaml
- insert:
    - id: openmotion-workspace
      name: openmotion-dsh
      config:
        root: /absolute/path/to/openmotion
        dataDirectory: /absolute/path/to/your/openmotion-data
```

Replace both paths with your local locations. `root` must be a built source checkout containing this integration; the plugin does not download OpenMotion. `dataDirectory` chooses the shared project/asset store. Optional `node` selects the Node executable for OpenMotion; by default it uses DSH's Node. Optional `templateSource` selects `repository` or `hosted`.

Restart DSH. Enabling this one plugin mounts its workspace UI, starts/reuses OpenMotion, and connects the MCP tools. Remove an existing `mcp-openmotion` entry before enabling it: two adapters cannot reserve the same `openmotion` tool namespace. Model configuration remains in DSH's normal settings/profile. Do not commit generated patches, model credentials, authenticated URLs or user data.

### Distribution maintenance

The path-scoped **DSH integration** workflow checks, packs and retains the tarball for PR testing. On trusted `main` pushes or a manual run on `main`, it additionally uploads a content-addressed tarball to R2, verifies the public bytes, and updates `main/latest.json` last. Old tarball URLs remain valid. A stale run cannot promote over a newer main commit; rerun the workflow on current `main` if main advanced during packaging. R2 credentials are provided only to that final trusted publishing step. This uses the existing release-bucket configuration, independently of npm and application release workflows. No plugin npm publication is performed.

## Verify and recover

```sh
npm run typecheck --prefix integrations/dsh
npm run test --prefix integrations/dsh
node --experimental-strip-types --test tests/dsh-integration.test.ts
```

In DSH, confirm the OpenMotion sidebar entry, project/template browsing, Studio + Agent layout, focus toggle and narrow-window switching. Read-only host diagnostics are available at `/openmotion-dsh/status`; confirm the discovered names include `mcp__openmotion__openmotion_get_project` and `mcp__openmotion__openmotion_list_templates`.

After configuring a model, ask: “Read my current OpenMotion project and list three templates. Do not modify, create or export anything.” Actual tool calls confirm a model connection; they do not establish video creation or export acceptance.

If activation fails, inspect DSH's log for the failing source path, Node executable or MCP startup. Each dashboard list loads independently, reserves placeholder cards while loading and offers its own **Retry** on failure. A failed template request does not hide projects, and a failed project request does not hide templates. Cards omit unknown duration badges. The host only proxies the two read-only listing APIs; editing remains in Studio and existing MCP tools. Standalone Studio retains its navigation. The layout adapter is pinned to DSH's semantic slot attributes; retest before upgrading DSH. Desktop DSH and other DSH versions have not been validated.

## Acknowledgements

Uses DSH's native plugin, slot and MCP-client interfaces. DSH and its dependencies retain their respective licenses. OpenMotion UI tokens, controls, icons and artwork come from the repository's maintained design system.

Bundled Remix Icon artwork retains its upstream terms in `remix-icon-LICENSE.txt` and `remix-icon-NOTICE.txt`, included in the installable plugin alongside OpenMotion's `LICENSE`. In the source checkout, those originals are maintained in `packages/design-system/`.
