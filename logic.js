// OX Tone Recall: logic that does not touch the DOM, so tests can exercise it against
// Luna.MockEngine and a fake OX.
//
// A track's OX tone is saved in the session's storage (LUNA 3.1.2 and later): context
// STORAGE_CONTEXT, one record per track id, holding the tone in one field, FIELD. It travels
// inside the session, is hidden from the user, and every save, rename and remove is one undo
// step in LUNA. The whole tone is one value on purpose: one write is one undo step.
//
// Earlier versions kept the tone in the track's comments, between TAG_OPEN and TAG_CLOSE.
// migrateComments moves those into storage and takes the block out of the comments, keeping
// any other comment text. v2 blocks are base64 (LUNA escapes quote marks in comments); v1
// blocks, escaped or not, are still read.
const STORAGE_CONTEXT = 'com.shawnrasson.ox-tone-recall.tracks';
const FIELD = 'tone';
// A track is an OX track only when marked (field MARK_FIELD true). Records saved before marking
// existed have a tone and no mark: having a saved default counts as marked.
const MARK_FIELD = 'ox';
// Recorded tones, one record per recorded audio file (a clip's source uid), so a clip keeps its
// tone through splits, trims, moves and copies. The value is a tone body, or { unknown: true }
// for a take recorded while the OX was offline. A snapshot is written once and never replaced.
const SOURCES_CONTEXT = 'com.shawnrasson.ox-tone-recall.sources';
const TAG_OPEN = '[OX TONE v2]';
const TAG_CLOSE = '[/OX TONE]';
const BLOCK = /\[OX TONE v([12])\]([\s\S]*?)\[\/OX TONE\]/;
const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0)));
const PREFIXES = [['/mixers/0/', 'm:'], ['/device/inputs/cabinet_mic_room/', 'c:']];
const SEGMENTS = [['/controls/', '/~'], ['/effects/', '/@']];

const AddOnLogic = {
  TAG_OPEN,
  TAG_CLOSE,
  STORAGE_CONTEXT,
  FIELD,
  MARK_FIELD,
  SOURCES_CONTEXT,

  /**
   * Read what someone typed as the OX's address. Accepts an IPv4 address or a host name
   * (such as a .local name), and forgives a pasted scheme, port, path or spaces.
   * Returns { host } or { error } with a sentence to show.
   */
  parseOxAddress(text) {
    let s = String(text ?? '').trim().toLowerCase();
    const example = 'It should look like 192.168.1.40 or OX001234.';
    if (!s) return { error: "Enter your OX's IP address or name, for example 192.168.1.40 or OX001234." };
    s = s.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d*$/, '').replace(/\.$/, '');
    if (/^[\d.]+$/.test(s)) {
      const parts = s.split('.');
      const ok = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
      return ok ? { host: parts.map(Number).join('.') } : { error: `${text.trim()} isn't a complete IP address. ${example}` };
    }
    const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    if (s.length <= 253 && s.split('.').every((l) => label.test(l))) {
      // A bare name like OX001234 is the OX's network name: it answers as OX001234.local.
      return { host: s.includes('.') ? s : `${s}.local` };
    }
    return { error: `${text.trim()} doesn't look like an address. ${example}` };
  },

  /** Shorten an OX path for storage. Reversible with expandKey. */
  shortKey(path) {
    let k = path;
    for (const [long, short] of PREFIXES) if (k.startsWith(long)) { k = short + k.slice(long.length); break; }
    for (const [long, short] of SEGMENTS) k = k.split(long).join(short);
    return k;
  },

  expandKey(key) {
    let p = key;
    for (const [long, short] of PREFIXES) if (p.startsWith(short)) { p = long + p.slice(short.length); break; }
    for (const [long, short] of SEGMENTS) p = p.split(short).join(long);
    return p;
  },

  /** A tone as it is stored: short keys, values rounded to 7 places. */
  toBody(tone) {
    const short = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [AddOnLogic.shortKey(k), typeof v === 'number' ? Math.round(v * 1e7) / 1e7 : v]));
    return { n: tone.name ?? null, rig: tone.rig ?? null, at: tone.at, v: short(tone.values), p: short(tone.plugins || {}) };
  },

  /** A stored body back to a tone, or null when it isn't one. */
  fromBody(body) {
    if (!body || typeof body !== 'object' || !body.v || typeof body.v !== 'object') return null;
    const long = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [AddOnLogic.expandKey(k), v]));
    return { name: body.n ?? null, rig: body.rig ?? null, at: body.at ?? null, values: long(body.v), plugins: long(body.p) };
  },

  /** The legacy text block for a track's comments. Only tests write these now. */
  encodeTone(tone) {
    return `${TAG_OPEN}${toBase64(JSON.stringify(AddOnLogic.toBody(tone)))}${TAG_CLOSE}`;
  },

  /** The tone saved in some comments text, or null. */
  decodeTone(comments) {
    if (typeof comments !== 'string') return null;
    const match = comments.match(BLOCK);
    if (!match) return null;
    const [, version, payload] = match;
    try {
      return AddOnLogic.fromBody(version === '2' ? JSON.parse(fromBase64(payload)) : AddOnLogic.parseV1(payload));
    } catch {
      return null;
    }
  },

  /** A v1 block's JSON, as written or as LUNA hands it back with quotes escaped. */
  parseV1(payload) {
    try {
      return JSON.parse(payload);
    } catch {
      return JSON.parse(payload.replace(/\\(["\\])/g, '$1'));
    }
  },

  /** The comments text with the tone block replaced (or removed when tone is null). */
  withTone(comments, tone) {
    let text = typeof comments === 'string' ? comments : '';
    text = text.replace(BLOCK, '').trim();
    if (!tone) return text;
    return text ? `${text}\n${AddOnLogic.encodeTone(tone)}` : AddOnLogic.encodeTone(tone);
  },

  /** Paths whose values differ between a saved tone and the OX now. */
  diffTone(saved, current, tolerance = 1e-4) {
    if (!saved || !current) return [];
    return Object.keys(saved.values).filter((k) => k in current.values && Math.abs(saved.values[k] - current.values[k]) > tolerance);
  },

  /** The session's OX tone storage. The SDK hands back the same object each time. */
  store(session) {
    return session.storage.context(STORAGE_CONTEXT);
  },

  /** Fetch the session's stored tones. Call once per session before reading them. */
  async loadStore(session) {
    await AddOnLogic.store(session).load();
  },

  /**
   * A track's saved tone, or null. Existence comes from the record list: after a record is
   * removed, its last value can still be read.
   */
  trackTone(session, track) {
    const store = AddOnLogic.store(session);
    if (!track || !(store.records.value ?? []).includes(track.id)) return null;
    return AddOnLogic.fromBody(store.value(track.id, FIELD).value);
  },

  /**
   * Write one field, adding it when it doesn't exist yet. Fields are never removed (a removed
   * field's last value can still be read), so "exists" is "has a value".
   */
  async put(store, record, field, value, options) {
    const exists = (store.records.value ?? []).includes(record) && store.value(record, field).value !== undefined;
    if (exists) await store.set(record, field, value, options);
    else await store.add(record, field, value, options);
  },

  /** Save a tone as a track's default, as one undo step unless `undoable` is false. */
  async writeTrackTone(session, track, tone, { undoable = true } = {}) {
    await AddOnLogic.put(AddOnLogic.store(session), track.id, FIELD, AddOnLogic.toBody(tone), { undoable });
  },

  /** Whether a track is marked as recorded through the OX. */
  isOxTrack(session, track) {
    const store = AddOnLogic.store(session);
    if (!track || !(store.records.value ?? []).includes(track.id)) return false;
    const mark = store.value(track.id, MARK_FIELD).value;
    return typeof mark === 'boolean' ? mark : !!AddOnLogic.trackTone(session, track);
  },

  /** Mark or unmark a track as an OX track, as one undo step. Its default and clips are kept. */
  async markTrack(session, track, on) {
    await AddOnLogic.put(AddOnLogic.store(session), track.id, MARK_FIELD, !!on, { undoable: true });
  },

  /** The session's recorded-tone storage. */
  sources(session) {
    return session.storage.context(SOURCES_CONTEXT);
  },

  /**
   * The tone recorded with an audio file: a tone, `{ unknown: true, at }` when the OX was
   * offline, or null when nothing was saved with it.
   */
  sourceTone(session, sourceUid) {
    const store = AddOnLogic.sources(session);
    if (!sourceUid || !(store.records.value ?? []).includes(sourceUid)) return null;
    const body = store.value(sourceUid, FIELD).value;
    if (body?.unknown) return { unknown: true, at: body.at ?? null };
    return AddOnLogic.fromBody(body);
  },

  /** Save what a recording was made with, once. Returns false when it already had one. */
  async writeSourceTone(session, sourceUid, toneOrUnknown) {
    const store = AddOnLogic.sources(session);
    if ((store.records.value ?? []).includes(sourceUid)) return false;
    const body = toneOrUnknown?.unknown ? { unknown: true, at: toneOrUnknown.at ?? new Date().toISOString() } : AddOnLogic.toBody(toneOrUnknown);
    await store.add(sourceUid, FIELD, body, { undoable: false });
    return true;
  },

  /**
   * What to call the OX's sound: the name of a track default it matches exactly, else the OX
   * rig name, with "(edited)" when a default already uses that name for a different sound.
   */
  nameFor(session, live, rig) {
    const defaults = (session.tracks.items ?? session.visibleTracks).map((t) => AddOnLogic.trackTone(session, t)).filter(Boolean);
    if (live) {
      const match = defaults.find((tone) => AddOnLogic.sameTone(tone, live));
      if (match) return AddOnLogic.displayName(match);
    }
    const name = rig || 'OX sound';
    return defaults.some((tone) => AddOnLogic.displayName(tone) === name) ? `${name} (edited)` : name;
  },

  /** True when every saved control matches (within tolerance) and the plug-ins are the same. */
  sameTone(a, b, tolerance = 1e-4) {
    if (!a || !b || a.unknown || b.unknown) return false;
    const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)]);
    for (const k of keys) {
      if (!(k in a.values) || !(k in b.values) || Math.abs(a.values[k] - b.values[k]) > tolerance) return false;
    }
    for (const k of new Set([...Object.keys(a.plugins || {}), ...Object.keys(b.plugins || {})])) {
      if ((a.plugins || {})[k] !== (b.plugins || {})[k]) return false;
    }
    return true;
  },

  /**
   * Which parts of the OX differ between two tones, in words, for "differs from the track
   * default": the cab and mics, each effect by its plug-in, levels and the rest.
   */
  differences(a, b, tolerance = 1e-4) {
    const PLUGINS = { cambridge: 'EQ', '1176': 'Compressor', precision_delay: 'Delay', emt_140: 'Plate reverb', cmr: 'Cab and mics' };
    const area = (path, plugins) => {
      const slot = path.includes('/controls/') ? path.slice(0, path.indexOf('/controls/')) : path;
      const plugin = plugins?.[slot] || '';
      for (const [key, label] of Object.entries(PLUGINS)) if (plugin.includes(key)) return label;
      if (path.startsWith('/device/inputs/cabinet_mic_room/')) return 'Cab and mics';
      if (/\/(channels|buses)\/[^/]+\/controls\//.test(path)) return 'Levels';
      return 'Other settings';
    };
    const out = new Set();
    const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)]);
    for (const k of keys) {
      const x = a.values[k], y = b.values[k];
      if (x === undefined || y === undefined || Math.abs(x - y) > tolerance) out.add(area(k, { ...b.plugins, ...a.plugins }));
    }
    for (const k of new Set([...Object.keys(a.plugins || {}), ...Object.keys(b.plugins || {})])) {
      if ((a.plugins || {})[k] !== (b.plugins || {})[k]) out.add(area(`${k}/controls/x`, { [k]: (a.plugins || {})[k] || (b.plugins || {})[k] }));
    }
    return [...out];
  },

  /**
   * Take the OX's sound for a take as it starts recording, on an OX track only, and save it
   * with the file being recorded unless that file already has one. With the OX unreachable the
   * snapshot is "unknown", never guessed. Returns the snapshot (keep it for settleTake), or
   * null when the track isn't an OX track or LUNA hasn't named the file yet.
   */
  async captureTake(session, take, ox, { rig } = {}) {
    const track = session.tracks.byId(take.trackUid.value);
    const sourceUid = take.sourceUid.value;
    if (!track || !sourceUid || !AddOnLogic.isOxTrack(session, track)) return null;
    let saved = { unknown: true, at: new Date().toISOString() };
    if (ox.connected) {
      try {
        const { values, plugins } = await ox.readTone();
        let name = rig ?? null;
        try { name = (await ox.readRigName()) ?? name; } catch { /* the rig name is only a label */ }
        const tone = { values, plugins, at: new Date().toISOString() };
        saved = { ...tone, name: AddOnLogic.nameFor(session, tone, name), rig: name };
      } catch { /* lost the OX mid-read: unknown */ }
    }
    await AddOnLogic.writeSourceTone(session, sourceUid, saved);
    return saved;
  },

  /**
   * After a take finishes: if LUNA filed the new clip under a different audio file than the one
   * being recorded, save the take's snapshot with that file too. The clip is the one starting
   * where the take did on its track, preferring one whose file has no tone yet (an older take
   * at the same spot keeps its own).
   */
  async settleTake(session, { trackUid, sourceUid, start, saved }) {
    if (!saved) return null;
    const track = session.tracks.byId(trackUid);
    const clips = (track && session.playlistFor(track)?.clips.items.filter((c) => c.start.value === start && c.sourceUid.value)) ?? [];
    if (clips.some((c) => c.sourceUid.value === sourceUid)) return null;
    const clip = clips.find((c) => !AddOnLogic.sourceTone(session, c.sourceUid.value));
    if (!clip) return null;
    await AddOnLogic.writeSourceTone(session, clip.sourceUid.value, saved);
    return clip.sourceUid.value;
  },

  /**
   * The clip LUNA has selected: a click on a clip selects exactly its range on its track
   * (selection start and stop, one selected track). Returns { track, clip } or null when the
   * selection isn't one clip on the focused track.
   */
  selectedClip(session) {
    const ctx = session.context;
    const start = ctx.selectionStart.value, stop = ctx.selectionStop.value, tracks = ctx.selectionTracks.value;
    if (start == null || stop == null || stop <= start || !Array.isArray(tracks) || tracks.length !== 1) return null;
    const focused = session.focusedTrack.value;
    if (focused && focused.id !== tracks[0]) return null;
    const track = session.tracks.byId(tracks[0]);
    const clips = track ? session.playlistFor(track)?.clips.items ?? [] : [];
    const under = clips.filter((c) => c.start.value <= start && c.stop.value >= stop);
    if (!under.length) return null;
    const clip = under.reduce((best, c) => ((c.layer?.value ?? 0) > (best.layer?.value ?? 0) ? c : best));
    return { track, clip };
  },

  /**
   * The clips on a track's active playlist, in timeline order, each with its name as LUNA shows
   * it and the tone saved with its audio file (a tone, `{ unknown: true }`, or null).
   */
  trackClips(session, track) {
    const clips = (track && session.playlistFor(track)?.clips.items) ?? [];
    return clips.filter((c) => c.sourceUid.value)
      .map((clip) => ({ clip, name: clip.name.value || 'Clip', sourceUid: clip.sourceUid.value, tone: AddOnLogic.sourceTone(session, clip.sourceUid.value) }))
      .sort((a, b) => (a.clip.start.value ?? 0) - (b.clip.start.value ?? 0));
  },

  /**
   * What the OX is on, in the session's own terms. An OX track whose sound it matches comes
   * first, then a clip whose recorded sound it matches. Failing both, the track or clip that
   * Recall last sent (`lastLoaded`: 'track:<id>' or 'source:<uid>') is reported as `changed`.
   * Returns { kind: 'track' | 'clip' | 'none', name, changed }, or null before the OX is read.
   */
  oxNow(session, live, lastLoaded = null) {
    if (!live) return null;
    const tracks = session.visibleTracks.filter((t) => AddOnLogic.isOxTrack(session, t));
    const nameOf = (t) => t.name.value ?? t.id;
    const on = tracks.find((t) => AddOnLogic.sameTone(AddOnLogic.trackTone(session, t), live));
    if (on) return { kind: 'track', name: nameOf(on), changed: false };
    const clips = tracks.flatMap((t) => AddOnLogic.trackClips(session, t));
    const loaded = String(lastLoaded ?? '');
    const loadedClip = loaded.startsWith('source:') ? clips.find((c) => c.sourceUid === loaded.slice(7)) : null;
    const onClip = [loadedClip, ...clips].find((c) => c && AddOnLogic.sameTone(c.tone, live));
    if (onClip) return { kind: 'clip', name: onClip.name, changed: false };
    if (loadedClip?.tone && !loadedClip.tone.unknown) return { kind: 'clip', name: loadedClip.name, changed: true };
    const loadedTrack = loaded.startsWith('track:') ? tracks.find((t) => t.id === loaded.slice(6)) : null;
    if (loadedTrack && AddOnLogic.trackTone(session, loadedTrack)) return { kind: 'track', name: nameOf(loadedTrack), changed: true };
    return { kind: 'none', name: null, changed: false };
  },

  /** The name shown for a saved tone: the one given in LUNA, else the OX rig it came from. */
  displayName(tone) {
    return tone?.name || tone?.rig || 'Untitled tone';
  },

  /** Read the OX and save its tone on the track under a name. */
  async captureToTrack(session, track, ox, name) {
    const { values, plugins } = await ox.readTone();
    let rig = null;
    try { rig = await ox.readRigName(); } catch { /* the rig name is only a label */ }
    const tone = { name: name?.trim() || null, rig, at: new Date().toISOString(), values, plugins };
    await AddOnLogic.writeTrackTone(session, track, tone);
    return tone;
  },

  /** Rename a track's saved tone without touching its settings. False when it has none. */
  async renameTone(session, track, name) {
    const tone = AddOnLogic.trackTone(session, track);
    if (!tone) return false;
    await AddOnLogic.writeTrackTone(session, track, { ...tone, name: name?.trim() || null });
    return true;
  },

  /** Send a track's saved tone to the OX. Null when the track has none. */
  async recallTrack(session, track, ox) {
    const tone = AddOnLogic.trackTone(session, track);
    if (!tone) return null;
    return ox.writeTone(tone);
  },

  /**
   * Clear a track's default, as one undo step, keeping its OX mark. The field is set to null
   * rather than removed (see put). False when it has none.
   */
  async removeTone(session, track) {
    if (!AddOnLogic.trackTone(session, track)) return false;
    await AddOnLogic.store(session).set(track.id, FIELD, null, { undoable: true });
    return true;
  },

  /** The marked OX tracks in LUNA's order, each with its default (or null) and whether the OX is on it. */
  oxTracks(session, live = null) {
    return session.visibleTracks.filter((t) => AddOnLogic.isOxTrack(session, t)).map((track) => {
      const tone = AddOnLogic.trackTone(session, track);
      return { id: track.id, track: track.name.value ?? track.id, name: tone ? AddOnLogic.displayName(tone) : null, onOx: !!(tone && live && AddOnLogic.sameTone(tone, live)) };
    });
  },

  /**
   * Move presets saved in track comments by earlier versions into session storage, then take
   * the block out of the comments, keeping the rest of their text. A track that already has a
   * stored preset keeps it and only loses the old block. The block is removed only after the
   * stored copy reads back, and the move is not an undo step. Returns how many moved.
   */
  async migrateComments(session) {
    let moved = 0;
    for (const track of session.tracks.items ?? session.visibleTracks) {
      const legacy = AddOnLogic.decodeTone(track.comments.value);
      if (!legacy) continue;
      if (!AddOnLogic.trackTone(session, track)) {
        await AddOnLogic.writeTrackTone(session, track, legacy, { undoable: false });
        if (!AddOnLogic.trackTone(session, track)) continue; // didn't land: keep the comments as they are
        moved++;
      }
      await track.comments.set(AddOnLogic.withTone(track.comments.value, null));
    }
    return moved;
  },

  /**
   * The session's presets, one per track that has one, in LUNA's track order. Given the OX's
   * current tone, each says whether the OX is on it now (`onOx`), and the one last recalled
   * says `edited` when the OX has since moved away from it.
   */
  presets(session, live = null, lastRecalledId = null) {
    const list = session.visibleTracks.flatMap((track) => {
      const tone = AddOnLogic.trackTone(session, track);
      if (!tone) return [];
      const drift = live ? AddOnLogic.diffTone(tone, live).length : null;
      return [{ id: track.id, track: track.name.value ?? track.id, name: AddOnLogic.displayName(tone), rig: tone.rig, at: tone.at, onOx: drift === 0, drift }];
    });
    for (const p of list) p.edited = !p.onOx && p.id === lastRecalledId && p.drift != null && !list.some((q) => q.onOx);
    return list;
  },
};

globalThis.AddOnLogic = AddOnLogic;
