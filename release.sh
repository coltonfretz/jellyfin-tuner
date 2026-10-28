#!/usr/bin/env bash
# Publishes the version in the .csproj as a GitHub Release and adds it to
# manifest.json, the plugin catalog Jellyfin reads (README, "Install").
# Usage: ./release.sh "What changed, one line"
#
# Needs: a clean main branch, the GitHub CLI (gh) logged in, and whatever
# build.sh needs (Docker, or BUILD_HOST). Refuses to reuse a version number:
# a catalog entry must never change once people may have installed it.
set -euo pipefail
cd "$(dirname "$0")"
CHANGELOG=${1:?usage: ./release.sh "what changed"}
REPO=coltonfretz/jellyfin-tuner
GUID=6d5e2f2a-5308-427c-9e34-42892a8fe0cc
TARGET_ABI=12.2.0.0   # the oldest Jellyfin it's built against (Jellyfin.Controller in the .csproj)
VER=$(sed -n 's#.*<AssemblyVersion>\(.*\)</AssemblyVersion>.*#\1#p' Jellyfin.Plugin.Tuner/Jellyfin.Plugin.Tuner.csproj)
TAG=v$VER

[[ -z "$(git status --porcelain)" ]] || { echo "Commit or stash your changes first."; exit 1; }
[[ "$(git branch --show-current)" == main ]] || { echo "Release from main."; exit 1; }
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1 || grep -q "\"$VER\"" manifest.json 2>/dev/null; then
  echo "$VER is already released. Bump <AssemblyVersion> in the .csproj first."; exit 1
fi

./build.sh
ZIP=dist/tuner_$VER.zip
rm -f "$ZIP"
(cd dist && zip -q -X "tuner_$VER.zip" Jellyfin.Plugin.Tuner.dll)
# Jellyfin checks the download against this before installing it.
SUM=$(md5sum "$ZIP" | cut -d' ' -f1)
URL="https://github.com/$REPO/releases/download/$TAG/tuner_$VER.zip"

python3 - "$VER" "$CHANGELOG" "$TARGET_ABI" "$URL" "$SUM" "$GUID" <<'PY'
import datetime, json, os, sys
ver, changelog, abi, url, checksum, guid = sys.argv[1:]
path = "manifest.json"
plugins = json.load(open(path)) if os.path.exists(path) else []
if not plugins:
    plugins = [{
        "guid": guid,
        "name": "Tuner",
        "description": "Radio dial and TV surf mode for the Jellyfin web UI.",
        "overview": "Live radio, Jamendo, free TV and antenna channels, rotating home rows, seasonal tiles.",
        "owner": "coltonfretz",
        "category": "General",
        "versions": [],
    }]
plugins[0]["versions"].insert(0, {
    "version": ver,
    "changelog": changelog,
    "targetAbi": abi,
    "sourceUrl": url,
    "checksum": checksum,
    "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
})
with open(path, "w") as f:
    json.dump(plugins, f, indent=2)
    f.write("\n")
PY

# The release (with the zip) goes up before the catalog points at it, so the
# catalog never lists a download that doesn't exist yet.
gh release create "$TAG" "$ZIP" -R "$REPO" --title "Tuner $VER" --notes "$CHANGELOG"
git add manifest.json
# COMMIT_TRAILER (optional) is added to the commit message, e.g. a Co-Authored-By line.
git commit -q -m "Release $VER: $CHANGELOG" ${COMMIT_TRAILER:+-m "$COMMIT_TRAILER"}
git push -q
echo "Released $VER: $URL"
