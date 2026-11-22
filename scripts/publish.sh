#!/bin/sh
# Publish the files of the commit you are on to the public repo, as one new commit there.
#
#   scripts/publish.sh "Version 0.1.1"
#
# The public repo has its own history, which started from one clean commit. This script only
# ever sends a commit it makes itself, whose parent is the public repo's latest commit, so the
# history of this repo never goes there. Nothing is published until you run it.
set -eu
PUBLIC_URL="https://github.com/shawnist/ox-tone-recall.git"
cd "$(dirname "$0")/.."

MESSAGE="${1:?Give the message for the public commit, for example: scripts/publish.sh \"Version 0.1.1\"}"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit your changes first: only committed files are published." >&2; exit 1; }

TREE="$(git rev-parse 'HEAD^{tree}')"
if git fetch -q "$PUBLIC_URL" main 2>/dev/null; then
  PARENT="$(git rev-parse FETCH_HEAD)"
  [ "$TREE" != "$(git rev-parse "$PARENT^{tree}")" ] || { echo "Nothing new to publish: the public repo already has these files."; exit 0; }
  COMMIT="$(printf '%s\n' "$MESSAGE" | git commit-tree "$TREE" -p "$PARENT")"
else
  # The public repo has no commits yet: this is its first.
  COMMIT="$(printf '%s\n' "$MESSAGE" | git commit-tree "$TREE")"
fi
git push "$PUBLIC_URL" "$COMMIT:refs/heads/main"
echo "Published as one commit: $MESSAGE"
