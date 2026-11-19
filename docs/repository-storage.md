# Repository size and optional media

Source, template guides, small assets and browser dependencies remain in ordinary Git. README artwork and optional Library previews above 100 KB are served from immutable public R2 URLs and recorded in `repository-media.json`. Full reference/demo videos and the optional Presenter Tech `.motion` archive still use Git LFS. Registered optional media bytes, source credits and their integrity manifests are unchanged.

Local catalog reference images and gallery covers use WebP at their original dimensions. The conversion uses `cwebp -q 85 -m 6 -sharp_yuv`; source links, paths and manifest hashes describe the checked-in WebP files. Each affected template records the encoding in its provenance. Original CMS archives, source-video identities and remote-media locks remain unchanged. For new reference screenshots, prefer WebP and check small text at its intended display size before refreshing the source manifest.

Embedded documentation images must fit GitHub's 5 MB image-proxy limit. Three larger GIFs use smaller display versions while their unchanged originals remain publicly downloadable; see [display encoding and original links](readme/RESOURCES.md#retained-local-collection).

## Clone and run

```sh
git clone --depth 1 https://github.com/nexu-io/openmotion.git
cd openmotion
npm ci
npm run build:studio
npm start
```

`--depth 1` avoids downloading old history. Omit it when you need the history, or run `git fetch --unshallow` later. This migration does not rewrite shared history: a full clone still downloads the large ordinary Git objects in old commits.

The checked-in `.lfsconfig` excludes LFS downloads by default. Normal clones with Git LFS installed keep pointers until you request the media. Without Git LFS installed, pointers remain ordinary text files. GitHub and local Markdown viewers load registered public README images/GIFs directly, without CMS authentication or an LFS download. Those previews require internet access. Built-in Studio templates and repository catalog source retain their local dependencies. Linked CMS references are not made available offline.

The preview migration removes 134,065,890 bytes from the default working tree. It preserves all catalog entries and their local source assets. The WebP conversion reduces 2,008 local images from 74.2 MB to 23.0 MB without an additional download step. The Git checkout has an advisory target of 128 MiB; it includes every tracked path even when identical files share a Git blob. Exceeding that total reports a warning without blocking contributions or media cleanup. Installed dependencies, optional downloads and old history are separate from this total.

## Download only what you need

Install [Git LFS](https://git-lfs.com/), then initialize it in the checkout:

```sh
git lfs install --local
```

Choose one scope and override the default exclusion explicitly:

```sh
# Reference films for one optional Library Skill.
git lfs pull --include="library/skills/openmotion-design-remix/**" --exclude=""

# Presenter Tech archive and its full preview video.
git lfs pull --include="library/templates/presenter-tech/**" --exclude=""

# Full README reference films; public images/GIFs do not need this.
git lfs pull --include="docs/readme/**" --exclude=""

# Everything needed for complete plugin/platform bundles and resource verification.
git lfs pull --include="docs/readme/**,library/**,examples/**" --exclude="library/templates/catalog/**"
```

For a contributed catalog template, use the [template-specific pull command](template-repository.md#contribute-media-without-cms-access). LFS objects are fetched from the selected remote; reviewing a fork contribution requires the remote that holds its objects. A pointer is not playable video or an executable archive. Full bundles and Library Skill copying refuse unresolved pointers with a download command. Fetch the selected Motion Design profile before materializing it. Once fetched, those resources retain their existing offline behavior.

## Transfer merged media after review

Contributors edit their original PR normally. A new catalog video, audio file or large image/font can be committed under `<id>/source/assets/` (at most 50 MiB per file). Git LFS remains a supported input, not a required account or separate upload step. Keep small imported assets and small README artwork in ordinary Git. Raw media may temporarily remain in the merged commit; the trusted post-merge workflow transfers it immediately and creates a sanitized `main` commit.

After the content review, merge the reviewed PR through GitHub. The trusted **Publish merged template media** workflow starts from the closed merged PR and sanitizes `main` after transferring eligible media:

1. Read the current `main` tree and the event’s pre-merge PR base through the GitHub API. The event base covers all commits of merge, squash and rebase merges.
2. Prepare metadata edits without running contributor code, hooks, dependencies or `.lfsconfig`. Explicitly fetch the current head and PR base into a fresh repository for final-index validation.
3. Upload changed media and backfill unregistered `library/skills` attachments to immutable `open-motion/media/sha256/` keys in the public R2 bucket. Read the public objects back and verify their SHA-256 and sizes.
4. Push one cleanup commit to `main`, guarded by the current `main` SHA, authored by the Actions bot without a user-token lookup. Catalog media becomes `template.json.remoteAssets`; relative guide references become public URLs. Skill and other optional media is registered in `repository-media.json`, with its local path ignored by Git.
5. A dependent reusable catalog job publishes the exact successful cleanup SHA (or unchanged source SHA when there is no media). No independent merge-push publisher can race ahead. If `main` advances during upload or push, cleanup replans against the new tree, up to three attempts; a later rerun also uses current `main`.

The PR author and merged history stay unchanged. Fork write access is not needed because cleanup is pushed to `main`. Failed uploads, wrong public bytes or rejected writes leave the merge intact. Intervening main commits are preserved; repeatedly advancing heads stop after three attempts and can be retried. Failed attempts can leave harmless immutable objects in storage; reruns reuse already verified objects.

### One-time maintainer setup

- Merge this workflow into `main` to register the closed-PR Actions trigger.
- Configure the repository's normal merge policy. Cleanup uses the PR event base instead of assuming the last merged commit’s parent is the pre-merge base. It does not require contributor fork write access.
- Grant the workflow `contents: write` and configure the existing R2 release-bucket secrets and variables. Do not store a token in a checked-in file.
- The workflow reuses the existing `CLOUDFLARE_R2_RELEASES_AK` / `CLOUDFLARE_R2_RELEASES_SK` secrets and bucket/endpoint variables. It writes only under the media prefix and never publishes an application or changes installation guides. No contributor receives these credentials.

Ordinary code PRs with no eligible media, including Skill backfill, skip upload and cleanup; the dependent catalog job can still publish their exact source SHA. Fork edit permission is never needed. Template metadata/text changes still receive normal policy checks but do not upload media.

The Action starts automatically only after a PR targeting `main` is merged. There is no upload on PR open, push or approval, no contribution label, replacement PR or contributor-applied patch. Ordinary PR CI has no storage credentials. The workflow checks out only its trusted base-branch control code and reads the merged tree as data; it never executes contributor code.

For a read-only local preview of the existing media policy, use `npm run media:prepare -- <PR-number>` with GitHub CLI authentication. Production transfer and cleanup run through the trusted Action so its R2 credentials stay in Actions.

### Read and package transferred media

Catalog search and MCP detail read local source and return the public preview/poster URL. They do not download media in the background. HTML and Markdown use public asset URLs. Reading the logical source asset through the local API downloads and verifies its bounded body.

Other optional media retains its local logical path in `repository-media.json`. Fetch one scope or the complete legacy set:

```sh
npm run media:pull -- library/skills/openmotion-design-remix

# Recover original README artwork at its recorded local paths.
npm run media:pull -- docs/readme

# Restore every registered optional file for full bundles/resource verification.
npm run media:pull
```

Only those registered files are downloaded, with size/hash verification and atomic replacement. These commands do not fetch all catalog media. Legacy files still in LFS need the scoped pulls above. Full bundles and resource verification explicitly fetch both stores; npm application packages exclude showcase and optional Library payloads.

### Checks and history

Stage changes, then run `npm run templates:check` and `npm run storage:check` to validate the final tree. Ordinary Git checkout contents above 128 MiB produce an advisory warning, including the measured size, rather than a validation failure. This applies to PR CI, local checks and media preparation, including new growth. The catalog has no separate aggregate hard cap. Cleanup fetches the exact PR base and validates the cleaned index before pushing; all public media must be verified before the metadata commit is pushed. Newly staged ordinary files above 1 MiB still fail. Catalog small assets are limited to 100 KB, media files to 50 MiB and total assets per template to 150 MiB. Metadata, source manifests, canonical URLs, identities and duplicate local/remote storage are checked without downloading media.

PR CI uses `--final-tree` with the PR base to check the final merge tree after verifying Squash-only settings. Passing a base SHA to the local checkers additionally checks every intermediate branch commit; that stricter history audit intentionally rejects raw files added and later removed. It is not the merge gate for the post-merge flow. CI currently retains the repository’s Squash-only policy; cleanup itself also supports multi-commit merge/rebase events. All post-merge methods retain the original raw media in history; only the current tree is sanitized.

The existing LFS migration removes approximately 291 MB from ordinary Git, and the preview migration removes another 134 MB. Optional downloads restore those bytes locally; full clones retain old binary history. Cleanup compares current main with the selected PR base and also backfills raw Skill attachments. Unchanged legacy LFS resources outside that selection remain in LFS. The preview migration verifies each public R2 object's size and SHA-256 before removing its local Git copy. It does not rewrite history or configure branch protection. Production workflow execution and R2 writes require a merged-PR Actions run; local regression tests do not establish that activation.
