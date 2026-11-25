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

## Implementation order

1. **Protect revision ownership during recovery.** Start in [committedPreview.ts](../../studio/src/player/committedPreview.ts). Use the same revision check for an in-place paint and a batch scene rebuild. A late local receipt must preserve a queued update for the confirmed revision. When the current scene cannot be updated safely, retain recovery from the latest project state.
2. **Give update results distinct meanings.** Migrate the bridge and its callers together. Distinguish applied, superseded, scene rebuild required and unconfirmed communication. Reuse the existing mounted-version probe. Remove the superseded fallback decisions as each caller moves.
3. **Narrow waits where independence is known.** Associate pending gestures with their affected files and reuse verified composition dependencies. Keep the document-wide hold for unknown impact, root changes and document replacement. Extend independent updates to the observer while retaining protection for the operator's active input.
4. **Qualify document replacement.** Record which update required a new document in the browser test. Drag, resize, inline text and a disjoint Agent edit must use the same visible iframe with zero new shadow iframes and zero full-preview HTML downloads attributable to these actions.

## Acceptance

Use a disposable copy of Welcome in two Studio windows and an independent MCP client. Hold the first save response, move an image, resize it, then move a title. Run with the writer's SSE before and after its HTTP receipt. Check each operation in persisted history, all three final values in both windows and the reopened project, and the on-screen values while each response is released. Capture iframe identity and full-preview requests throughout.

Repeat with the Agent changing an independent clip, changing the same file and deleting the selected element. Include an ambiguous network failure and a genuine version conflict. Finally replace the root runtime and verify the legitimate document-replacement path, playback position and failure reporting. Measure save acceptance, observer event receipt and first correct frame separately. Unit tests establish ordering decisions. The two-window run establishes interaction quality and actual network costs.
