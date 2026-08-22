#!/usr/bin/env bash
#
# push-split.sh — push commits to the remote ONE AT A TIME.
#
# Walks the local branch history and pushes each unpushed commit individually
# (oldest first) with `git push <remote> <sha>:<branch>`, so the server
# receives them incrementally instead of in one large push.
#
# Usage:
#   ./push-split.sh                # push unpushed commits on the current branch to origin
#   ./push-split.sh -r myremote    # use a different remote (default: origin)
#   ./push-split.sh -b main        # target a different remote branch (default: current branch name)
#   ./push-split.sh -n             # dry run: list what would be pushed, push nothing
#   ./push-split.sh -f             # force-push each step (use with care)
#
set -euo pipefail

REMOTE="origin"
BRANCH=""
DRY_RUN=0
FORCE=""

while getopts "r:b:nfh" opt; do
  case "$opt" in
    r) REMOTE="$OPTARG" ;;
    b) BRANCH="$OPTARG" ;;
    n) DRY_RUN=1 ;;
    f) FORCE="--force-with-lease" ;;
    h)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option. Run with -h for help." >&2; exit 2 ;;
  esac
done

# Default branch = the current local branch.
if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git symbolic-ref --short HEAD)"
fi

echo "Remote : $REMOTE ($(git remote get-url "$REMOTE"))"
echo "Branch : $BRANCH"
echo

# Make sure we know the remote's current state.
git fetch --quiet "$REMOTE" "$BRANCH" 2>/dev/null || true

REMOTE_REF="refs/remotes/$REMOTE/$BRANCH"

# Build the list of commits to push, oldest -> newest.
if git rev-parse --verify --quiet "$REMOTE_REF" >/dev/null; then
  RANGE="$REMOTE_REF..HEAD"
else
  echo "Remote branch '$BRANCH' not found on '$REMOTE' — pushing entire history."
  RANGE="HEAD"
fi

COMMITS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && COMMITS+=("$line")
done < <(git rev-list --reverse "$RANGE")

if [[ ${#COMMITS[@]} -eq 0 ]]; then
  echo "Nothing to push — '$REMOTE/$BRANCH' is already up to date."
  exit 0
fi

echo "${#COMMITS[@]} commit(s) to push, one at a time:"
for sha in "${COMMITS[@]}"; do
  echo "  $(git log -1 --format='%h %s' "$sha")"
done
echo

if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run — nothing pushed."
  exit 0
fi

i=0
for sha in "${COMMITS[@]}"; do
  i=$((i + 1))
  echo ">>> [$i/${#COMMITS[@]}] pushing $(git log -1 --format='%h %s' "$sha")"
  git push $FORCE "$REMOTE" "$sha:refs/heads/$BRANCH"
  echo
done

echo "Done — pushed ${#COMMITS[@]} commit(s) to $REMOTE/$BRANCH."
