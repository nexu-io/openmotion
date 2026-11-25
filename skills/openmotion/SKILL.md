---
name: openmotion
description: Create and edit videos with OpenMotion, recreate a reference video, or adapt an editable template. Connect to the matching cloud or local OpenMotion Streamable HTTP MCP workspace (preferring OAuth 2.1), then continue through the matching production workflow. Use for OpenMotion installation and first use; an already-selected specialist continues directly. Repository development does not trigger video production.
---

# OpenMotion

Turn a reference, template or creative brief into an editable video project in OpenMotion Studio (cloud or local workspace), with preview and MP4 export through the same workspace.

## Connect once

Discover the current host's OpenMotion MCP tools first. If connected, call `openmotion_get_project` to identify the workspace and verify that the connected MCP server origin (`previewUrl` / `serverOrigin`) matches any target project or session URL the user supplied. Preserve projects, credentials, project/version identities and unrelated host settings. Do not reinstall a working connection.

When the user supplies a cloud URL (for example `https://motion.open-design.ai/...` or `https://openmotion.powerformer.net/...`) and the currently connected MCP server points to a different origin (such as local `http://127.0.0.1:4173`), or `openmotion_get_project` returns `PROJECT_NOT_FOUND` with a mismatched `serverOrigin`:

1. Treat it as an **environment mismatch**, not a missing project.
2. Prefer **OAuth 2.1** over manual tokens: guide the user to register the matching `<origin>/mcp` endpoint in their host and complete browser OAuth sign-in (for Codex: `codex mcp add <serverName> --url <origin>/mcp` then `codex mcp login <serverName>`; for Claude Code: `claude mcp add --scope user --transport http <serverName> <origin>/mcp` then run `/mcp`), or open `<origin>/settings/mcp`. Use distinct server names across environments (`openmotion` for production, `openmotion-test` for test/staging, `openmotion-local` for local dev).
3. Only request a workspace Personal Access Token (PAT) when the host cannot perform OAuth 2.1 or direct HTTP verification is explicitly needed. Direct the user to `<origin>/settings/account?preset=readonly#tokens` (for read-only checks) or `<origin>/settings/account#tokens` — never `/connect/guide?host=mcp`, which is a plain-text agent guide rather than the token page.

If OpenMotion is missing or disconnected for a local installation, read the maintained [installation guide](https://github.com/nexu-io/openmotion/blob/main/docs/install.md) and follow its current-host instructions. Reuse an existing installation rather than mixing source and npm. Derive onboarding language from the user's request. Follow the guide's shared welcome, three-card and template-library procedure. Show cards whenever this host supports them; use the same three recommendations as text only when card presentation is unsupported or fails. Do not treat the host name as a capability check.

Installing this Skill with Skills CLI installs instructions only. Complete runtime/cloud MCP authentication before claiming production readiness. Use actual MCP endpoint URLs (`/mcp`) and transport settings; the Studio root URL alone is not the MCP endpoint, and cloud `/mcp` requires OAuth 2.1 or Bearer PAT (browser session cookies are never accepted). Native tools must be discovered and `openmotion_get_project` must succeed in the calling host before claiming that host is connected. A standalone probe has a separate verification scope. Report the concrete blocker when host recovery is needed.

Installation alone does not request a film, project edit, export or paid generation. If the user only asked to install, finish the maintained onboarding and wait. If they already supplied a creative brief, continue with it after setup.

## Continue with the matching workflow

Read the selected installed Skill, or its full MCP resource through `resources/read`. Resources remain available when only this entry Skill was installed; do not depend on sibling files in a standalone Skills CLI copy.

| User intent | Skill | MCP resource |
| --- | --- | --- |
| Original video, narrative, motion or sound design | openmotion-director | `openmotion://workflow/director/start` |
| Browse or adapt an existing editable template | openmotion-template-to-video | `openmotion://workflow/template/start` |
| Recreate a reference video for this film | openmotion-recreate | `openmotion://workflow/recreate/start` |
| Turn a reference into a reusable template | openmotion-video-to-template | `openmotion://workflow/video-to-template/start` |
| Scoped edits under established decisions, preview, troubleshooting or export | openmotion-production | `openmotion://workflow/production/start` |
| Build or remix a playable browser game | openmotion-game | `openmotion://workflow/game/start` |
| Generate an individual image, video, speech or music asset | openmotion-media | `openmotion://workflow/media/start` |

Continue directly in that workflow, preserving the user's brief and existing decisions. These are instructions for the same Agent, not recursive tasks or a new creative intake. The selected workflow owns reference reading, revision protection, asset generation, preview and delivery. Read its conditional references as needed; do not load every workflow. Technical export validation, actual playback and human visual acceptance remain separate.
