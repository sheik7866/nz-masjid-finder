#!/bin/sh
# Mirror the deployable site into docs/ for GitHub Pages (serves /docs on main).
# Usage: sh scripts/sync_docs.sh && git add docs && git commit -m "..." && git push
set -e
cd "$(dirname "$0")/.."
rm -rf docs
cp -r public docs
echo "docs/ synced ($(find docs -type f | wc -l) files)"
