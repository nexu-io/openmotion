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
  local message=$1
  local relpath=${2:-src/app.ts}
  mkdir -p "$(dirname "$relpath")"
  printf '%s\n' "$message" >> "$relpath"
  git add "$relpath"
  git commit --quiet -m "$message"
  GITHUB_SHA=$(git rev-parse HEAD)
  export GITHUB_SHA
  git push --quiet origin "HEAD:$GITHUB_REF"
}
promote() { bash "$publisher" "$tmp/digests"; }

merge_source first src/app.ts
first=$GITHUB_SHA
git clone --quiet --depth=1 --branch main "file://$tmp/origin.git" "$tmp/shallow"
mkdir "$tmp/digests"
for target in api worker-media worker-render catalog-sync; do
  printf '%s' "$target" | shasum -a 256 | awk '{print "sha256:"$1}' > "$tmp/digests/$target"
done

# Excluded-path commit landing ahead of a running deployment must not supersede first.
merge_source docs1 README.md
(cd "$tmp/shallow" && GITHUB_SHA=$first promote)
published=$(release_head)
git --git-dir="$tmp/origin.git" show "$published:release.json" | jq -e --arg revision "$first" \
  '.revision == $revision and (.images | keys == ["api","catalog-sync","worker-media","worker-render"])' >/dev/null
(cd "$tmp/shallow" && GITHUB_SHA=$first promote)
[[ "$(release_head)" == "$published" ]]

merge_source second src/app.ts
second=$GITHUB_SHA
(cd "$tmp/shallow" && GITHUB_SHA=$first promote)
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
[[ "$(git --git-dir="$tmp/origin.git" rev-parse "$next^")" == "$published" ]]
[[ "$(git --git-dir="$tmp/origin.git" show "$next:release.json" | jq -r .revision)" == "$second" ]]
merge_source docs2 docs/guide.md
GITHUB_SHA=$second promote
[[ "$(release_head)" == "$next" ]]
GITHUB_SHA=$first promote
[[ "$(release_head)" == "$next" ]]
