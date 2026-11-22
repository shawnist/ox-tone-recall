// Runs against Luna.MockEngine and a fake OX: no LUNA or OX needed. `npm test`.
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js and ox.js are classic scripts that read globals
await import('../ox.js');
await import('../logic.js');
const logic = globalThis.AddOnLogic;
const OxClient = globalThis.OxClient;

const EQ = '/mixers/0/buses/master/effects/0';
const CAB = '/device/inputs/cabinet_mic_room/effects/0';

/** A stand-in OX that speaks the same text protocol over a fake socket. */
class FakeOx {
  constructor() {
    this.values = {
      [`${EQ}/controls/hf_freq`]: 0.5316162109375,
      [`${EQ}/controls/hf_gain`]: 0.4072265625,
      '/mixers/0/channels/mic_1/controls/gain': 0.7763636708259583,
      '/mixers/0/channels/mic_1/controls/solo': 0,
      [`${CAB}/controls/cabinet`]: 0.8409090909090909,
      '/device/inputs/cabinet_mic_room/controls/gain': 0.8563636541366577,
    };
    this.plugins = { [EQ]: 'uaudio_cambridge', [CAB]: 'uaudio_cmr' };
    this.writes = [];
    this.rig = 'Another BrickIsh Console Amp Squash';
  }

  socket(url) {
    const fake = this;
    const ws = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      close() { ws.readyState = 3; ws.onclose?.(); },
      send(line) { setTimeout(() => ws.onmessage?.({ data: JSON.stringify(fake.answer(url, line)) })); } };
    setTimeout(() => { ws.readyState = 1; ws.onopen?.(); });
    return ws;
  }

  answer(url, line) {
    const [head, ...rest] = line.split(' ');
    const [path, query] = rest[0].split('?');
    const params = Object.fromEntries(new URLSearchParams(query));
    params.message_id = Number(params.message_id);
    const reply = (data, error) => ({ path, parameters: params, ...(error ? { error, data: null } : { data }) });
    if (url.endsWith(':4718')) {
      if (path === '/devices') return reply({ children: [{ path: 'uid1' }] });
      return reply({ properties: { preset_name: { value: this.rig } } });
    }
    if (head === 'set') {
      const control = path.replace(/\/normalized_value\/value\/$/, '');
      if (!(control in this.values)) return reply(null, 'Unable to resolve path');
      this.values[control] = JSON.parse(rest[1]);
      this.writes.push(control);
      this.afterSet?.(this.values, control); // what the OX itself does after a write, such as a link holding a control
      return reply(this.values[control]);
    }
    return reply(this.tree(path));
  }

  tree(root) {
    const node = { children: [] };
    const child = (parent, name) => {
      let c = parent.children.find((x) => x.path === name);
      if (!c) parent.children.push((c = { path: name, children: [] }));
      return c;
    };
    const add = (path, props) => {
      if (!path.startsWith(root + '/')) return;
      let n = node;
      for (const seg of path.slice(root.length + 1).split('/')) n = child(n, seg);
      n.properties = props;
    };
    for (const [slot, id] of Object.entries(this.plugins)) add(slot, { plugin_id: id });
    for (const [path, v] of Object.entries(this.values)) add(path, { normalized_value: v });
    return node;
  }
}

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Gtr Verse', 'Gtr Chorus', 'Bass'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.tracks.membersReady();
  await logic.loadStore(session);
  const fake = new FakeOx();
  const ox = new OxClient({ socketFactory: (url) => fake.socket(url), timeoutMs: 500 });
  await ox.connect('ox.test');
  return { engine, session, fake, ox };
}

describe('OX address', () => {
  const parse = (text) => logic.parseOxAddress(text);

  it('accepts IP addresses and host names, forgiving pasted extras', () => {
    expect(parse('192.168.1.40')).toEqual({ host: '192.168.1.40' });
    expect(parse('  10.0.0.59 ')).toEqual({ host: '10.0.0.59' });
    expect(parse('http://192.168.1.40:4740/')).toEqual({ host: '192.168.1.40' });
    expect(parse('ws://10.0.0.59:4740')).toEqual({ host: '10.0.0.59' });
    expect(parse('192.168.001.040')).toEqual({ host: '192.168.1.40' });
    expect(parse('OX-Studio.local.')).toEqual({ host: 'ox-studio.local' });
    expect(parse('OX001234')).toEqual({ host: 'ox001234.local' }); // the OX's network name
    expect(parse(' ox001234.local ')).toEqual({ host: 'ox001234.local' });
  });

  it('explains what is wrong with an address it cannot use', () => {
    expect(parse('').error).toMatch(/Enter your OX's IP address/);
    expect(parse('192.168.1').error).toMatch(/isn't a complete IP address/);
    expect(parse('192.168.1.256').error).toMatch(/isn't a complete IP address/);
    expect(parse('my ox').error).toMatch(/doesn't look like an address/);
    expect(parse('-ox.local').error).toMatch(/doesn't look like an address/);
  });
});

describe('legacy tone blocks in track comments', () => {
  const tone = { name: 'Verse sparkle', rig: 'Rig', at: '2026-10-22T21:00:00.000Z', values: { [`${EQ}/controls/hf_freq`]: 0.25, '/device/inputs/cabinet_mic_room/controls/gain': 0.5 }, plugins: { [EQ]: 'uaudio_cambridge' } };

  it('shortens paths reversibly', () => {
    for (const p of [`${EQ}/controls/hf_freq`, `${CAB}/controls/cabinet`, '/device/inputs/cabinet_mic_room/controls/gain', EQ]) {
      expect(logic.expandKey(logic.shortKey(p))).toBe(p);
    }
  });

  it('round-trips a tone through comments and keeps other text', () => {
    const text = logic.withTone('Take 3 is the keeper', tone);
    expect(text.startsWith('Take 3 is the keeper\n[OX TONE v2]')).toBe(true);
    expect(text).not.toMatch(/["\\]/); // nothing LUNA would escape
    expect(logic.decodeTone(text)).toEqual(tone);
    const replaced = logic.withTone(text, { ...tone, rig: 'Other' });
    expect(replaced.match(/\[OX TONE v2\]/g)).toHaveLength(1);
    expect(logic.decodeTone(replaced).rig).toBe('Other');
    expect(logic.withTone(replaced, null)).toBe('Take 3 is the keeper');
  });

  it('reads v1 blocks that LUNA handed back with escaped quotes, and replaces them with v2', () => {
    const escaped = 'notes\n[OX TONE v1]{\\"rig\\":\\"Young Lusty Dirthy Rhythm\\",\\"at\\":\\"2026-10-23T04:16:27.769Z\\",\\"v\\":{\\"m:channels/mic_1/~gain\\":0.9363636},\\"p\\":{\\"c:effects/0\\":\\"uaudio_cmr\\"}}[/OX TONE]';
    const tone = logic.decodeTone(escaped);
    expect(tone).toMatchObject({ rig: 'Young Lusty Dirthy Rhythm', values: { '/mixers/0/channels/mic_1/controls/gain': 0.9363636 }, plugins: { '/device/inputs/cabinet_mic_room/effects/0': 'uaudio_cmr' } });
    const migrated = logic.withTone(escaped, { ...tone, name: 'Rhythm' });
    expect(migrated.startsWith('notes\n[OX TONE v2]')).toBe(true);
    expect(migrated).not.toContain('v1');
    expect(logic.decodeTone(migrated).name).toBe('Rhythm');
  });

  it('round-trips names with accents and emoji', () => {
    const text = logic.withTone('', { ...tone, name: 'Crunch – café 🎸' });
    expect(logic.decodeTone(text).name).toBe('Crunch – café 🎸');
  });

  it('ignores comments without a tone or with a broken one', () => {
    expect(logic.decodeTone('just notes')).toBeNull();
    expect(logic.decodeTone('[OX TONE v1]{not json[/OX TONE]')).toBeNull();
    expect(logic.decodeTone(undefined)).toBeNull();
  });
});

describe('OX client', () => {
  it('reads tone controls but not meters or solo', async () => {
    const { ox } = await connected();
    const { values, plugins } = await ox.readTone();
    expect(Object.keys(values)).toHaveLength(5);
    expect(values).not.toHaveProperty('/mixers/0/channels/mic_1/controls/solo');
    expect(plugins[EQ]).toBe('uaudio_cambridge');
  });

  it('refuses writes outside the tone controls', async () => {
    const { ox, fake } = await connected();
    for (const p of ['/device/hardware/spkr_impedance', '/update/ota', '/patchbay/destinations/device_outputs_monitor', '/mixers/0/channels/mic_1/controls/solo']) {
      await expect(ox.set(p, 0)).rejects.toThrow(/refusing/);
    }
    await expect(ox.set(`${EQ}/controls/hf_freq`, 2)).rejects.toThrow(/bad value/);
    expect(fake.writes).toEqual([]);
  });

  it('reports when the OX is unreachable', async () => {
    const ox = new OxClient({ socketFactory: () => { const ws = { close() {} }; setTimeout(() => ws.onerror?.()); return ws; } });
    await expect(ox.connect('nowhere')).rejects.toThrow(/cannot reach/);
    await expect(ox.readTone()).rejects.toThrow(/not connected/);
  });
});

describe('capture and recall', () => {
  it('saves the OX tone into a track and recalls it after the OX changes', async () => {
    const { engine, session, fake, ox } = await connected();
    const verse = session.tracks.items[0];
    await verse.comments.set('keeper take');
    await engine.settled();

    const saved = await logic.captureToTrack(session, verse, ox);
    await engine.settled();
    expect(saved.rig).toBe('Another BrickIsh Console Amp Squash');
    expect(engine.value(`/sessions/abc/tracks/${verse.id}`, 'comments')).toBe('keeper take'); // comments untouched
    expect(engine.value(`/sessions/abc/storage/${logic.STORAGE_CONTEXT}/${verse.id}`, logic.FIELD)).toMatchObject({ rig: 'Another BrickIsh Console Amp Squash', v: { 'm:buses/master/@0/~hf_freq': 0.5316162 } });

    fake.values[`${EQ}/controls/hf_freq`] = 0.1; // someone moves a knob
    fake.values[`${CAB}/controls/cabinet`] = 0.2;
    expect(logic.diffTone(logic.trackTone(session, verse), await ox.readTone())).toHaveLength(2);

    const result = await logic.recallTrack(session, verse, ox);
    expect(result).toMatchObject({ changed: 2, unchanged: 3, skipped: [], failed: [] });
    expect(fake.values[`${EQ}/controls/hf_freq`]).toBeCloseTo(0.5316162109375, 6);
    expect(fake.values[`${CAB}/controls/cabinet`]).toBeCloseTo(0.8409090909090909, 6);
    expect(logic.diffTone(logic.trackTone(session, verse), await ox.readTone())).toEqual([]);
  });

  it('recalls a setting that a link on the OX was holding when Recall began', async () => {
    const { fake, ox } = await connected();
    const DELAY = '/mixers/0/buses/master/effects/2';
    const [A, B, LINK] = ['pan_a', 'pan_b', 'pan_link'].map((c) => `${DELAY}/controls/${c}`);
    fake.plugins[DELAY] = 'uaudio_precision_delay';
    Object.assign(fake.values, { [A]: 0, [B]: 0, [LINK]: 0 });
    fake.afterSet = (v) => { if (v[LINK] === 1) v[B] = 1 - v[A]; }; // Pan Link on: Pan B mirrors Pan A
    const unlinked = await ox.readTone(); // the sound to recall: link off, both pans left
    Object.assign(fake.values, { [LINK]: 1, [B]: 1 }); // the OX moves to a sound with Pan Link on

    const result = await ox.writeTone(unlinked);
    expect(fake.values[B]).toBe(0); // written before the link came off, so it needed a second go
    expect(result).toMatchObject({ changed: 2, left: [], failed: [] });
    expect(logic.sameTone(unlinked, await ox.readTone())).toBe(true);
  });

  it('says which settings the OX would not take, and stops after three goes', async () => {
    const { fake, ox } = await connected();
    const tone = await ox.readTone();
    const HF = `${EQ}/controls/hf_gain`;
    fake.values[HF] = 0.9;
    fake.afterSet = (v) => { v[HF] = 0.9; }; // the OX keeps putting it back
    const result = await ox.writeTone(tone);
    expect(result).toMatchObject({ changed: 1, left: [HF], failed: [] });
    expect(fake.writes).toEqual([HF, HF, HF]);
  });

  it('skips controls whose slot now holds a different plug-in', async () => {
    const { session, fake, ox } = await connected();
    const track = session.tracks.items[1];
    await logic.captureToTrack(session, track, ox);
    fake.plugins[EQ] = 'uaudio_emt_140';
    fake.values[`${EQ}/controls/hf_freq`] = 0.9;
    const result = await logic.recallTrack(session, track, ox);
    expect(result.skipped).toEqual([`${EQ}/controls/hf_freq`, `${EQ}/controls/hf_gain`]);
    expect(fake.values[`${EQ}/controls/hf_freq`]).toBe(0.9);
  });

  it('returns null for a track without a saved tone', async () => {
    const { session, ox } = await connected();
    expect(await logic.recallTrack(session, session.tracks.items[2], ox)).toBeNull();
    expect(logic.presets(session)).toEqual([]);
  });
});

describe('preset names', () => {
  it('saves under the name given in LUNA, falling back to the OX rig name', async () => {
    const { session, ox } = await connected();
    const [verse, chorus] = session.tracks.items;
    await logic.captureToTrack(session, verse, ox, '  Verse sparkle  ');
    await logic.captureToTrack(session, chorus, ox, '');
    expect(logic.trackTone(session, verse)).toMatchObject({ name: 'Verse sparkle', rig: 'Another BrickIsh Console Amp Squash' });
    expect(logic.displayName(logic.trackTone(session, verse))).toBe('Verse sparkle');
    expect(logic.displayName(logic.trackTone(session, chorus))).toBe('Another BrickIsh Console Amp Squash');
    expect(logic.presets(session).map((p) => [p.track, p.name])).toEqual([['Gtr Verse', 'Verse sparkle'], ['Gtr Chorus', 'Another BrickIsh Console Amp Squash']]);
  });

  it('renames a preset without changing its settings or the comments', async () => {
    const { session, ox, fake } = await connected();
    const track = session.tracks.items[0];
    await track.comments.set('double this part');
    await logic.captureToTrack(session, track, ox, 'First name');
    const before = logic.trackTone(session, track);
    fake.values[`${EQ}/controls/hf_freq`] = 0.1; // the OX moves on; a rename must not re-read it
    expect(await logic.renameTone(session, track, 'Second name')).toBe(true);
    const after = logic.trackTone(session, track);
    expect(after.name).toBe('Second name');
    expect(after.values).toEqual(before.values);
    expect(track.comments.value).toBe('double this part');
    expect(await logic.renameTone(session, session.tracks.items[2], 'x')).toBe(false);
  });

  it('reads tones saved before names existed', () => {
    const old = '[OX TONE v1]{"rig":"Old rig","at":"2026-10-22T19:00:00.000Z","v":{"m:buses/master/@0/~hf_freq":0.5},"p":{}}[/OX TONE]';
    expect(logic.decodeTone(old)).toMatchObject({ name: null, rig: 'Old rig' });
    expect(logic.displayName(logic.decodeTone(old))).toBe('Old rig');
  });
});

describe('preset list', () => {
  it('lists only tracks with presets and marks the one the OX is on', async () => {
    const { session, ox, fake } = await connected();
    const [verse, chorus, bass] = session.tracks.items;
    await logic.captureToTrack(session, verse, ox, 'Verse');
    fake.values[`${EQ}/controls/hf_freq`] = 0.2;
    await logic.captureToTrack(session, chorus, ox, 'Chorus');

    let list = logic.presets(session, await ox.readTone());
    expect(list.map((p) => p.track)).toEqual(['Gtr Verse', 'Gtr Chorus']);
    expect(list.map((p) => p.onOx)).toEqual([false, true]);
    expect(list.some((p) => p.id === bass.id)).toBe(false);

    await logic.recallTrack(session, verse, ox);
    fake.values[`${CAB}/controls/cabinet`] = 0.1; // tweaked in the OX app after recalling Verse
    list = logic.presets(session, await ox.readTone(), verse.id);
    expect(list.map((p) => [p.onOx, p.edited])).toEqual([[false, true], [false, false]]);
  });

  it('shows no on-OX or edited state before the OX has been read', async () => {
    const { session, ox } = await connected();
    await logic.captureToTrack(session, session.tracks.items[0], ox, 'Verse');
    expect(logic.presets(session, null, session.tracks.items[0].id)[0]).toMatchObject({ onOx: false, edited: false, drift: null });
  });

  it('removes a preset and keeps the rest of the comments', async () => {
    const { session, ox } = await connected();
    const track = session.tracks.items[0];
    await track.comments.set('comp the second half');
    await logic.captureToTrack(session, track, ox, 'Verse');
    expect(await logic.removeTone(session, track)).toBe(true);
    expect(track.comments.value).toBe('comp the second half');
    expect(logic.presets(session)).toEqual([]);
    expect(logic.trackTone(session, track)).toBeNull();
    expect(await logic.removeTone(session, track)).toBe(false);
  });
});

describe('session storage', () => {
  // MockEngine's undo is a no-op, so this checks what is asked of LUNA: every user action is
  // one undoable write, and moving old comment presets is not an undo step.
  it('asks LUNA to make save, update, rename and remove each one undo step', async () => {
    const { session, ox } = await connected();
    const [track, other] = session.tracks.items;
    const store = logic.store(session);
    const calls = [];
    for (const verb of ['add', 'set', 'remove']) {
      const real = store[verb].bind(store);
      vi.spyOn(store, verb).mockImplementation((...args) => { calls.push([verb, args.at(-1)?.undoable]); return real(...args); });
    }
    await logic.captureToTrack(session, track, ox, 'First'); // save
    await logic.captureToTrack(session, track, ox, 'First'); // update
    await logic.renameTone(session, track, 'Second');
    await logic.removeTone(session, track);
    expect(calls).toEqual([['add', true], ['set', true], ['set', true], ['set', true]]);

    calls.length = 0;
    await other.comments.set(logic.withTone('', { name: 'Old', rig: null, at: null, values: { [`${EQ}/controls/hf_freq`]: 0.1 }, plugins: {} }));
    await logic.migrateComments(session);
    expect(calls).toEqual([['add', false]]);
  });

  it('moves presets out of track comments, keeping other comment text', async () => {
    const { engine, session } = await connected();
    const [verse, chorus, bass] = session.tracks.items;
    const tone = { name: 'Verse sparkle', rig: 'Rig', at: '2026-10-22T21:00:00.000Z', values: { [`${EQ}/controls/hf_freq`]: 0.25 }, plugins: { [EQ]: 'uaudio_cambridge' } };
    await verse.comments.set(logic.withTone('Take 3 is the keeper', tone));
    await chorus.comments.set('[OX TONE v1]{\\"rig\\":\\"Old rig\\",\\"at\\":\\"2026-10-23T04:16:27.769Z\\",\\"v\\":{\\"m:channels/mic_1/~gain\\":0.9},\\"p\\":{}}[/OX TONE]');
    await bass.comments.set('just notes');
    await engine.settled();

    expect(await logic.migrateComments(session)).toBe(2);
    await engine.settled();
    expect(verse.comments.value).toBe('Take 3 is the keeper');
    expect(chorus.comments.value).toBe('');
    expect(bass.comments.value).toBe('just notes');
    expect(logic.trackTone(session, verse)).toEqual(tone);
    expect(logic.trackTone(session, chorus)).toMatchObject({ name: null, rig: 'Old rig', values: { '/mixers/0/channels/mic_1/controls/gain': 0.9 } });
    expect(await logic.migrateComments(session)).toBe(0);
  });

  it('keeps a stored preset over an old comment block, and drops the block', async () => {
    const { engine, session, ox } = await connected();
    const track = session.tracks.items[0];
    await logic.captureToTrack(session, track, ox, 'Stored');
    await track.comments.set(logic.withTone('notes', { name: 'Old', rig: null, at: null, values: { [`${EQ}/controls/hf_freq`]: 0.1 }, plugins: {} }));
    await engine.settled();
    expect(await logic.migrateComments(session)).toBe(0);
    await engine.settled();
    expect(logic.trackTone(session, track).name).toBe('Stored');
    expect(track.comments.value).toBe('notes');
  });
});

const tick = async (engine) => { for (let i = 0; i < 5; i++) { await engine.settled(); await new Promise((r) => setTimeout(r, 15)); } };

/** Record one take on a track the way LUNA does, returning the take's info while it ran. */
async function recordTake(engine, session, track, ox) {
  await logic.sources(session).load();
  const playlist = session.playlistFor(track);
  await playlist.clips.load();
  await track.recordEnabled.set(true);
  await session.transport.recordEnabled.set(true);
  await tick(engine);
  const take = session.recordTakes.items.find((t) => t.trackUid.value === track.id);
  const info = { trackUid: track.id, sourceUid: take.sourceUid.value, start: take.start.value };
  const saved = await logic.captureTake(session, take, ox);
  info.saved = saved;
  engine.finishTake('abc', track.id, { startTick: info.start, stopTick: info.start + Luna.WHOLE_NOTE });
  await session.transport.recordEnabled.set(false);
  await track.recordEnabled.set(false);
  await tick(engine);
  await playlist.clips.membersReady();
  return { info, saved, playlist };
}

describe('OX tracks', () => {
  it('only marked tracks are OX tracks; a default saved before marks existed counts as marked', async () => {
    const { session, ox } = await connected();
    const [verse, chorus, bass] = session.tracks.items;
    expect(logic.isOxTrack(session, verse)).toBe(false);
    await logic.markTrack(session, verse, true);
    expect(logic.isOxTrack(session, verse)).toBe(true);
    await logic.captureToTrack(session, chorus, ox, 'Old'); // a default with no mark, as earlier versions saved
    expect(logic.isOxTrack(session, chorus)).toBe(true);
    await logic.markTrack(session, chorus, false);
    expect(logic.isOxTrack(session, chorus)).toBe(false);
    expect(logic.trackTone(session, chorus).name).toBe('Old'); // unmarking keeps the default
    expect(logic.oxTracks(session).map((t) => [t.track, t.name])).toEqual([['Gtr Verse', null]]);
    expect(logic.isOxTrack(session, bass)).toBe(false);
  });

  it('clearing a default keeps the mark', async () => {
    const { session, ox } = await connected();
    const track = session.tracks.items[0];
    await logic.markTrack(session, track, true);
    await logic.captureToTrack(session, track, ox, 'Verse');
    await logic.removeTone(session, track);
    expect(logic.trackTone(session, track)).toBeNull();
    expect(logic.isOxTrack(session, track)).toBe(true);
  });
});

describe('tones saved with recordings', () => {
  it('saves the sound the OX is really on with a take on an OX track, flagged when it differs from the default', async () => {
    const { engine, session, ox, fake } = await connected();
    const track = session.tracks.items[0];
    await logic.markTrack(session, track, true);
    await logic.captureToTrack(session, track, ox, 'Verse');
    fake.values[`${EQ}/controls/hf_freq`] = 0.9; // dialed a different sound in the OX app
    fake.values[`${CAB}/controls/cabinet`] = 0.1;
    const writesBefore = fake.writes.length;
    const { info, saved, playlist } = await recordTake(engine, session, track, ox);
    expect(saved.name).toBe('Another BrickIsh Console Amp Squash'); // matches no default: the rig name
    expect(logic.trackTone(session, track).values[`${EQ}/controls/hf_freq`]).toBeCloseTo(0.5316162, 6); // default untouched
    expect(fake.writes.length).toBe(writesBefore); // recording only reads the OX

    // LUNA may file the finished clip under another audio file: the tone follows it.
    const clip = playlist.clips.items[0];
    await logic.settleTake(session, info);
    const tone = logic.sourceTone(session, clip.sourceUid.value);
    expect(tone.values[`${EQ}/controls/hf_freq`]).toBeCloseTo(0.9, 6);
    expect(logic.sameTone(tone, logic.trackTone(session, track))).toBe(false);
    expect(logic.differences(tone, logic.trackTone(session, track)).sort()).toEqual(['Cab and mics', 'EQ']);
  });

  it('names a take after the default it matches', async () => {
    const { engine, session, ox } = await connected();
    const track = session.tracks.items[0];
    await logic.markTrack(session, track, true);
    await logic.captureToTrack(session, track, ox, 'Verse');
    const { saved } = await recordTake(engine, session, track, ox);
    expect(saved.name).toBe('Verse');
  });

  it('calls a take "(edited)" when its rig name is already a default for a different sound', async () => {
    const { engine, session, ox, fake } = await connected();
    const track = session.tracks.items[0];
    await logic.markTrack(session, track, true);
    await logic.captureToTrack(session, track, ox, ''); // unnamed: shown by its rig name
    fake.values[`${EQ}/controls/hf_freq`] = 0.9;
    const { saved } = await recordTake(engine, session, track, ox);
    expect(saved.name).toBe('Another BrickIsh Console Amp Squash (edited)');
  });

  it('saves nothing for a take on a track that is not an OX track', async () => {
    const { engine, session, ox } = await connected();
    const { saved, info } = await recordTake(engine, session, session.tracks.items[1], ox);
    expect(saved).toBeNull();
    expect(logic.sourceTone(session, info.sourceUid)).toBeNull();
  });

  it('saves "tone unknown" when the OX is offline, and never fills it in later', async () => {
    const { engine, session, ox } = await connected();
    const track = session.tracks.items[0];
    await logic.markTrack(session, track, true);
    ox.close();
    const { saved, info } = await recordTake(engine, session, track, ox);
    expect(saved.unknown).toBe(true);
    await ox.connect('ox.test');
    const take = { trackUid: { value: track.id }, sourceUid: { value: info.sourceUid }, start: { value: info.start } };
    await logic.captureTake(session, take, ox); // the OX is back; the saved snapshot is not replaced
    expect(logic.sourceTone(session, info.sourceUid)).toMatchObject({ unknown: true });
  });

  it('promoting a clip tone copies it to the track without touching the OX', async () => {
    const { engine, session, ox, fake } = await connected();
    const track = session.tracks.items[0];
    await logic.markTrack(session, track, true);
    await logic.captureToTrack(session, track, ox, 'Verse');
    fake.values[`${EQ}/controls/hf_freq`] = 0.9;
    const { saved } = await recordTake(engine, session, track, ox);
    fake.values[`${EQ}/controls/hf_freq`] = 0.3; // the OX moves on
    const writes = fake.writes.length;
    await logic.writeTrackTone(session, track, saved);
    expect(logic.sameTone(logic.trackTone(session, track), saved)).toBe(true);
    expect(fake.writes.length).toBe(writes);
  });
});

describe('clip selection', () => {
  it('finds the clip LUNA selected by its range on the focused track', async () => {
    const { engine, session, ox } = await connected();
    const track = session.tracks.items[0];
    const { playlist } = await recordTake(engine, session, track, ox);
    const clip = playlist.clips.items[0];
    await session.context.lastSelectedTrack.set(track.id);
    await session.context.selectionTracks.set([track.id]);
    await session.context.selectionStart.set(clip.start.value);
    await session.context.selectionStop.set(clip.stop.value);
    await tick(engine);
    expect(logic.selectedClip(session)?.clip.id).toBe(clip.id);
    await session.context.selectionStart.set(clip.stop.value + 10);
    await session.context.selectionStop.set(clip.stop.value + 20);
    await tick(engine);
    expect(logic.selectedClip(session)).toBeNull();
  });
});

describe('what the OX is on, without names', () => {
  it('lists a track\'s clips in timeline order with the sound each was recorded with', async () => {
    const { engine, session, ox, fake } = await connected();
    const track = session.tracks.items[0];
    expect(logic.trackClips(session, track)).toEqual([]);
    await logic.markTrack(session, track, true);
    await logic.captureToTrack(session, track, ox, null);
    fake.values[`${EQ}/controls/hf_freq`] = 0.9;
    const { info, playlist } = await recordTake(engine, session, track, ox);
    await logic.settleTake(session, info); // LUNA may file the finished clip under another audio file
    const clips = logic.trackClips(session, track);
    expect(clips.map((c) => c.clip.id)).toEqual(playlist.clips.items.map((c) => c.id));
    expect(clips[0].name).toBe(playlist.clips.items[0].name.value || 'Clip');
    expect(clips[0].tone.values[`${EQ}/controls/hf_freq`]).toBeCloseTo(0.9, 6);
  });

  it('says which track or clip the OX is on by comparing settings, and "changed" after a recall is tweaked', async () => {
    const { engine, session, ox, fake } = await connected();
    const [verse, chorus] = session.tracks.items;
    expect(logic.oxNow(session, null)).toBeNull(); // not read yet
    expect(logic.oxNow(session, await ox.readTone())).toEqual({ kind: 'none', name: null, changed: false });
    await logic.markTrack(session, verse, true);
    await logic.captureToTrack(session, verse, ox, null);
    expect(logic.oxNow(session, await ox.readTone())).toEqual({ kind: 'track', name: 'Gtr Verse', changed: false });

    // Two tracks saved from the same OX rig with different settings never count as the same sound.
    fake.values[`${EQ}/controls/hf_freq`] = 0.2;
    await logic.markTrack(session, chorus, true);
    await logic.captureToTrack(session, chorus, ox, null);
    expect(logic.trackTone(session, chorus).rig).toBe(logic.trackTone(session, verse).rig);
    expect(logic.oxNow(session, await ox.readTone()).name).toBe('Gtr Chorus');

    // A clip recorded with a third sound: the OX is on that clip's sound, then moves away.
    fake.values[`${EQ}/controls/hf_freq`] = 0.9;
    const { info, playlist } = await recordTake(engine, session, verse, ox);
    const clip = playlist.clips.items[0];
    await logic.settleTake(session, info);
    const clipName = clip.name.value || 'Clip';
    expect(logic.oxNow(session, await ox.readTone())).toEqual({ kind: 'clip', name: clipName, changed: false });
    fake.values[`${EQ}/controls/hf_freq`] = 0.7; // tweaked on the OX
    const live = await ox.readTone();
    expect(logic.oxNow(session, live)).toEqual({ kind: 'none', name: null, changed: false });
    expect(logic.oxNow(session, live, `source:${clip.sourceUid.value}`)).toEqual({ kind: 'clip', name: clipName, changed: true });
    expect(logic.oxNow(session, live, `track:${verse.id}`)).toEqual({ kind: 'track', name: 'Gtr Verse', changed: true });
    expect(logic.oxNow(session, live, 'track:gone')).toEqual({ kind: 'none', name: null, changed: false });

    // A track that stops using the OX no longer counts.
    await ox.writeTone(logic.trackTone(session, chorus));
    expect(logic.oxNow(session, await ox.readTone()).name).toBe('Gtr Chorus');
    await logic.markTrack(session, chorus, false);
    expect(logic.oxNow(session, await ox.readTone()).kind).toBe('none');
  });
});

describe('Find my OX', () => {
  /** A network where `oxes` answer as OXes, `others` answer on the port but aren't OXes, and the rest never answer. */
  function network({ oxes = [], others = [] } = {}) {
    const asked = [];
    const socketFactory = (url) => {
      const host = url.slice(5, url.lastIndexOf(':'));
      asked.push(host);
      const ws = { close() {}, send(line) {
        expect(line.startsWith('get ')).toBe(true); // the search only reads
        const reply = oxes.includes(host) ? { parameters: { message_id: 1 }, data: { children: [] } } : { parameters: { message_id: 1 }, error: 'Unable to resolve path', data: null };
        setTimeout(() => ws.onmessage?.({ data: JSON.stringify(reply) }));
      } };
      if (oxes.includes(host) || others.includes(host)) setTimeout(() => ws.onopen?.());
      else setTimeout(() => ws.onerror?.());
      return ws;
    };
    return { socketFactory, asked };
  }

  it('finds the OX, tells it apart from other devices, and stops after the range it was in', async () => {
    const net = network({ oxes: ['10.0.0.61'], others: ['10.0.0.5', '192.168.1.20'] });
    const ranges = [];
    const found = await OxClient.find({ socketFactory: net.socketFactory, ranges: ['192.168.1', '10.0.0', '10.0.1'], onRange: (p) => ranges.push(p) });
    expect(found).toEqual(['10.0.0.61']);
    expect(ranges).toEqual(['192.168.1', '10.0.0']);
    expect(net.asked.some((h) => h.startsWith('10.0.1.'))).toBe(false);
  });

  it('tries the range of the last address first', async () => {
    const net = network({ oxes: ['10.0.0.61'] });
    const ranges = [];
    await OxClient.find({ first: OxClient.rangeOf('10.0.0.59'), socketFactory: net.socketFactory, ranges: ['192.168.1', '10.0.0'], onRange: (p) => ranges.push(p) });
    expect(ranges).toEqual(['10.0.0']);
  });

  it('returns every OX in the range, in address order, and [] when there is none', async () => {
    expect(await OxClient.find({ socketFactory: network({ oxes: ['10.0.0.70', '10.0.0.9'] }).socketFactory, ranges: ['10.0.0'] })).toEqual(['10.0.0.9', '10.0.0.70']);
    expect(await OxClient.find({ socketFactory: network().socketFactory, ranges: ['10.0.0', '10.0.1'] })).toEqual([]);
  });

  /**
   * The same network over web requests: `oxes` answer with their cab section, `others` answer
   * something else, `closed` refuse at once, and the rest never answer (until the request is dropped).
   */
  function web({ oxes = [], others = [], closed = [] } = {}) {
    const asked = [];
    const fetchFn = (url, { signal } = {}) => new Promise((resolve, reject) => {
      const host = new URL(url).hostname;
      asked.push(host);
      expect(new URL(url).pathname).toBe('/device/inputs/cabinet_mic_room'); // the search only reads
      const answer = (body) => resolve({ json: async () => body });
      if (oxes.includes(host)) return answer({ path: '/device/inputs/cabinet_mic_room', data: { properties: {} } });
      if (others.includes(host)) return answer({ path: '/device/inputs/cabinet_mic_room', error: 'Unable to resolve path for get', data: {} });
      if (closed.includes(host)) return reject(new TypeError('Failed to fetch'));
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    return { fetchFn, asked };
  }

  it('tells an OX from another device and from an empty address by one web request', async () => {
    const net = web({ oxes: ['10.0.0.61'], others: ['10.0.0.5'], closed: ['10.0.0.1'] });
    expect(await OxClient.probe('10.0.0.61', { fetchFn: net.fetchFn, timeoutMs: 30 })).toBe('ox');
    expect(await OxClient.probe('10.0.0.5', { fetchFn: net.fetchFn, timeoutMs: 30 })).toBe('alive');
    expect(await OxClient.probe('10.0.0.1', { fetchFn: net.fetchFn, timeoutMs: 30 })).toBe('alive');
    expect(await OxClient.probe('10.0.0.200', { fetchFn: net.fetchFn, timeoutMs: 30 })).toBe('none');
  });

  it('searches by web request, opening no WebSocket when that finds the OX', async () => {
    const net = web({ oxes: ['10.0.0.61'], closed: ['10.0.0.1', '192.168.1.1'] });
    const sockets = network({ oxes: ['10.0.0.61'] });
    const ranges = [];
    const found = await OxClient.find({ fetchFn: net.fetchFn, socketFactory: sockets.socketFactory, timeoutMs: 30, ranges: ['192.168.1', '10.0.0', '10.0.1'], onRange: (p) => ranges.push(p) });
    expect(found).toEqual(['10.0.0.61']);
    expect(ranges).toEqual(['192.168.1', '10.0.0']);
    expect(net.asked).toHaveLength(6 + 508); // the routers' addresses of all three ranges, then two ranges in full
    // 192.168.1 had no OX by web request, so its one answering address was asked by WebSocket; 10.0.0's were not.
    expect(sockets.asked).toEqual(['192.168.1.1']);
  });

  it('searches the ranges that exist on this network before the ones that do not', async () => {
    const net = web({ oxes: ['10.0.0.61'], closed: ['10.0.0.1'] }); // only 10.0.0's router answers
    const ranges = [];
    const found = await OxClient.find({ fetchFn: net.fetchFn, socketFactory: network().socketFactory, timeoutMs: 30, ranges: ['192.168.1', '192.168.0', '10.0.0', '10.0.1'], onRange: (p) => ranges.push(p) });
    expect(found).toEqual(['10.0.0.61']);
    expect(ranges).toEqual(['10.0.0']);
    expect(net.asked).toHaveLength(8 + 254); // nothing was sent into the ranges that are not there

    // The range that worked last time still goes first, and a router at .254 counts too.
    const far = web({ oxes: ['192.168.0.9'], closed: ['10.0.0.254'] });
    const order = [];
    await OxClient.find({ first: '192.168.0', fetchFn: far.fetchFn, socketFactory: network().socketFactory, timeoutMs: 30, ranges: ['192.168.1', '10.0.0'], onRange: (p) => order.push(p) });
    expect(order).toEqual(['192.168.0']);
    const none = web({ closed: ['10.0.0.254'] });
    const all = [];
    await OxClient.find({ first: '192.168.0', fetchFn: none.fetchFn, socketFactory: network().socketFactory, timeoutMs: 30, ranges: ['192.168.1', '10.0.0'], onRange: (p) => all.push(p) });
    expect(all).toEqual(['192.168.0', '10.0.0', '192.168.1']);
  });

  it('still finds an OX that answers WebSockets but not web requests', async () => {
    const net = web({ closed: ['10.0.0.1', '10.0.0.61', '10.0.0.70'] });
    const sockets = network({ oxes: ['10.0.0.61'], others: ['10.0.0.70'] });
    expect(await OxClient.find({ fetchFn: net.fetchFn, socketFactory: sockets.socketFactory, timeoutMs: 30, ranges: ['10.0.0'] })).toEqual(['10.0.0.61']);
    expect(sockets.asked.sort()).toEqual(['10.0.0.1', '10.0.0.61', '10.0.0.70']);
  });

  it('opens no WebSockets when a whole range "answers", which is the network refusing, not devices', async () => {
    const all = Array.from({ length: 254 }, (_, i) => `172.16.0.${i + 1}`);
    const sockets = network();
    expect(await OxClient.find({ fetchFn: web({ closed: all }).fetchFn, socketFactory: sockets.socketFactory, timeoutMs: 30, ranges: ['172.16.0'] })).toEqual([]);
    expect(sockets.asked).toEqual([]);
  });

  it('knows the range of an IP address but not of a name', () => {
    expect(OxClient.rangeOf('10.0.0.61')).toBe('10.0.0');
    expect(OxClient.rangeOf('ox001234.local')).toBeNull();
  });
});

describe('OX Link', () => {
  /** A stand-in OX Link: answers list, and connect for the OXes it knows. */
  function fakeLink({ devices = [{ name: 'OX001234', host: 'OX001234.local', address: '10.0.0.61' }], ox = new FakeOx() } = {}) {
    const hellos = [];
    const open = (url) => {
      expect(url).toBe(OxLink.URL);
      let upstream = null;
      const ws = { close() {}, send(text) {
        if (upstream) return upstream.send(text);
        const hello = JSON.parse(text);
        hellos.push(hello);
        const reply = (m) => setTimeout(() => ws.onmessage?.({ data: JSON.stringify(m) }));
        if (hello.op === 'list') return reply({ app: 'OX Link', version: '0.1.0', devices });
        if (!OxLink.knows({ devices }, hello.host)) return reply({ ok: false, error: 'No OX called ' + hello.host });
        upstream = ox.socket(`ws://ox.test:${hello.port}`);
        upstream.onopen = () => reply({ ok: true });
        upstream.onmessage = (e) => ws.onmessage?.(e);
      } };
      setTimeout(() => ws.onopen?.());
      return ws;
    };
    return { open, hellos, ox };
  }

  it('lists what OX Link sees, and is null when it is not running', async () => {
    const link = fakeLink();
    expect(await OxLink.list({ socketFactory: link.open })).toMatchObject({ version: '0.1.0', devices: [{ name: 'OX001234' }] });
    const none = () => { const ws = { close() {} }; setTimeout(() => ws.onerror?.()); return ws; };
    expect(await OxLink.list({ socketFactory: none })).toBeNull();
  });

  it('answers once when closing a failed socket reports the failure again', async () => {
    let closes = 0;
    const again = () => { const ws = { close() { closes++; ws.onerror?.(); } }; setTimeout(() => ws.onerror?.()); return ws; };
    expect(await OxLink.list({ socketFactory: again })).toBeNull();
    expect(closes).toBe(1);
  });

  it('knows an OX by name, network name or address', () => {
    const link = { devices: [{ name: 'OX001234', host: 'OX001234.local', address: '10.0.0.61' }] };
    for (const h of ['ox001234', 'ox001234.local', '10.0.0.61']) expect(OxLink.knows(link, h)).toBe(true);
    expect(OxLink.knows(link, '10.0.0.62')).toBe(false);
    expect(OxLink.knows(null, 'ox001234')).toBe(false);
  });

  it('reads and recalls through OX Link exactly as directly', async () => {
    const link = fakeLink();
    const ox = new OxClient({ socketFactory: (url) => OxLink.socketFactory(url, { open: link.open }), timeoutMs: 500 });
    await ox.connect('ox001234.local');
    expect(link.hellos).toEqual([{ op: 'connect', host: 'ox001234.local', port: 4740 }]);
    const tone = await ox.readTone();
    expect(Object.keys(tone.values)).toHaveLength(5);
    expect(await ox.readRigName()).toBe('Another BrickIsh Console Amp Squash');
    link.ox.values[`${EQ}/controls/hf_freq`] = 0.1;
    expect((await ox.writeTone(tone)).changed).toBe(1);
  });

  it('fails to connect when OX Link does not know the OX', async () => {
    const link = fakeLink();
    const ox = new OxClient({ socketFactory: (url) => OxLink.socketFactory(url, { open: link.open }), timeoutMs: 500 });
    await expect(ox.connect('10.0.0.99')).rejects.toThrow(/cannot reach/);
  });
});

describe('the OX Link that ships with the add-on', () => {
  const ADD_ONS = '/Library/Application Support/Universal Audio/LUNA/Add Ons';
  const ENCODED = 'file:///Library/Application%20Support/Universal%20Audio/LUNA/Add%20Ons';
  const ZIP = fileURLToPath(new URL('../link/OX Link.zip', import.meta.url));
  const place = (folder, encoded) => ({ folder: `${folder}/link`, zip: `${encoded}/link/OX%20Link.zip`, app: `${encoded}/link/OX%20Link/OX%20Link.app` });

  it('is only asked for on a Mac', () => {
    expect(OxLink.runsOn('MacIntel')).toBe(true);
    expect(OxLink.runsOn('Win32')).toBe(false);
    expect(OxLink.runsOn('')).toBe(false);
  });

  it('looks beside the add-on\'s icon first, then in LUNA\'s Add Ons folder', () => {
    expect(OxLink.places('/Users/me/My Add Ons/Recall #2/icon.png')).toEqual([
      place('/Users/me/My Add Ons/Recall #2', 'file:///Users/me/My%20Add%20Ons/Recall%20%232'),
      place(`${ADD_ONS}/OX Tone Recall`, `${ENCODED}/OX%20Tone%20Recall`),
      place(`${ADD_ONS}/ox-tone-recall`, `${ENCODED}/ox-tone-recall`),
    ]);
    // The usual install: the icon's folder is one of the usual places, and is not tried twice.
    expect(OxLink.places(`${ADD_ONS}/OX Tone Recall/icon.png`).map((p) => p.app)).toEqual([
      `${ENCODED}/OX%20Tone%20Recall/link/OX%20Link/OX%20Link.app`,
      `${ENCODED}/ox-tone-recall/link/OX%20Link/OX%20Link.app`,
    ]);
    // LUNA reports '' until it has read a manifest with an icon; a Windows path is no use either.
    for (const none of ['', undefined, 'C:\\ProgramData\\Universal Audio\\LUNA\\Add Ons\\x\\icon.png']) expect(OxLink.places(none)).toHaveLength(2);
  });

  it('asks its own folder whether the Mac has unpacked it', async () => {
    const asked = [];
    const fetchFn = (ok) => async (url) => { asked.push(url); return { ok }; };
    expect(await OxLink.unpackedHere({ fetchFn: fetchFn(true) })).toBe(true);
    expect(await OxLink.unpackedHere({ fetchFn: fetchFn(false) })).toBe(false); // LUNA answers "not found"
    expect(await OxLink.unpackedHere({ fetchFn: async () => { throw new TypeError('Load failed'); } })).toBe(false);
    expect(asked[0]).toBe('link/OX%20Link/version.txt');
  });

  /** A Mac for `start`: opening the zip at `zipAt` unpacks the app; opening an unpacked app starts OX Link after two polls. */
  function mac({ unpacked = false, zipAt = null, starts = true } = {}) {
    const opened = [];
    let polls = -1;
    return {
      opened,
      openUrl: async (url) => { opened.push(url); if (url === zipAt) unpacked = true; if (url.endsWith('.app') && unpacked && starts && polls < 0) polls = 0; },
      unpacked: async () => unpacked,
      list: async () => (polls >= 0 && ++polls >= 2 ? { version: '0.1.0', devices: [] } : null),
      sleep: async () => {},
    };
  }
  const A = { folder: '/a/link', zip: 'file:///a/link/OX%20Link.zip', app: 'file:///a/link/OX%20Link/OX%20Link.app' };
  const B = { folder: '/b/link', zip: 'file:///b/link/OX%20Link.zip', app: 'file:///b/link/OX%20Link/OX%20Link.app' };

  it('the first time, opens the zip so the Mac unpacks it, then the app', async () => {
    const m = mac({ zipAt: A.zip });
    expect(await OxLink.start({ ...m, places: [A, B] })).toMatchObject({ version: '0.1.0' });
    expect(m.opened).toEqual([A.zip, A.app]);
  });

  it('once unpacked, opens the app alone', async () => {
    const m = mac({ unpacked: true });
    expect(await OxLink.start({ ...m, places: [A, B] })).toMatchObject({ version: '0.1.0' });
    expect(m.opened).toEqual([A.app]);
  });

  it('when a zip does not visibly unpack, still tries its app briefly, then the next place', async () => {
    const m = mac({ zipAt: B.zip });
    let slept = 0;
    expect(await OxLink.start({ ...m, places: [A, B], sleep: async (ms) => { slept += ms; } })).toMatchObject({ version: '0.1.0' });
    expect(m.opened).toEqual([A.zip, A.app, B.zip, B.app]);
    expect(slept).toBe(4000 + 2000 + 400 + 800); // A: wait to unpack, then a short wait; B: unpacked at once, answered on the second poll
  });

  it('starts OX Link even if the page cannot see that the zip unpacked', async () => {
    const m = mac({ zipAt: A.zip });
    expect(await OxLink.start({ ...m, unpacked: async () => false, places: [A, B] })).toMatchObject({ version: '0.1.0' });
    expect(m.opened).toEqual([A.zip, A.app]);
  });

  it('gives up with null when OX Link never answers, or LUNA refuses', async () => {
    const m = mac({ unpacked: true, starts: false });
    let slept = 0;
    expect(await OxLink.start({ ...m, places: [A, B], waitMs: 6000, pollMs: 400, sleep: async (ms) => { slept += ms; } })).toBeNull();
    expect(m.opened).toEqual([A.app, B.app]);
    expect(slept).toBe(12000); // each place had its time before the next
    expect(await OxLink.start({ ...mac({ unpacked: true }), openUrl: async () => { throw new Error('LUNA refused'); }, places: [A, B] })).toBeNull();
  });

  it('ships as a zip whose app is marked runnable, beside the icon the panel finds the folder by', () => {
    const listing = execFileSync('/usr/bin/zipinfo', [ZIP], { encoding: 'utf8' });
    // LUNA installs files without the mark that lets a program run; the zip carries it for the Mac to restore.
    expect(listing).toMatch(/^-rwxr-xr-x .* OX Link\/OX Link\.app\/Contents\/MacOS\/OXLink$/m);
    expect(listing).toMatch(/ OX Link\/version\.txt$/m); // what the panel looks for to know it is unpacked
    expect(existsSync(new URL('../OX Link.app', import.meta.url))).toBe(false); // an unpacked app can't run once LUNA installs it
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    expect(manifest.icon).toBe('icon.png');
    expect(statSync(new URL('../icon.png', import.meta.url)).size).toBeGreaterThan(0);
    // OX Link only accepts this add-on's page, by its id.
    expect(readFileSync(new URL('../main.js', import.meta.url), 'utf8')).toContain("const STORE = 'com.shawnrasson.ox-tone-recall.'");
    expect(manifest.id).toBe('com.shawnrasson.ox-tone-recall');
  });

  it.runIf(process.platform === 'darwin')('unpacks to an app with a valid signature, as LUNA installs it', () => {
    // As LUNA installs it: the zip arrives as a plain file. The Mac's own unpacking restores the app.
    const dir = mkdtempSync(join(tmpdir(), 'ox-link-'));
    execFileSync('/usr/bin/ditto', ['-x', '-k', ZIP, dir]);
    const app = join(dir, 'OX Link', 'OX Link.app');
    expect(readFileSync(join(dir, 'OX Link', 'version.txt'), 'utf8')).toMatch(/^OX Link \d+\.\d+\.\d+\n$/);
    expect(statSync(join(app, 'Contents/MacOS/OXLink')).mode & 0o111).toBe(0o111);
    expect(readFileSync(join(app, 'Contents/Info.plist'), 'utf8')).toContain('<string>com.shawnrasson.oxlink</string>');
    expect(() => execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'pipe' })).not.toThrow();
  });
});
