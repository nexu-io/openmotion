#!/usr/bin/env bash
set -euo pipefail

source_ref=refs/heads/main
release_ref=refs/heads/deploy/openmotion-test
digests=$1

[[ "$GITHUB_REF" == "$source_ref" && "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
refs=$(git ls-remote --heads origin "$source_ref" "$release_ref")
remote_sha() { awk -v ref="$1" '$2 == ref {print $1}' <<< "$refs"; }

remote_head=$(remote_sha "$source_ref")
if [[ -z "$remote_head" ]]; then
  echo "The cloud source branch is missing." >&2
  exit 1
fi
if [[ "$remote_head" != "$GITHUB_SHA" ]]; then
  superseded=$(node "$(dirname "$0")/orbit-publish-cloud-test.mjs" --check-superseded "$source_ref" "$GITHUB_SHA" "$remote_head")
  if [[ "$superseded" == "true" ]]; then
    echo "A newer deployment-eligible merge ($remote_head) superseded $GITHUB_SHA." >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  echo "Remote head $remote_head has no deployment-eligible changes after $GITHUB_SHA; continuing promotion."
fi

# Keep the first complete set for each source SHA, including on a partial CI rerun.
parent=$(remote_sha "$release_ref")
set --
if [[ -n "$parent" ]]; then
  git fetch --depth=1 origin "$parent"
  previous=$(git show "$parent:release.json" | jq -er '.revision')
  if [[ "$previous" == "$GITHUB_SHA" ]]; then
    echo "Test release $GITHUB_SHA was already published." >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  set -- -p "$parent"
fi

images='{}'
for target in api worker-media worker-render catalog-sync; do
  digest=$(cat "$digests/$target")
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid $target digest" >&2; exit 1; }
  images=$(jq -c --arg target "$target" --arg digest "$digest" '.[$target] = $digest' <<< "$images")
done
blob=$(jq -n --arg revision "$GITHUB_SHA" --argjson images "$images" \
  '{revision: $revision, images: $images}' | git hash-object -w --stdin)
tree=$(printf '100644 blob %s\trelease.json\n' "$blob" | git mktree)
commit=$(git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit-tree "$tree" "$@" -m "Deploy $GITHUB_SHA to default test")
# A concurrent publisher cannot overwrite a release based on a stale parent.
git push origin "$commit:$release_ref"
echo "Published test release $GITHUB_SHA ($commit) for Argo CD." >> "$GITHUB_STEP_SUMMARY"
