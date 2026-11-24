#!/usr/bin/env bash
# Exercise the release publisher against a local remote, including retries and stale runs.
set -euo pipefail
publisher=$(cd "$(dirname "$0")/../.github/scripts" && pwd)/promote-cloud-test.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git init --quiet --bare "$tmp/origin.git"
git init --quiet "$tmp/build"
cd "$tmp/build"
git config user.name test
git config user.email test@example.invalid
git remote add origin "$tmp/origin.git"
export GITHUB_REF=refs/heads/main
export GITHUB_STEP_SUMMARY="$tmp/summary"
release=refs/heads/deploy/openmotion-test
release_head() { git --git-dir="$tmp/origin.git" rev-parse "$release"; }
merge_source() {
  git commit --quiet --allow-empty -m "$1"
  GITHUB_SHA=$(git rev-parse HEAD)
  export GITHUB_SHA
  git push --quiet origin "HEAD:$GITHUB_REF"
}
promote() { bash "$publisher" "$tmp/digests"; }

merge_source first
first=$GITHUB_SHA
mkdir "$tmp/digests"
for target in api worker-media worker-render catalog-sync; do
  printf '%s' "$target" | shasum -a 256 | awk '{print "sha256:"$1}' > "$tmp/digests/$target"
done
promote
published=$(release_head)
git show "$published:release.json" | jq -e --arg revision "$first" \
  '.revision == $revision and (.images | keys == ["api","catalog-sync","worker-media","worker-render"])' >/dev/null
promote
[[ "$(release_head)" == "$published" ]]

merge_source second
second=$GITHUB_SHA
GITHUB_SHA=$first promote
[[ "$(release_head)" == "$published" ]]
echo invalid > "$tmp/digests/api"
if promote; then exit 1; fi
[[ "$(release_head)" == "$published" ]]
rm "$tmp/digests/api"
if promote; then exit 1; fi
[[ "$(release_head)" == "$published" ]]
cp "$tmp/digests/worker-media" "$tmp/digests/api"
promote
next=$(release_head)
[[ "$(git rev-parse "$next^")" == "$published" ]]
[[ "$(git show "$next:release.json" | jq -r .revision)" == "$second" ]]
GITHUB_SHA=$first promote
[[ "$(release_head)" == "$next" ]]
