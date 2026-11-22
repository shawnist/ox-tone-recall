#!/bin/sh
# Put a built OX Link into this add-on as link/OX Link.zip, for the panel's Start OX Link button.
#
#   scripts/bundle-ox-link.sh                      from ../ox-link/build (run its ./build.sh first)
#   scripts/bundle-ox-link.sh "/path/OX Link.app"
#
# Why a zip: LUNA installs an add-on's files without the mark that lets a program run, so an app
# shipped unpacked can't be opened. The Mac puts the mark back when it unpacks a zip, so the
# panel has LUNA open the zip first and then the app that appears beside it.
#
# The zip is committed, so everyone who installs the add-on gets the same build. Only run this
# for a new OX Link version: macOS ties its "find devices on your local network" permission to
# the build, so a rebuilt app asks every user again.
set -eu
cd "$(dirname "$0")/.."
SRC="${1:-../ox-link/build/OX Link.app}"

[ -x "$SRC/Contents/MacOS/OXLink" ] || { echo "No built OX Link at $SRC" >&2; exit 1; }
codesign --verify --strict "$SRC"
mkdir -p link
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SRC/Contents/Info.plist")"
# A copy the Mac unpacked here earlier is the old version now: drop it, so the new zip gets unpacked.
if [ -d "link/OX Link" ]; then find "link/OX Link" -depth -delete; fi
# The zip holds one folder, "OX Link": the app, and version.txt, which the panel looks for to
# know the Mac has unpacked it.
STAGE="$(mktemp -d)"
mkdir "$STAGE/OX Link"
ditto "$SRC" "$STAGE/OX Link/OX Link.app"
printf 'OX Link %s\n' "$VERSION" > "$STAGE/OX Link/version.txt"
ditto -c -k --keepParent --norsrc --noextattr "$STAGE/OX Link" "link/OX Link.zip"
find "$STAGE" -depth -delete
echo "Bundled OX Link $VERSION as link/OX Link.zip"
