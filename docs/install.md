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
3. **Reuse an existing working connection (after verifying origin)**: if `openmotion_get_project` is already available in this session for `https://motion.open-design.ai/mcp`, skip Steps 1–2 and go straight to Step 3 (Mode A: onboarding; Mode B: continue the user's task directly). If the existing `openmotion` server points to a different origin than the target deployment, update/configure it for `https://motion.open-design.ai/mcp` first.
4. **Never install a local runtime**: do not run `git clone`, `npm install`, `npx @openmotion/app`, `docker compose`, or local stdio `mcp.ts`.
5. **Configure only the current host**: preserve unrelated MCP servers, Skills, and settings. Never mention setup steps for unrelated clients in user-facing replies.
6. **Never narrate internal onboarding mechanics**: never tell the user you are running "onboarding / 引导 / 中文模板引导", opening the template library, fetching three templates, or using a visualization skill to build preview cards—neither while waiting for authorization nor in progress updates before the final reply. Execute those steps silently and deliver only the final welcome and cards cleanly.

## Step 1: Add the Cloud MCP server

Use **only** the row matching the current host (skip if `openmotion` already points to `https://motion.open-design.ai/mcp`):

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
   - In **Codex**, if `openmotion_get_project` already works or `codex mcp list --json` already reports `"auth_status": "o_auth"` for `openmotion` (pointing to `https://motion.open-design.ai/mcp`), skip login and go straight to Step 3.
   - In **Claude Code**, run `claude mcp get openmotion` — if status is already **`Connected`**, skip login and go straight to Step 3.
2. **Run login (prefer the host's built-in browser when available)**:
   - **Hosts with a built-in browser (e.g., Codex Desktop / CUA)**:
     - **Prefer completing OAuth inside the host's built-in browser** (such as `open_in_codex` with `placement: "right"`, `target: { type: "browser", url: authorizationUrl }`, or CUA IAB) so the user signs in and approves access in the same browser that will later display the cloud editor:
       1. When the host exposes an OAuth RPC returning `authorizationUrl` (such as Codex Desktop `config/mcpServer/reload` + `mcpServer/oauth/login` with `{ "name": "openmotion", "timeoutSecs": 300 }`), call it and **prefer opening `authorizationUrl` directly inside the host's built-in browser**.
       2. Otherwise, when running CLI login on a host with a built-in browser, **prefer `codex mcp login --no-browser openmotion`** inside an interactive PTY / persistent shell with stdin kept open (do **not** close stdin with `< /dev/null`, or `--no-browser` exits before the callback arrives). It suppresses the default system browser launch, prints the authorization URL, and still listens on `http://127.0.0.1:<port>/callback` — capture the printed authorization URL and open it in the host's **built-in browser** (once the user approves, the loopback callback completes automatically without manual URL pasting; wait for exit `0`).
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
          - `zh`: `OpenMotion 已连接完成，请按 https://motion.open-design.ai/install.md 验证连接并开始创作。`
          - `en` (or localize to `LANG`): `OpenMotion is connected. Follow https://motion.open-design.ai/install.md to verify the connection and get started.`
        - **Mode B (task-driven handoff)**: forward the user's **complete original task/prompt verbatim** (preserving `projectId`, `templateId`, `skillId`, URLs, and all requirements) prefixed with one short status line (e.g. `OpenMotion 云端 MCP（https://motion.open-design.ai/mcp）已连接完成，请直接继续以下任务（跳过新建模板引导）：` / `OpenMotion Cloud MCP (https://motion.open-design.ai/mcp) is connected. Continue directly with the task below (skip onboarding cards):`). Never drop the user's task context during auto-handoff.
     4. Call `navigate_to_codex_page` (or the host's switch tool) to move the user straight into the new conversation.
     5. In this installation conversation, reply with one brief confirmation (e.g., `OpenMotion 已完成连接并授权，已为你切换到新的创作对话。`) and stop—do **not** duplicate onboarding cards here.
   - **Fallback (when the host has no conversation-creation/switch tool, e.g. `codex_app` disabled or Claude Code CLI, or if thread creation fails)**:
     - **Mode A (pure setup)**: proceed directly to [Installation-success reply](#installation-success-reply) in this conversation using the cloud onboarding API below. **Do NOT append any technical caveat** about tools not being loaded yet or telling the user to open a new conversation during the onboarding reply.
     - **Mode B (task-driven handoff)**: do **not** run onboarding cards and do **not** fall back to authoring local HTML without OpenMotion MCP—briefly confirm in `LANG` that OpenMotion is connected and authorized, and ask the user to paste their task into a new conversation where `openmotion_*` tools are loaded.

<!-- installation-onboarding:start -->
## Installation-success reply

Run this section **only in Mode A (pure setup)** and **only after authorization is complete** (skip this entire section in **Mode B**, and never combine it with a pending login request). Once authorized, accept onboarding presentation and current-chat MCP tool hot-reload independently.

> **Output purity rule**: Emit the exact maintained welcome copy returned by `/api/onboarding/prepare` **verbatim**—do **NOT** rewrite or summarize it, do **NOT** prepend technical status reports (such as "OAuth 授权成功 / 已验证可以读取工作区 / 当前可见项目为 0 个"), and do **NOT** append a disclaimer telling the user that tools are not loaded yet or asking them to open a new conversation.

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

- If native MCP tools are active, call `openmotion_open_preview({ "target": "templates", "action": "open" })` to obtain `previewUrl`; otherwise use `prepare.libraryUrl` (`https://motion.open-design.ai/?templates=1`).
- On hosts with a right-hand browser pane (such as Codex Desktop `open_in_codex` with `placement: "right"`, CUA `cua.createBrowserTab('iab', url, { visible: true })`, or DSH workspace view), open or reuse that tab **once**. Do not run extra snapshots, screenshots, inventory, layout, or playback audits.
- On CLI hosts without a right-hand browser pane (such as Claude Code terminal), do **not** claim a right-hand library opened—provide the clickable `libraryUrl` using `noSidebarWelcomeMarkdown` / `noSidebarTextWelcomeMarkdown`.
- Never create a placeholder project during onboarding.

### 3. Deliver the localized welcome and three template preview cards

Choose the best supported card surface for the current host (host identity alone is not a reason to downgrade to text):

1. **Native MCP App (when `openmotion_show_template_recommendations` is natively discovered)**:
   - Call `openmotion_show_template_recommendations` with `prepare.cardPresentation.arguments` (`{ templateIds, language, onboarding: true }`) when the right-hand library opened (the component renders the welcome above the three interactive cards—do not duplicate it in text).
   - If the host has no right-hand pane or library opening failed/is unconfirmed, pass `prepare.cardPresentation.cardsOnlyArguments` (`onboarding: false`) and emit `prepare.noSidebarWelcomeMarkdown` in reply text.
2. **Self-contained HTML visualization cards (Codex default — works even before current-chat MCP tools hot-reload)**:
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

- **OAuth callback timeout (`ERR_CONNECTION_REFUSED`)**: the local login command timed out before you clicked **Allow / 同意授权**. Re-run the login command and approve promptly.
- **`401 Unauthorized` on `/mcp`**: token expired or revoked—re-run OAuth login (or create a fresh PAT in **Settings → Account → Personal Access Tokens**).
- **`PROJECT_NOT_FOUND` for an existing web project**: check that your connected MCP server URL matches the exact origin of the project URL (for example `https://motion.open-design.ai/mcp` vs a staging/test origin) and that you selected the matching workspace during OAuth login. Re-run OAuth login to switch workspaces if needed.
- **Built-in browser asks to sign in or shows "Project not in current workspace" while MCP works**: the host's built-in browser keeps separate cookies from the system browser. Have the user sign in (or switch account/workspace in **Account settings**) inside the built-in browser using the same OpenDesign account and workspace authorized for MCP.
