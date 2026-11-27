# Connect OpenMotion (Cloud MCP)

OpenMotion runs as a hosted **Streamable HTTP MCP** service with **OAuth 2.1** authentication. Do **not** install an npm package, clone this repository, or start a local Studio, Docker container, Chromium, or FFmpeg process.

- **MCP Endpoint (Streamable HTTP)**: `https://motion.open-design.ai/mcp`
- **Authentication**: OAuth 2.1 (auto-discovered via `https://motion.open-design.ai/.well-known/oauth-protected-resource/mcp`; Personal Access Token `om_pat_*` fallback only for non-OAuth clients)
- **Cloud Template Library**: `https://motion.open-design.ai/?templates=1`

> **Environment override**: Always use the origin embedded in the guide you fetched (`<ORIGIN>/install.md`). If the user explicitly asks to connect to a staging, test, or self-hosted origin, substitute that exact origin for `https://motion.open-design.ai` everywhere below. Never guess a host URL or silently switch environments.

## Agent rules

1. **Derive `LANG` first** from the user's latest message (supported: `zh`, `en`, `ja`, `ko`, `fr`, `es`, `pt`; normalize `zh-CN` → `zh`, default `en`).
2. **Detect Mode A (pure setup) vs Mode B (task-driven handoff)**:
   - **Mode A (pure setup)**: the user only asked to connect or install OpenMotion (no specific `projectId`, `templateId`, `skillId`, reference video, or creative brief). Finish with [Installation-success reply](#installation-success-reply).
   - **Mode B (task-driven handoff)**: the user's message already carries a specific `projectId`, `templateId`, `skillId`, reference video, or creative brief. After connecting and authorizing against the exact target `<ORIGIN>/mcp`, **skip `/api/onboarding/prepare` and the three onboarding template cards** and resume the user's task directly.
3. **Verify transport and origin before reusing**: do **not** skip Steps 1–2 just because `openmotion_get_project` is visible in this session—a legacy local `stdio` OpenMotion MCP server or local Codex plugin exposes the same tool names. Confirm the active `openmotion` entry uses Streamable HTTP (`streamable_http` / `http`) pointing to the exact target URL `https://motion.open-design.ai/mcp` before skipping Steps 1–2. If it uses local `stdio`, comes from a legacy local `openmotion` plugin, or points to a different origin, migrate/replace it in Step 1 first.
4. **Never install a local runtime**: do not run `git clone`, `npm install`, `npx @openmotion/app`, `docker compose`, or local stdio `mcp.ts`.
5. **Configure only the current host**: preserve local project files, exported videos, unrelated MCP servers, Skills, and settings. Never mention setup steps for unrelated clients in user-facing replies.
6. **Never narrate internal onboarding mechanics**: never tell the user you are running "onboarding / 引导 / 中文模板引导", opening the template library, fetching three templates, or using a visualization skill to build preview cards—neither while waiting for authorization nor in progress updates before the final reply. Execute those steps silently and deliver only the final welcome and cards cleanly.
7. **Keep this guide internal to the Agent.** Never show `/install.md` in user-facing replies or handoff messages. After authorization succeeds, tell the user how to start creating. If the user needs a setup help link, share https://motion.open-design.ai/mcp-setup.

## Step 1: Add the Cloud MCP server

### Before adding: remove legacy local `stdio` OpenMotion MCP or plugin (if present)

If this machine previously used local OpenMotion, an old local `stdio` MCP entry or local plugin can conflict with or shadow the Cloud MCP endpoint. Inspect the current host first and remove **only** the legacy local MCP/plugin registration (**never** delete local project directories, exported videos, standalone Skills, or unrelated MCP servers/plugins):

- **Codex**:
  1. Check `codex mcp list --json` for an `openmotion` entry (or legacy `motion` entry) whose `transport.type` is `"stdio"` or whose `url` differs from `https://motion.open-design.ai/mcp`. If found, remove it with `codex mcp remove openmotion` (and `codex mcp remove motion` only when it is a legacy local OpenMotion `stdio` server).
  2. Check installed Codex plugins (for example `codex plugin list --json`) for a legacy local `openmotion` plugin bundling `.mcp.json` `stdio` (such as `openmotion@openmotion-local` or a local-path `openmotion` plugin). If present, remove it with `codex plugin remove <plugin@marketplace>` so its bundled local `stdio` server does not shadow Cloud MCP.
- **Claude Code**:
  - Check `claude mcp list` / `claude mcp get openmotion`. If `openmotion` uses `stdio` or another origin, run `claude mcp remove openmotion` (matching its scope such as `-s user` or `-s local`). If a repository `.mcp.json` still registers local `stdio` `openmotion`, warn the user instead of editing unrelated repository files.
- **Claude Desktop / Cursor / Other MCP clients**:
  - Replace any legacy local `stdio` `"openmotion"` entry with the remote Streamable HTTP endpoint (in Claude Desktop, remove any legacy `stdio` `"openmotion"` entry from `claude_desktop_config.json` before adding the Custom Connector so both do not coexist).
- **DeepSeek Harness (DSH)**:
  - Replace the `mcp-openmotion` `transport: stdio` entry with `transport: streamable-http` pointing to `https://motion.open-design.ai/mcp`, and disable or remove any legacy local `stdio` OpenMotion plugin adapter.

Use **only** the row matching the current host (skip if `openmotion` is already configured as Streamable HTTP pointing to `https://motion.open-design.ai/mcp` with no conflicting local plugin):

| Host | Add MCP server | Auth method |
| --- | --- | --- |
| **Codex** | `codex mcp add openmotion --url 'https://motion.open-design.ai/mcp'` | OAuth 2.1 (host OAuth RPC, `codex mcp login --no-browser openmotion`, or `codex mcp login openmotion`) |
| **Claude Code** | `claude mcp add --transport http --scope user openmotion 'https://motion.open-design.ai/mcp'` | OAuth 2.1 (`claude mcp login openmotion`) |
| **ChatGPT** | Settings → **Connectors** → **Add MCP Server** → `https://motion.open-design.ai/mcp` | OAuth 2.1 |
| **Claude.ai / Claude Desktop** | Settings → **Connectors** → **Add custom connector** → `https://motion.open-design.ai/mcp` | OAuth 2.1 |
| **Cursor / Other MCP clients** | Add `{"mcpServers":{"openmotion":{"type":"http","url":"https://motion.open-design.ai/mcp"}}}` to MCP settings | OAuth 2.1 (or PAT fallback below) |
| **Non-OAuth / Headless (e.g. DSH, CI)** | Streamable HTTP URL `https://motion.open-design.ai/mcp` with header `Authorization: Bearer ${OPENMOTION_TOKEN}` | Personal Access Token (`om_pat_*`) from `https://motion.open-design.ai` → **Settings → Account → Personal Access Tokens** (never commit or echo raw tokens) |

- **Optional entry Skill (non-blocking)**: you may install the lightweight `openmotion` Skill once via `npx --yes skills@1.9.0 add nexu-io/openmotion --skill openmotion --global --agent <codex|claude-code|universal> --copy --yes` (skip if already installed, `OPENMOTION_SKIP_PUBLIC_SKILL=1`, or if network/permissions fail). Detailed workflows are served dynamically from the cloud MCP via `resources/read` (`openmotion://workflow/*`).

## Step 2: Authorize via OAuth 2.1

1. **Skip login if already authorized**:
   - In **Codex**, if `codex mcp list --json` confirms `openmotion` uses `"type": "streamable_http"`, points to `https://motion.open-design.ai/mcp`, and already reports `"auth_status": "o_auth"` (with no conflicting legacy local `openmotion` plugin), skip login and go straight to Step 3.
   - In **Claude Code**, run `claude mcp get openmotion` — if transport is HTTP pointing to `https://motion.open-design.ai/mcp` and status is already **`Connected`**, skip login and go straight to Step 3.
2. **Run login (prefer the host's built-in browser when available)**:
   - **Hosts with a built-in browser (e.g., Codex Desktop / CUA)**:
     - **Prefer completing OAuth inside the host's built-in browser** (such as `open_in_codex` with `placement: "right"`, `target: { type: "browser", url: authorizationUrl }`, or CUA IAB) so the user signs in and approves access in the same browser that will later display the cloud editor:
       1. **Host-managed OAuth RPC (preferred — survives across turns)**: when the host exposes an OAuth RPC returning `authorizationUrl` (such as Codex Desktop `config/mcpServer/reload` + `mcpServer/oauth/login` with `{ "name": "openmotion", "timeoutSecs": 300 }`), call it and **prefer opening `authorizationUrl` directly inside the host's built-in browser**. Because the host owns the callback listener, you may send the short login prompt and end your turn to wait for the user.
       2. **CLI login (`codex mcp login --no-browser openmotion`) — process-bound callback listener**: only use this when no host OAuth RPC exists **and** the current shell can keep the CLI process alive (`180–300s` timeout) inside an interactive PTY / persistent shell with stdin kept open (do **not** close stdin with `< /dev/null`) until it exits `0`. It suppresses the default system browser launch, prints the authorization URL, and listens on `http://127.0.0.1:<port>/callback` **only while the CLI process stays running**—capture the printed URL, open it in the host's **built-in browser**, and wait for exit `0` in the same turn. **Never launch `codex mcp login` in an Agent shell and end your turn (or let a short shell timeout expire) while waiting for the user to click Allow / 同意授权**, or the loopback listener will terminate and the callback URL will fail with `ERR_CONNECTION_REFUSED`.
       3. **If the host lacks an OAuth RPC and cannot keep a shell login process alive while waiting for user approval**: skip shell-launched CLI login and immediately use **Step 2.3 Fallback** below so the user runs `codex mcp login openmotion` in their own persistent local terminal (or clicks **Connect / Log in** in the client UI).
     - Send only a brief prompt to sign in and click **Allow / 同意授权** (and share the clickable link if needed; never mention onboarding, templates, or internal verification), then wait for completion.
     - If `--no-browser` is unsupported by the local CLI, the host cannot open the URL in a built-in browser, or sign-in/callback is blocked inside the built-in browser (for example, third-party OAuth restrictions or localhost callback blocking), fall back to running `codex mcp login openmotion` in the shell (timeout `180–300s`), which opens the user's system browser and listens for the callback:
       - Exit `0`: authorization succeeded — proceed immediately to Step 3 without asking the user to confirm.
       - Non-zero exit (e.g., user clicked **Deny / 拒绝** or canceled): report briefly that authorization was not completed and stop.
   - **CLI hosts without a built-in browser (Codex CLI / Claude Code)**:
     - **Codex CLI**: run `codex mcp login openmotion` directly in the shell with a generous timeout (`180–300s`). It automatically opens the user's system browser and listens for the OAuth callback (continue on exit `0`; report briefly and stop on non-zero exit).
     - **Claude Code**: run `claude mcp login openmotion` directly with a generous timeout (`180–300s`). If the shell reports stdin is not a terminal, launch it inside a PTY and poll the log until authentication completes (if the browser did not open, share the printed authorization URL):
       - macOS: `script -qF /tmp/openmotion-login.log claude mcp login openmotion < /dev/null > /dev/null 2>&1 &`
       - Linux: `script -qfc "claude mcp login openmotion" /tmp/openmotion-login.log > /dev/null 2>&1 &`
       - Once authenticated (`Authenticated with` / exit `0`), proceed immediately to Step 3. If denied/failed, report briefly and stop.
3. **Fallback when shell cannot open a browser or bind localhost (sandboxed / remote / headless)**:
   - If the host exposes a non-blocking OAuth RPC (e.g. Codex Desktop `config/mcpServer/reload` + `mcpServer/oauth/login` with `{ "name": "openmotion", "timeoutSecs": 300 }`), call it to get `authorizationUrl`, open it in the built-in browser when available or send only the clickable link with a brief note to sign in / click **Allow / 同意授权** and reply when done (never mention onboarding, templates, or internal verification), and end your turn to wait.
   - Otherwise, **stop** and tell the user in plain language (`LANG`) using **only** their host's single action:
     1. Run `claude mcp login openmotion` / `codex mcp login openmotion` in their local terminal (add `--no-browser` over SSH; in Claude Code they can also use `/mcp` → `openmotion` → **Authenticate**; in GUI clients, click **Connect / Log in**).
     2. Sign in to their OpenDesign account (skipped if already signed in) and click **Allow / 同意授权**.
     3. Ask them to reply once authorized to continue (e.g., "授权完成后告诉我一声即可。" / "Let me know once you've authorized."). **Never** mention verification details, onboarding, template library, or recommended templates in this waiting message.

> **Silent browser-session context (do NOT mention proactively to the user):**
> A host's built-in browser uses an isolated profile and does not share login cookies with the user's system browser (Chrome/Safari/etc.); sessions in the two browsers stay independent. **Never bring this up unprompted** during setup, authorization, or normal project opening. Use this knowledge **only** if the user asks why their built-in browser and system browser show different sign-in states, or if an opened project hits the Studio sign-in or workspace-mismatch gate after authorization happened in a different browser (in which case, concisely guide them to sign in or switch to the same OpenDesign account and workspace in that browser).

> **HARD GATE — Never run Onboarding while login is still pending:**
> If the user still needs to sign in or approve access in the browser, **end your turn after sending the short login guidance** and wait for their reply. Do **NOT** call `/api/onboarding/prepare`, do **NOT** claim OpenMotion is connected (`🎉 OpenMotion 连接好啦`), and do **NOT** mention or print the welcome message or template recommendations in the same reply as a pending login prompt.

## Step 3: Verify connection & Continue (Mode A Onboarding / Mode B Task)

Run this section **only after authorization is complete** (already `"o_auth"` / `Connected`, `mcp login` exited `0`, or the user confirmed authorization). In **Mode A (pure setup)**, run verification, `/api/onboarding/prepare`, template-library opening, and card preparation silently—do not send progress commentary announcing "I will open the template library", "I will show three onboarding templates", or "I will use a visualization skill to make preview cards". In **Mode B (task-driven handoff)**, skip onboarding completely and resume the user's task directly.

1. **If `openmotion_get_project` is already available in this session**:
   - **Mode A (pure setup)**: call `openmotion_get_project({})` once to verify workspace access (an authorized OAuth client can access all of your projects in the selected workspace), then proceed directly to [Installation-success reply](#installation-success-reply) in this conversation.
   - **Mode B (task-driven handoff)**: do **not** run `/api/onboarding/prepare` or show generic onboarding template cards—call `openmotion_get_project` (or `openmotion_get_template` / `openmotion_get_skill` as requested) and continue the user's exact project, template, or brief directly.
2. **If registration and authorization succeeded, but this installation session has not loaded `openmotion_*` tools yet**:
   - Confirm registration/auth (`codex mcp list --json` showing `"auth_status": "o_auth"`, or `claude mcp get openmotion`). Do **not** reinstall or restart the host.
   - **Auto-handoff to a ready session when the host supports creating and switching conversations (e.g. Codex Desktop)** — skip this if the current conversation was already started as a handoff:
     1. Discover host thread tools via `tool_search` (or scan visible tools) for `create_thread`, `send_message_to_thread`, `navigate_to_codex_page`, `set_thread_title`, and `list_projects`.
     2. Preserve the current workspace/project container (use the same project/workspace target if this chat is project-scoped; stay projectless if projectless).
     3. Create a new conversation (optional title: `OpenMotion`) and send the handoff message in `LANG` so the new session loads all `openmotion_*` tools (make sure the new thread actually contains this message—if `create_thread` does not take an initial message, call `send_message_to_thread` immediately):
        - **Mode A (pure setup)**:
          - `zh`: `OpenMotion 已连接并授权。请先静默调用 openmotion_get_project({}) 验证工作区访问，打开模板库并调用 https://motion.open-design.ai/api/onboarding/prepare?lang=zh-CN 展示欢迎语和 3 张精选模板推荐卡片（不要输出内部验证细节或安装指南链接），等待用户发送具体创作需求后再创建项目。`
          - `en` (or localize to `LANG`): `OpenMotion is connected and authorized. Silently call openmotion_get_project({}) to verify workspace access, open the template library, and call https://motion.open-design.ai/api/onboarding/prepare?lang=en to deliver the localized welcome copy and 3 template preview cards (without internal verification notes or installation guide links). Wait for the user's creative brief before creating a project.`
        - **Mode B (task-driven handoff)**: forward the user's **complete original task/prompt verbatim** (preserving `projectId`, `templateId`, `skillId`, URLs, and all requirements) prefixed with one short status line (e.g. `OpenMotion 云端 MCP（https://motion.open-design.ai/mcp）已连接完成，请直接继续以下任务（跳过新建模板引导）：` / `OpenMotion Cloud MCP (https://motion.open-design.ai/mcp) is connected. Continue directly with the task below (skip onboarding cards):`). Never drop the user's task context during auto-handoff.
     4. Call `navigate_to_codex_page` (or the host's switch tool) to move the user straight into the new conversation.
     5. In this installation conversation, briefly confirm authorization and the switch. For Mode A, invite the user to send their creative request in the new chat. For Mode B, tell them their original request is already there. Show onboarding cards only in the new chat if applicable.
   - **Fallback when the host cannot create or switch chats, or handoff fails**. Confirm authorization and give the next action in `LANG`. In Codex, say `OpenMotion is connected and authorized. Open a new Codex chat and send your creative request there.` In Chinese, say `OpenMotion 已连接并授权。请打开一个新的 Codex 聊天，并在那里发送你的创作需求。` For Mode B, ask the user to resend their original request there. In another MCP client, refer to a new conversation in that client.

<!-- installation-onboarding:start -->
## Installation-success reply

Run this section only in **Mode A (pure setup)** after authorization is complete and the current conversation has the OpenMotion tools. Use the fallback above if the tools have yet to load.

> **Output purity rule**. Emit the exact maintained welcome copy returned by `/api/onboarding/prepare` **verbatim**. Keep verification details and the Agent installation guide out of the welcome.

### 1. Prepare frozen 3-of-4 recommendations from the cloud API

Call the stateless cloud onboarding endpoint **once** with `LANG`:

```sh
curl -fsSL "https://motion.open-design.ai/api/onboarding/prepare?lang=${LANG}"
```

It returns:
- `templateIds`: three distinct curated IDs sampled without replacement from `shared/onboarding-templates.ts` (keep this exact order across every surface and retry; pass `&templates=id1,id2,id3` on retry so the selection never redraws).
- `libraryUrl`: `https://motion.open-design.ai/?templates=1`.
- `welcomeMarkdown`, `fallbackWelcomeMarkdown`, `noSidebarWelcomeMarkdown`, and `noSidebarTextWelcomeMarkdown`: localized maintained welcome copy in `LANG`.
- `inlineHtmlUrl`, `inlineHtmlSha256`, and `inlineHtmlBytes`: self-contained `< 1,000,000`-byte HTML card fragment with embedded silent VP9 WebM previews and JPEG posters.
- `cardPresentation`: exact arguments for `openmotion_show_template_recommendations`.
- `dshCardPresentation`: exact `propose_action` arguments formatted for DSH's `detailsSchema` (`id`, `title`, `description`, video `previewUrl`, `posterUrl`, `duration`).
- `templates`: ordered metadata (`position`, `templateId`, `title`, `summary`, `durationSeconds`, `previewUrl`, `posterUrl`, `videoUrl`) for text fallback.

Never substitute built-in examples (`product-promo`, `nyt-graph`, `decision-tree`) for the curated onboarding pool unless the user explicitly asks for them.

### 2. Open the cloud template library once (without creating a project)

- Call `openmotion_open_preview({ "target": "templates", "action": "open" })` to obtain `previewUrl` and use `prepare.libraryUrl` (`https://motion.open-design.ai/?templates=1`) if needed.
- On hosts with a right-hand browser pane (such as Codex Desktop `open_in_codex` with `placement: "right"`, CUA `cua.createBrowserTab('iab', url, { visible: true })`, or DSH workspace view), open or reuse that tab **once**. Do not run extra snapshots, screenshots, inventory, layout, or playback audits.
- On CLI hosts without a right-hand browser pane (such as Claude Code terminal), do **not** claim a right-hand library opened—provide the clickable `libraryUrl` using `noSidebarWelcomeMarkdown` / `noSidebarTextWelcomeMarkdown`.
- Never create a placeholder project during onboarding.

### 3. Deliver the localized welcome and three template preview cards

Choose the best supported card surface for the current host (host identity alone is not a reason to downgrade to text):

1. **Native MCP App (when `openmotion_show_template_recommendations` is natively discovered)**:
   - Call `openmotion_show_template_recommendations` with `prepare.cardPresentation.arguments` (`{ templateIds, language, onboarding: true }`) when the right-hand library opened (the component renders the welcome above the three interactive cards—do not duplicate it in text).
   - If the host has no right-hand pane or library opening failed/is unconfirmed, pass `prepare.cardPresentation.cardsOnlyArguments` (`onboarding: false`) and emit `prepare.noSidebarWelcomeMarkdown` in reply text.
2. **Self-contained HTML visualization cards (Codex default when the native MCP App is unavailable)**:
   - Download into the current chat's explicitly permitted visualization directory:
     ```sh
     curl -fsSL "<prepare.inlineHtmlUrl>" -o "<HOST_VISUALIZATION_DIR>/openmotion-welcome.html"
     ```
   - Verify SHA-256 matches `prepare.inlineHtmlSha256` and size is `< 1,000,000` bytes.
   - Emit `prepare.welcomeMarkdown` verbatim (when the right-hand library opened) or `prepare.noSidebarWelcomeMarkdown` (otherwise), followed immediately by:
     `visualize{"path":"<HOST_VISUALIZATION_DIR>/openmotion-welcome.html"}`
   - Do not summarize the welcome or replace it with a technical status report.
3. **DSH conversation cards**:
   - Load `prepare.dshCardPresentation.skill` (`openmotion-template-recommendations`) and call `propose_action` with `prepare.dshCardPresentation.arguments` (setting `details.libraryOpened: true` only after confirmed library opening). Do **not** pass raw `prepare.templates` directly: DSH expects `id`, `description`, `duration`, and video-stream `previewUrl` (`videoUrl`), which `prepare.dshCardPresentation.arguments.details.templates` already supplies.
4. **Text fallback (CLI / hosts without card UI, or when card rendering fails)**:
   - Emit `prepare.fallbackWelcomeMarkdown` (if a right-hand library opened) or `prepare.noSidebarTextWelcomeMarkdown` (otherwise), then list the exact three items from `prepare.templates` in order with **title**, **summary**, and clickable **`previewUrl`**, and briefly note that this client does not render interactive preview cards.

### Welcome copy reference

When the right-hand library opened, the maintained Chinese welcome is:

```text
🎉 OpenMotion 连接好啦，右侧就是模板库！

我是你的开源视频创作搭档，我有丰富的高水准视频模板，也支持从参考视频或一个灵感出发，和你一起创作精彩的视频。

模板库支持搜索，也可以随意浏览，找到喜欢的点击「复刻模板」就能开始你的创作！

不想自己找？先看看我挑的这 3 个 👇
```

When there is no right-hand browser pane (or opening failed/is unconfirmed), replace only the first line with a truthful heading plus the clickable library link (e.g. `🎉 OpenMotion 连接好啦！模板库：https://motion.open-design.ai/?templates=1`), keeping the rest unchanged.

### Completion boundary and next turn

- **Do not create or export a video unasked.** Stop after onboarding and wait for the user's choice or creative brief.
- **If the user later submits a brief in the same installation conversation and native `openmotion_*` tools are still not exposed**: do not fall back to authoring local HTML without OpenMotion MCP—only then briefly ask the user to paste their brief into a new conversation where the OpenMotion tools are loaded.
- **Accepted template selection**: when the user chooses a card and submits a brief, call `openmotion_get_template` with that exact `templateId`. Reuse the editable project (`openmotion://workflow/template/start`) when `hasHtmlProject` is `true`; use `openmotion://workflow/recreate/start` only when it has no editable project. Never silently swap templates.
- **Cloud media import**: local host paths (`sourcePath`) are unsupported in cloud mode—use `openmotion_import_assets` (`prepare_upload` → presigned PUT → `upload_ticket`, public HTTPS `url`, or workspace `library_asset`).
<!-- installation-onboarding:end -->

## Troubleshooting

- **OAuth callback timeout (`ERR_CONNECTION_REFUSED` on `127.0.0.1:<port>/callback`)**: `127.0.0.1:<port>/callback` is the MCP client's temporary OAuth PKCE loopback listener (not a local OpenMotion server). This error happens when the CLI login command timed out or was killed when the Agent ended its turn before **Allow / 同意授权** was clicked. Re-run the host OAuth RPC—or have the user run `codex mcp login openmotion` / `claude mcp login openmotion` in their own persistent local terminal—and approve promptly while that process stays running.
- **Legacy local OpenMotion still responds or conflicts with Cloud MCP**: verify the active `openmotion` MCP entry uses `streamable_http` / `http` pointing to `https://motion.open-design.ai/mcp`, remove any legacy local `stdio` `openmotion` entry (`codex mcp remove openmotion` / `claude mcp remove openmotion`) and any legacy local Codex plugin (`codex plugin remove <plugin@marketplace>`), re-add the cloud endpoint, and open a new conversation.
- **`401 Unauthorized` on `/mcp`**: token expired or revoked—re-run OAuth login (or create a fresh PAT in **Settings → Account → Personal Access Tokens**).
- **`PROJECT_NOT_FOUND` for an existing web project**: check that your connected MCP server URL matches the exact origin of the project URL (for example `https://motion.open-design.ai/mcp` vs a staging/test origin) and that you selected the matching workspace during OAuth login. Re-run OAuth login to switch workspaces if needed.
- **Built-in browser asks to sign in or shows "Project not in current workspace" while MCP works**: the host's built-in browser keeps separate cookies from the system browser. Have the user sign in (or switch account/workspace in **Account settings**) inside the built-in browser using the same OpenDesign account and workspace authorized for MCP.
