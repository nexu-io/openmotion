# Project editing contract

A Studio gesture and a remote MCP call with the same intent and base files must produce the same saved work. This contract applies when adding or migrating an edit. Individual commands become available as their Studio and cloud entry points land.

| Caller | Responsibility |
| --- | --- |
| Studio | Show each completed edit immediately from the latest local source, including earlier unconfirmed edits. Run edit-core in the browser. On a first use, read the specific missing inputs and submit the prepared file changes through the project queue. Playback and selection stay local. |
| Remote Agent | Discover the composition path and stable element IDs from the project. Submit an intent or explicit file contents through MCP with the observed project version. Editing must work with all browsers closed. |
| HTTP and MCP handlers | Browser sessions submit prepared file changes. Authenticated programmatic clients can also submit a semantic command. The cloud executor reads the inputs only for those commands. Both entry points use the same file transaction, project history and change notifications. |
| edit-core | Own the meaning of each editing action. Given the same source, targets and command, compute the same changes in Studio and headless execution. Reuse the Hyperframes SDK and existing source, GSAP, split and caption transformations internally. Storage, network requests, DOM measurements and project history belong to callers. |

## What drives the timeline

A project's composition HTML stores clip timing and track placement. For example, the [Paperwing composition](../../examples/wing-construction/index.html) places its audio clip with `data-start`, `data-duration` and `data-track-index`. Studio derives the visible timeline from this content. A browser or headless caller can run edit-core with the current source and a command to produce the next source.

When a user trims a ten-second clip to six seconds, Studio must keep showing six seconds while the save is in flight. The mounted player may still describe the ten-second version it loaded. Receiving that description is a read and must never write a project file, add an undo step, or replace the pending timing. A confirmed edit from another client, an explicit undo or redo, or a rejected save can legitimately change what Studio displays.

## Choosing the unit of work

- **Trim a clip.** At normal playback speed, a clip covering timeline seconds 5–9 and starting at source second 10 becomes timeline seconds 6–9 and starts at source second 11 after a one-second left trim. The core applies the trim's linked-audio and animation rules in that edit. A move has different semantics even when it changes the same time attribute.
- **Edit several elements.** Send one property edit for the selected IDs and the properties being changed, such as text, font size or color. Use an ordered batch when one user action spans commands or files. Resolve each target in its source file, and reject the batch if a required target is missing or ambiguous. Each command sees the preceding changes in its batch.
- **Rewrite a composition.** An Agent that has authored complete HTML, CSS or JavaScript can submit the changed files together through the existing file-edit interface. Honor explicit source edits as authored, with the same concurrency, history and event guarantees. A file diff does not convey a gesture such as trimming or splitting.

Canvas geometry can depend on the rendered viewport. Studio can measure it as input to a command. A headless caller supplies the necessary values or uses a source-level edit. A persisted rule must be executable without a browser selection, an iframe, or per-property network calls.

## Saving and collaboration

1. Each completed operation has a stable ID. Send the observed file version, or a reference to a preceding edit of that file in the same packet. Guard any other file used to compute the result. UTF-8 text patches use tuples of byte offset, deleted byte count and inserted text, all relative to the same base. When patch storage is disabled, send versioned full contents through the same batch endpoint. The server validates the inputs to each operation together and reports any successful prefix before a conflict.
2. Keep dependent writes atomic. Commit the edits with one server-generated action label and one project history step, then publish the project change via SSE. A no-op adds no undo step. Uploading media and placing that media on a timeline are distinct actions.
3. After an uncertain response, retry the same payload with its original request ID. A conflict requires reconciling local changes against the latest source. Surface a rejected edit in Studio so the visible state and saved state agree.
4. Undo and redo follow one durable, chronological history per project, across all editors and Agents. If Studio moves a title and an Agent then changes a caption, the first undo restores the caption and the second restores the title. SDK session history and browser state cannot determine that order. PostgreSQL records the project versions and history. File storage holds the referenced contents.

Studio groups the automatic saves from one typing burst or compound gesture into one project undo step. Each accepted save creates its own immutable version, so an earlier revision remains readable. Only consecutive saves from the same authenticated user and explicit gesture may advance that undo step. A separately confirmed command, another client's independent gesture, or an MCP edit starts its own step. Retrying a request with its original ID returns the original version.

### Reading a saved file

Studio compares the complete request payload with the patch payload. A patch that exceeds the diff computation budget can still be represented as one replacement. A direct caller submitting a patch over 64 KiB receives a request to send `content` if its replacement instructions are provably at least as large as the whole file on the wire. The API makes this check using byte offsets and lengths, including an allowance for JSON escaping.

A small patch creates an immutable file revision in PostgreSQL. When a second Studio receives the project's SSE event, it can request changes since its confirmed file version. A reader without a matching base can request the complete contents. The API, preview and export workers reconstruct the requested version from a complete baseline plus the following patches. When an edit reaches 32 patches or 256 KiB of serialized patches since the last scheduled or completed baseline, its transaction marks that exact file version for the media worker. The next edit starts a new counting interval. A single large patch can cross the threshold in one edit. Studio and the semantic editor choose a patch for localized changes when it saves transfer bytes and use full contents for wholesale rewrites. Saving and reopening work while the worker is stopped or building a baseline. The worker reads the base and uploads the new object outside database transactions. Short transactions protect the pending object from garbage collection and publish the completed baseline. A downloadable file uses a materialized, content-addressed blob. A file version stays valid when a new baseline is produced.

Remote agents can use `openmotion_get_project` with `file.path`. The default mode reads text. Use `download` for a signed URL or `sync` with a previously observed file version for incremental updates. Pin the returned version when continuing a paged read or renewing a URL.

For a host with Node, the cloud inventory advertises a versioned edit-core CLI. The host runs the same commands on versioned project inputs, then submits the resulting changes through remote MCP with its own identity. See [local edit preparation](../mcp-phase1-tools.md#openmotion_edit_project).

Composition insertion depends on the edited parent and the inserted child. Saving checks those file versions. During preview compilation a reference back to a composition already being expanded on that branch is skipped silently. A sibling branch can mount the same composition normally.

## Extending and verifying an edit

Start with an existing command when the intent and affected files match. Add a command for a distinct editing rule, such as split or trim. Keep transport-specific checks in the service and each transformation in one place. Start with the [command dispatcher](../../packages/edit-core/commands.ts), [wire schema](../../packages/edit-core/schema.ts) and [cloud executor](../../src/services/project-edit.ts).

Exercise a migrated action through Studio and remote MCP on identical input. Compare saved contents and undo results. For batches, cover multiple targets, a failing target, a stale version and a retried request. For collaboration, verify that another open Studio receives the resulting change. Count edit writes separately from reads for previews and the SSE subscription.

### Keeping a second Studio timeline in sync

After a file commit, the receiving Studio reads the changed composition it is displaying. Its timeline, SDK session and open source editor share that read. The file source supplies authored clip timing and track placement. The preview refresh proceeds independently so a slow media load cannot delay the timeline update. The outgoing player may still report playback data. Its old manifest cannot replace a newer authored timeline. Switching projects or compositions invalidates outstanding reads.

The isolated preview can apply verified changes to the mounted document, including supported timing, layout and media properties. For example, a speed edit can update the media rate and clip durations together while preserving the playhead. If a verified update affects one inactive nested scene, Studio can refresh just that scene. The full-preview fallback loads a second iframe in the background and switches once it is ready at the current playback time.

Keep persistence and presentation separate. The file version determines whether a saved patch applies to the project. The mounted document determines how Studio can show its result. A file crossing the current preview comparison budget, or a missing acknowledgement from an iframe, does not invalidate a successful save. Playback and animation can mutate the live DOM; only explicit user or Agent edits should produce project writes.

The current DOM comparison supports selected node and timing changes. Arbitrary subtree moves such as grouping, changes to running scripts, and changes without an unambiguous mounted target can still reach a preview refresh. The design direction is to reuse existing nodes for known edits, reconcile the affected scene when local updates cannot be verified, and reserve whole-preview replacement for changes that affect the shared runtime.

A scripted template can declare the live edits that its author has tested by placing a single `<meta name="openmotion-live-edits" content="mediaTiming position" data-scripts-sha256="…">` in the entry HTML head. For `mediaTiming`, playback and visuals must remain correct when an audio clip moves and the root duration extends. For `position`, animations must remain correct when Studio changes an element's position. Check these properties against a freshly opened copy, including the end of the animation. Startup code that records an audio start or a layout offset can produce different results after an in-place edit.

The author records the digest from `previewBehaviorDigest` for the assembled project and the sorted, space-separated capabilities. It covers script tags and local script file versions. A declaration cannot certify behavior loaded dynamically after the bundle is built. A missing or unmatched declaration disables the capabilities it names. The player can still apply a verified edit to an already mounted DOM box as described below. Editing project content and maintaining project history follow the usual commands in all cases.

For an assembled child scene, Studio can move or resize an existing text or container element while its scripts continue running. Both file versions must differ only in inline `left`, `top`, `width`, or `height` pixel values. The player checks the file revision, resolves each target uniquely, and verifies each previous inline value or the matching local gesture. Studio variable overrides and the motion and manual-edit manifests disable this path because those layers also control the rendered result. A parked scene can read the new fragment when needed.

Editing the mounted box preserves the current animation and its generated child nodes. A script that measured geometry at startup keeps that measurement while the scene is running. Opening the scene from scratch runs startup again with the saved layout. Templates that need a dependent graphic to follow later size changes can observe the edited element with `ResizeObserver`. A change to the script itself uses the runtime refresh path.

### Placing a catalog component

A Studio drop submits the host composition edit and its catalog component name in one request. Missing dependencies and the host share a project version and undo entry. A stale host or failed download leaves the project unchanged. An existing dependency retains the user's edits. Remote callers can supply an edited `hostFile` to `openmotion_assets_use.install_component` for the same transaction. Omitting it deliberately installs the component for later use.

### Ordered Studio writes

Hosted Studio queues completed edits for a project in the order the user made them. It reserves a place before reading a missing file or waiting for an earlier save. The browser fetches only the direct inputs it needs. Binary dependencies require their file version. Pointer samples paint locally. The first change to a file in a packet carries its known version, or `null` for a new file. A later change to that file in the same packet points to the previous operation that wrote it. The transport sends after 100 ms of inactivity, at capacity, or one second after the first waiting edit when available. A following packet uses the previous receipt. The user can keep editing throughout. Each completed action retains its own operation ID and undo semantics.

An edit can also read a file written by an earlier step. For example, when a user edits an SVG and immediately places it on the timeline, the placement references the SVG write in the same packet or its confirmed version in the next. A subsequent replacement of the SVG by another client produces a conflict.

`POST /api/projects/:id/text-edits/batch` takes an ordered `operations` array. Each file patch needs its observed version, or `{"after":"earlier-operation-id"}` for the same file inside the batch. A compound operation affecting multiple files still commits atomically. The response identifies the successful prefix and any first rejected operation. A transport retry keeps the same payload and operation IDs. A version mismatch requires fresh validation before preparing another patch. A safe canvas replay requires the same target and evidence that the intervening change preserves its measured layout. The server never applies stale byte offsets.

The server publishes each contiguous range of confirmed revisions when the request completes. A capable peer applies small included patches against matching file versions and refreshes the affected view once. Missing bases and oversized payloads use the normal versioned read for each affected file. MCP's semantic editing entry point keeps its transaction and history behavior and remains usable with Studio closed.
