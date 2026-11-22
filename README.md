# OX Tone Recall

Every part you record through the OX Amp Top Box keeps the sound it was recorded with. Come back to a song weeks later, or punch in on an old take, and one press puts that sound back on the OX.

You still dial sounds in on the OX or in the OX app. The panel saves them with each track and each clip, shows which sound the OX is on right now, and recalls one when you press Recall.

## What you need

- An OX Amp Top Box, switched on and on the same network as your Mac.
- LUNA 3.1.2 or later.
- A Mac running macOS 13 or later. Windows has not been tested.

## Install

1. Download `ox-tone-recall.lunaaddon` from the [latest release](https://github.com/shawnist/ox-tone-recall/releases/latest).
2. Double-click it. LUNA asks whether to add OX Tone Recall; say yes.
3. In LUNA, open **Add Ons › Browsers › OX Tone Recall**.

## The first time

The panel needs a small helper called **OX Link** to reach your OX. LUNA only lets an Add On talk to your own Mac, and OX Link passes the panel's messages on to the OX. It comes with the Add On, so there is nothing else to download.

1. The panel says OX Link isn't running. Press **Start OX Link**.
2. macOS asks whether OX Link may find devices on your local network. Click **Allow**.
3. OX Link appears in the menu bar, finds your OX, and the panel connects.

After that OX Link starts when you log in. Its menu shows the OX it found and lets you turn Start at Login off, or quit.

## Using it

**Link a track.** Select your guitar track in LUNA. It appears in the panel in a dashed row marked Not linked. Press **Link track**. The track joins the list, and the sound the OX is on is saved as that track's sound.

**Record.** Every clip you record on a linked track keeps the sound the OX was on at that moment. Keep the panel open while you record.

**Read the lamp.** Each track and clip has a lamp that answers one question: is the OX on this sound?

- **On the OX**: the OX is on exactly this sound.
- **Changed**: you recalled this sound, then changed something on the OX. **What changed** lists which parts differ.
- **Unlit**: the OX is on something else.

**Recall.** Puts a track's or a clip's sound back on the OX. It is the only thing in the panel that changes the OX, and it is switched off while you record.

**Save to track.** Keeps what the OX is on now as the sound of the selected track. LUNA's Undo reverses it.

**Clips.** Click a track's name to open it and see its clips, each with the sound it was recorded with. To punch in on an old part, press Recall on that clip first.

**Unlink a track.** Open the track and press **Unlink track from OX Recall**. Its saved sounds are kept.

There is a short guide inside the panel too, behind the **?** button.

## What it changes, and what it never touches

- Only **Recall** writes to the OX. It sets the tone: the EQ, compressor, delay, reverb, channel levels, and the cabinet, microphone and room choices.
- It never changes speaker impedance or attenuation, outputs, Wi-Fi, firmware, or anything that resets the OX.
- Your saved sounds live inside the LUNA session, so they travel with it.
- OX Link listens only on your own Mac, connects only to an OX it found on your network, and sends nothing to the internet.

## If something isn't working

- **"OX Link isn't running."** Press How to fix, then Start OX Link.
- **OX Link is running but the panel can't reach the OX.** Check the OX is on and on the same network as your Mac. OX Link's menu shows the OX it has found. If you clicked Don't Allow earlier, turn OX Link on in System Settings › Privacy & Security › Local Network.
- **The panel can't find your OX by itself.** Open Setup (the gear) and type the OX's name, such as `OX001234`, or its IP address.
- **A clip says "OX was offline".** The OX couldn't be reached when that clip was recorded, so no sound was saved with it.

## Removing it

Remove OX Tone Recall in LUNA's settings, under Add Ons. OX Link lives inside the Add On, so it goes too. Quit OX Link from its menu-bar icon first.

## For developers

How the Add On works, and how to build and test it, is in [DEVELOPING.md](DEVELOPING.md).

## License

MIT. See [LICENSE](LICENSE). The Add On includes Universal Audio's LUNA Builder SDK, which is licensed under the Apache License 2.0; see [NOTICE](NOTICE).

OX, LUNA and Universal Audio are trademarks of Universal Audio, Inc.
