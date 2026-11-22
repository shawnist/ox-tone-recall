# How OX Tone Recall works

Notes for anyone changing the add-on. For what it does and how to use it, see [README.md](README.md).

## How it works

- **Inside LUNA on a Mac the OX is reached through OX Link.** LUNA 3.1.2 lets add-on pages
  connect only to this computer, and the OX only offers plain `ws://`, so the panel can't reach
  it directly. OX Link is a small Mac app that listens on `127.0.0.1:47474`, finds OXes by their
  network name, and passes the panel's messages to the OX. **It ships inside this add-on**
  (`link/OX Link.zip`), so installing the add-on is all a user does. When it isn't running, the
  panel shows one button, Start OX Link (in setup and in Help): LUNA opens the app from the
  add-on's folder, macOS asks once to let it find devices on the local network, and the panel
  connects by itself. OX Link sets itself to start at login. Removing the add-on
  removes OX Link with it. Outside LUNA (a browser, an older LUNA) the panel also connects
  directly, as below.
- **Why a zip.** LUNA installs an add-on's files without the mark that lets a program run, so
  an app shipped unpacked is refused by macOS ("The application OX Link can't be opened"). The
  Mac puts the mark back when it unpacks a zip. So the first Start has LUNA open
  `link/OX Link.zip`, which the Mac unpacks beside itself into `link/OX Link/` (the app and
  `version.txt`); the panel waits for `version.txt`, which it can read as one of its own files,
  then has LUNA open `link/OX Link/OX Link.app`. Later Starts open the app alone. Measured through
  LUNA on a folder installed that way: OX Link answers about a second after the click.
- **How the panel finds the folder.** A page isn't told which folder it is in, but LUNA reports
  the full path of the add-on's icon, so `link/` is looked for beside `icon.png`, then in LUNA's
  Add Ons folder under `OX Tone Recall` and `ox-tone-recall`. Each place gets its time before the
  next is tried, so two copies never start. If none starts, the zip is shown in Finder to open by
  hand. Keep `icon` in the manifest and `icon.png` beside `link/`.
- **Windows.** OX Link is a Mac app, so in LUNA on Windows the panel doesn't ask for it and tries
  the OX directly, as outside LUNA. LUNA on Windows shows add-on pages in the Chromium engine,
  loaded from a file; run that way in Chrome, the panel finds the OX and reads it directly. What
  has not been tested is LUNA on Windows itself, which could still refuse the connection. Open OX
  app is hidden there: it knows only the Mac app's place.
- Outside LUNA, the OX is reached over Wi-Fi. On first open the panel looks for it by itself (Find my OX):
  it tries common home address ranges (the range of the last address that worked first, then
  the ones whose router answers, so ranges that aren't on this network come last), asks each
  address for the OX's cab, mic and room section with one read-only web request, and connects
  to the one OX it finds, or lists several to pick from. The search uses web requests, not
  WebSockets, and avoids ranges that aren't there, because Chromium delays bursts of WebSockets
  and runs out of connections after a sweep of addresses that never answer. A page can't see this computer's own
  address, so an unusual range can be missed; then type the OX's IP address, or its network
  name such as `OX001234` (the panel adds `.local`), which stays the same when the router gives
  it a new IP. When a saved IP stops answering, the panel searches again quietly, at most every
  two minutes, and switches only when it finds exactly one OX. Pasted extras such as `http://`
  or a port are dropped, and a malformed address is explained rather than tried. A lost OX is
  retried every 10 seconds.
  Tone is read from and written to the OX's live audio engine on port 4740:
  the mixer (EQ, 1176, delay, plate, channel levels) and the cab, mic and room model. The rig
  name is read from port 4718. Speaker impedance and attenuation, outputs, Wi-Fi, firmware and
  factory reset are never written; `OxClient.set` refuses them.
- **The panel.** A line says what the OX is on, in the session's terms ("OX is on Gtr Verse's
  sound"). Below it, the tracks that use the OX and no others, each one row: the track name, a
  lamp, and Recall. The lamp answers one question, "is the OX on this sound?": On the OX, Changed
  (recalled, then changed on the OX), or unlit. A track opens to show its clips as small lines
  with the same lamp, and has Unlink track from OX Recall at the bottom. Setup (the connection) is behind ⚙, and a short guide
  (getting started, the lamp, the two buttons, clips, OX Link) is behind ? beside it. Each opens
  as a page of its own: it takes over the panel, and a lit Back button at the top left returns to
  the tracks.
- **No sound names.** A sound belongs to its track or its clip and is never named. The lamp
  compares every saved setting with the OX, so two sounds that started from the same OX rig
  never count as the same. "What changed" lists which parts of the OX differ (EQ, Cab and mics,
  Levels and so on), only when asked.
- **Linked tracks.** A track saves OX sounds only after you press Link track on it. Nothing is
  inferred from inputs. When the track selected in LUNA is an audio track that isn't linked, it
  gets a dashed row of its own at the end of the list, under "Selected in LUNA", with Not linked
  and a lit Link track button; other kinds of track (drum outputs, instruments, buses) are never
  offered. Every linked track opens, with or without clips, to show Unlink track from OX Recall,
  an underlined line of text; it keeps the track's sound and its clips' sounds, and is one undo
  step.
- **Save to track.** On the track selected in LUNA, when the OX isn't on its sound, Save to track
  stores what the OX is on now as that track's sound. It only reads the OX, and it is one undo
  step in LUNA. Dialing another sound on the OX changes the OX, not the track.
- **Clip sounds.** When a take starts recording on an OX track, the panel reads the OX and saves
  that sound with the take's audio file, so the clip keeps it through splits, trims, moves and
  copies. Clips show under their track by the name LUNA gave them. The snapshot never changes,
  even if the track's sound does. With the OX offline the clip is marked "OX was offline" and
  never filled in later. The panel has to be open while recording.
- **Recall.** Selecting and opening only show. Recall is the only action that changes the OX,
  and it is off while recording. Some OX settings hold others (with the delay's Pan Link on, Pan
  B follows Pan A), so after writing, Recall reads the OX again and writes what didn't stay, up
  to three times; anything still different is counted in its message and shown under Changed. To keep a clip's sound for its track, Recall the clip, then
  Save to track. An open track lists every clip recorded through the OX; past about six, the
  list scrolls. With the OX offline, Recall and Save to track are off and the line under the bar
  says what's wrong, with How to fix.
- **Where it's kept.** Everything is in the session's storage (LUNA 3.1.2 or later):
  `com.shawnrasson.ox-tone-recall.tracks` (one record per track: `tone`, the default, and `ox`,
  the mark) and `com.shawnrasson.ox-tone-recall.sources` (one record per recorded audio file).
  Saving and marking are each one undo step; recorded snapshots are not.
- Earlier versions saved presets in track comments as `[OX TONE v2]<base64 JSON>[/OX TONE]`
  (or v1). When a session opens, those move into storage, the block leaves the comments (other
  text is kept), and those tracks count as OX tracks.
- The panel reads the OX every 3 seconds while visible to show which sound it is on. Reading
  never changes the OX.

## Develop

```sh
npm install
npm test                       # LUNA's MockEngine and a fake OX; no hardware needed
npm run pack                   # builds ox-tone-recall.lunaaddon, with OX Link inside
```

`link/OX Link.zip` is a committed build of OX Link (the `ox-link` project's `./build.sh`), signed
ad hoc. Files that LUNA installs are not held back by macOS the way a browser download is, so the
app opens without the "Open Anyway" step; signing it with a Developer ID is still the right thing
before sharing the add-on widely. To bundle a new OX Link version, build it and run
`scripts/bundle-ox-link.sh`. Don't rebuild it otherwise: macOS ties the local network permission
to the build, so every user would be asked again. `link/OX Link/` is what the Mac unpacked on
this computer; it is not committed, and `npm run pack` sets it aside so it never ships.

`icon.png` is drawn from `scripts/icon.svg`: 512 by 512, a full square with the picture running
edge to edge. Render it again after changing the drawing.

`tests/preview/index.html?engine=mock` runs the panel on a mock session with sample presets
(serve the project folder over http on localhost; it reaches the real OX read-only until you
press Recall).

## Publishing

For the maintainer. Development happens in a separate private repo that keeps the full history.
The public repo, `shawnist/ox-tone-recall`, has its own history: it started from one clean
commit and gets one commit for each published version. The private history never goes there, so
never `git push` one of its branches to the public repo.

```sh
scripts/publish.sh "Version 0.1.1"     # the files of the commit you are on, as one new public commit
npm run pack                           # then build the package
gh release create v0.1.1 ox-tone-recall.lunaaddon -R shawnist/ox-tone-recall --title "OX Tone Recall 0.1.1"
```

UA Universe and LUNA's showcase read the public repo's latest release: the package attached to it,
and the README at its tag. Raise `version` in `manifest.json` and `package.json` first.
