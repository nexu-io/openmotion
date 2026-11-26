# Studio preview and edit reconciliation

## Decision

Studio should show confirmed project content together with the edits still owned by this window. Moving a title to x=150 and immediately resizing it to 900 px should keep both values visible when the move is acknowledged. A receipt confirms its own operation. The player reports what it actually mounted. An HTTP success alone cannot establish what the user sees.

Use the existing [editing contract](edit-core.md), project queue and isolated preview. HTML, CSS and JavaScript remain the project format. The first implementation belongs in Studio and uses the existing HTTP, SSE and MCP contracts.

## Responsibility and lifetime

| State | Owner | Lifetime |
| --- | --- | --- |
| Confirmed content and file versions | Project Service and Studio's confirmed-source cache | Shared durable project history. Cached text can be evicted. File version tokens support equality checks. |
| Gestures and local edits | The input handler during a gesture, then the ordered project queue | Pointer movement updates the current element. A completed gesture enters the queue with an operation ID and file preconditions. Later edits build on the working copy. |
| Visible content | The mounted player and the committed-preview scheduler | Track project, document identity and mounted file versions. Switching project or replacing a document invalidates work for the previous mount. |

## How events affect the screen

| Event | Required behavior |
| --- | --- |
| Local receipt or SSE for the same immutable revision | Coalesce the reports. Confirm the edit once. Keep subsequent gestures, selection and playback time intact. |
| Agent updates an independent clip | Update the affected clip in place when its dependencies and player capabilities allow it. Treat shared scripts, styles and composition dependencies as potentially overlapping. |
| Agent edits the same file | Keep the file precondition of the local write. On a confirmed conflict, adopt the accepted project version and recheck dependent local edits before applying them. Never silently replay an obsolete gesture over a peer's work. |
| Agent removes the selected element | Once deletion is confirmed, release the gesture and selection for that element. A late pointer-up must not recreate it. |
| Save or player reply times out | Reuse the write ID on a save retry. For a lost paint reply, check the mounted revision before repeating the update. Only a definitive write rejection warrants reverting that write. |
| Script or root document changes | Update a supported change in place. Rebuild the affected scene when its script must restart. Use a temporary second iframe when the entire document must restart and a seamless transition is possible. Surface script errors against the affected revision. |

## Implementation

1. [The scheduler](../../studio/src/player/committedPreview.ts) checks ownership before and after an asynchronous paint or scene recovery. A late receipt can confirm persistence while a newer revision owns presentation. The committed-edit path distinguishes applied, superseded, scene rebuild required and unconfirmed communication. A lost paint acknowledgment triggers a mounted-version probe.
2. The compiler identifies unique, independently mounted leaf scenes in eligible previews. Studio can present a verified sibling update while a gesture or save owns another leaf. Shared dependencies, root changes and unknown targets retain document-wide coordination. File views, conflict handling and durable writes still settle through their existing owners.
3. For a parked scene the player can verify a change against its compiled markup and remember accepted geometry or caption edits for remount. Captions support bounded literal text and plain line breaks. For more complex changes, the bridge can recover matching scene fragments from one compilation or request document replacement when shared code or runtime behavior requires it.

## Acceptance

### Undo and redo in a shared project

For a recent geometry or timeline edit with known before/after contents, Studio can display the inverse on Undo and the forward change on Redo as soon as the user clicks. A pending local save still commits in order. The preview and timeline hold the provisional result while the server decides the history step. Other windows learn the durable result through the project event stream. The local cache is bounded and is invalidated by changes from other clients.

If several local saves overlap and their combined inverse is still unknown, Undo binds to the newest queued action and waits for its receipt. If another client commits after the server accepts a step but before its HTTP response arrives, the event for the newer revision takes over the view. The delayed response cannot reinstate the older geometry. Clients connected to servers without guarded history support use their existing confirmed history flow.

`POST /api/projects/:id/history/step-guarded` identifies both the current and destination project versions, each by ID and revision. The server checks both under the project lock. This also protects Redo when another editor branches and returns to the same starting version. A conflict rejects the step with HTTP 409. Studio discards the provisional change and reconciles with the authoritative state. Undo and redo continue to move the project's shared history cursor. Arbitrary source changes and previews without a verified in-place update retain the confirmed restore path.

With a local two-origin dev-auth stack and the Welcome template, run `STUDIO_URL=http://127.0.0.1:4173 node studio/tests/e2e/responsive-cloud-undo.mjs` to measure click-to-paint with delayed responses. Run `STUDIO_URL=http://127.0.0.1:4173 node studio/tests/e2e/cloud-history-conflicts.mjs` to exercise concurrent MCP edits, rejected history steps, and a late acknowledgment in two windows.

For a selected canvas element, compare its visible edges with the green selection rectangle in the same composited frame. Check the first paint after Undo or Redo, the interval before acknowledgment, and the subsequent drag. A matching final position alone can hide a frame where the element has moved and the selection rectangle still marks its old position.

### Editing and recovery

Use a disposable copy of Welcome in two Studio windows and an independent MCP client. Hold the first save response, move an image, resize it, then move a title. Run with the writer's SSE before and after its HTTP receipt. Check each operation in persisted history, all three final values in both windows and the reopened project, and the on-screen values while each response is released. Capture iframe identity and full-preview requests throughout.

Repeat with the Agent changing an independent clip, changing the same file and deleting the selected element. Include an ambiguous network failure and a genuine version conflict. Finally replace the root runtime and verify the legitimate document-replacement path, playback position and failure reporting. Measure save acceptance, observer event receipt and first correct frame separately. Unit tests establish ordering decisions. The two-window run establishes interaction quality and actual network costs.

### Running the combined browser check

Build Studio from the checkout under test and restart its API so that the page, compiler and preview bridge come from the same build. Use a local dev-auth stack with PostgreSQL, Redis, S3-compatible storage, `TEXT_PATCH_WRITES=true`, an isolated `PREVIEW_PUBLIC_ORIGIN` and the Welcome template. The runner creates disposable projects. An installed Chrome or `PUPPETEER_EXECUTABLE_PATH` supplies the browser.

```sh
STUDIO_URL=http://127.0.0.1:4173 EVIDENCE_DIR=/path/to/results npm run test:preview-collaboration
```

The receipt-order scenarios save the actual HTTP receipts, observed SSE events, display samples and iframe counts. Network evidence distinguishes active preview HTML, scene snapshots, timeline thumbnail captures and the initial load of the reopened project. The recovery scenario verifies deletion during a drag, a rejected stale MCP write, whole-document replacement, restored playback position and error delivery to Studio. The burst scenario drops an accepted HTTP response and checks that the retry reuses its operation IDs, all 100 drags persist and the observer receives each accepted operation once.

In the local Welcome acceptance run on 2026-11-25, both delivery orders produced five consecutive persisted versions. Both windows retained their original preview document. Each scenario recorded zero new stage iframes, zero full preview downloads, zero scene-fragment downloads and five thumbnail captures across the two warm windows. A separate 100-drag run recovered from a lost response with two accepted batches of 20 and 80 edits. These results cover the tested build and scenarios; deployment acceptance uses the same runner against the version being released.
