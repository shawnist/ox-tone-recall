// OX Tone Recall: DOM wiring.
//
// Tracks are marked as OX tracks by the user; nothing is inferred. An OX track has a sound, saved
// on purpose with Save to track. Every clip recorded on an OX track keeps the sound the OX was
// really on (or "OX was offline"). The panel lists the OX tracks only. Each row answers one
// question, "is the OX on this sound?", with a lamp; a track opens to show its clips the same
// way. Sounds have no names here: a track's sound is the track's, a clip's is the clip's.
// Selecting, opening and Save to track never change the OX; only Recall does. Nothing pops up:
// state shows in the line under the bar and in a message that fades. Every listener returned by
// onChange is kept so it can be released when the session changes.

const $ = (id) => document.getElementById(id);
const STORE = 'com.shawnrasson.ox-tone-recall.';
const OX_APP = '/Applications/OX.app';
const ADD_ON_ID = STORE.slice(0, -1); // this add-on's manifest id
const CHECK_EVERY_MS = 3000; // how often to read the OX's current sound, while visible
const RETRY_EVERY_MS = 10000; // how often to try the OX again after losing it
const MESSAGE_MS = 4500; // how long a confirmation stays up; errors stay twice as long
const SETTLE_AFTER_MS = [300, 1000, 2500]; // when to look for a finished take's clip
const REFIND_EVERY_MS = 120000; // at most this often, search for an OX whose IP stopped answering
let luna;
let session;
let releases = [];
const keep = (u) => releases.push(u);
const release = () => {
  for (const u of releases) u();
  releases = [];
};
const ox = new OxClient();
let busy = false;
let reading = false;
let oxError = '';
let oxHost = ''; // the address in use, once it has been checked
let connecting = false;
let lastAttempt = 0; // when the last connection attempt started, for background retries
let live = null; // the OX's tone at the last read
let oxRig = null; // the OX's current rig name
let lastLoaded = null; // what Recall last sent to the OX ('track:<id>' or 'source:<uid>'), for "changed"
let messageTimer = null;
let searching = false; // Find my OX is running
let lastSearch = 0;
// Inside LUNA on a Mac, the OX can only be reached through OX Link (LUNA lets add-on pages connect
// to this computer only). OX Link is a Mac app that ships with this add-on. Elsewhere (a browser,
// an older LUNA, LUNA on Windows) there is no OX Link to ask for, and the panel connects directly.
const linkOnly = Luna.isEmbeddedInLuna() && OxLink.runsOn();
const DIRECT = (url) => new WebSocket(url);
let link = null; // what OX Link reports, or null when it isn't running
let viaLink = false; // the OX is reached through OX Link
let needsLink = false; // inside LUNA without OX Link: nothing can reach the OX
let startingLink = false; // Start OX Link was pressed and OX Link hasn't answered yet
const LINK_RETRY_MS = 3000;
const takes = new Map(); // take id -> { take, info } for takes being recorded
const capturing = new Set();
const openChoice = new Map(); // track id -> open or closed, once the user has chosen
const wasAuto = new Map(); // track id -> whether it was opened by a clip selection or a recording last time
const openDiffs = new Set(); // 'track:<id>' / 'source:<uid>' whose "What changed" is open
const clipScroll = new Map(); // track id -> how far its clip list is scrolled
let shownClip = null; // the selected clip last scrolled into view
let oxNow = null; // what the OX is on at this repaint (AddOnLogic.oxNow), so the top line and the lamps agree

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

function say(text, bad = false) {
  clearTimeout(messageTimer);
  $('message').textContent = text;
  $('message').className = `message${bad ? ' bad' : ''}`;
  if (text && !text.endsWith('...')) messageTimer = setTimeout(() => say(''), bad ? MESSAGE_MS * 2 : MESSAGE_MS);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function hw(label, cls, onclick, disabled = false) {
  const b = el('button', `hw small ${cls}`, label);
  b.disabled = disabled;
  b.onclick = onclick;
  return b;
}

/** What is selected in LUNA: a clip (clicked on the timeline) or the focused track. */
function selection() {
  if (!session) return null;
  const picked = AddOnLogic.selectedClip(session);
  if (picked) return { kind: 'clip', ...picked };
  const track = session.focusedTrack.value ?? null;
  return track ? { kind: 'track', track } : null;
}

// ---------- Top: connection, what the OX is on, what recording will do ----------

function paintConn() {
  const host = oxHost;
  const state = ox.connected ? 'on' : oxError ? 'bad' : '';
  $('jewel').className = `led ${state}`;
  $('conn').className = `conn ${state}`;
  const shown = viaLink ? (link?.devices.find((d) => OxLink.knows({ devices: [d] }, host))?.name ?? host) : host;
  $('connText').textContent = ox.connected ? (viaLink ? shown : host.replace(/\.local$/, ''))
    : needsLink || oxError ? "Can't reach the OX"
    : searching ? 'Looking for your OX...'
    : !host ? 'Set up your OX' : `Looking for ${shown}`;
  $('linkHelp').hidden = !needsLink;
  for (const b of document.querySelectorAll('.start-link')) { b.disabled = startingLink; b.textContent = startingLink ? 'Starting' : 'Start OX Link'; }
  $('hostRow').hidden = needsLink;
  $('hostHelp').hidden = needsLink;
  $('hostLabel').hidden = needsLink;
  $('conn').title = host ? `OX at ${host}${viaLink ? ' (through OX Link)' : ''}. Setup` : 'Setup';
  $('conn').setAttribute('aria-label', `${$('connText').textContent}. Setup`);
  $('oxConnect').disabled = connecting;
  $('oxConnect').textContent = connecting ? 'Connecting' : 'Connect';
  $('oxFind').disabled = searching || connecting;
  $('oxFind').textContent = searching ? 'Searching' : 'Find';
}

/**
 * Help and Setup are pages of their own: while one is open it takes over the panel (the bar, the
 * line under it and the tracks are hidden), and its Back button returns to the tracks.
 */
function syncPage() {
  document.body.classList.toggle('paged', $('help').classList.contains('open') || $('host').classList.contains('open'));
}

function showHelp(open) {
  if (open && $('host').classList.contains('open')) showHost(false);
  $('help').classList.toggle('open', open);
  $('helpToggle').setAttribute('aria-expanded', String(open));
  syncPage();
  if (open) window.scrollTo(0, 0);
}

function showHost(open, focus = false) {
  if (open) showHelp(false);
  $('host').classList.toggle('open', open);
  $('hostToggle').setAttribute('aria-expanded', String(open));
  $('conn').setAttribute('aria-expanded', String(open));
  syncPage();
  if (!open) { $('hostError').textContent = ''; $('hostFound').innerHTML = ''; if (!searching) $('hostNote').textContent = ''; }
  if (focus) { $('oxHost').focus(); $('oxHost').select(); }
}

/** The line under the bar: what the OX is on, or what's wrong, with one way to fix it. */
function paintNow() {
  const line = $('nowline');
  line.textContent = '';
  const fix = () => { const b = el('button', 'linkish', 'How to fix'); b.onclick = () => showHost(true); return b; };
  const bad = !ox.connected;
  line.className = `nowline${bad ? ' bad' : ''}`;
  if (searching && bad) return line.append('Looking for your OX...');
  if (needsLink) return line.append("Can't reach your OX: OX Link isn't running.", fix());
  if (!oxHost) return line.append('Set up your OX.', fix());
  if (bad) return line.append(connecting ? 'Connecting to your OX...' : "Can't reach your OX.", ...(connecting ? [] : [fix()]));
  if (!live || !session) return line.append('Reading the OX...');
  const now = oxNow ?? AddOnLogic.oxNow(session, live, lastLoaded); // this line is also painted between repaints
  if (now.kind === 'none') return line.append("OX isn't on any track's sound");
  line.append('OX is on ', el('b', '', now.name), `'s sound${now.changed ? ', changed' : ''}`);
}

/**
 * How a saved sound stands against the OX: 'on' (the OX is on it), 'changed' (Recall sent it, and
 * the OX has since moved to something no track or clip has), or 'off'. Before the OX has been
 * read, everything is 'off'.
 */
function toneState(tone, key) {
  if (!ox.connected || !live) return 'off';
  if (AddOnLogic.sameTone(tone, live)) return 'on';
  return lastLoaded === key && oxNow?.changed ? 'changed' : 'off';
}

function lamp(state) {
  if (state === 'on') { const l = el('span', 'lamp on'); l.append(el('span', 'led on'), 'On the OX'); return l; }
  if (state === 'changed') { const l = el('span', 'lamp changed'); l.append(el('span', 'led half'), 'Changed'); return l; }
  return el('span', 'led');
}

/** Recall for a saved sound: off while recording (never change the amp mid-take) and offline. */
function recallButton(tone, key, whose, { lit = false, mini = false } = {}) {
  const recording = session.recordTakes.items.length > 0;
  const b = hw('Recall', lit && !recording && ox.connected ? 'lit' : '', (e) => { e.stopPropagation(); loadTone(tone, key, whose); }, busy || recording || !ox.connected);
  if (mini) b.className = b.className.replace('small', 'mini');
  b.title = recording ? 'Recall is off while recording' : `Put ${whose}'s sound on the OX`;
  b.setAttribute('aria-label', `Recall ${whose}'s sound`);
  return b;
}

/** "What changed": which parts of the OX differ from a saved sound, shown only when asked. */
function whatChanged(tone, key, cls) {
  const wrap = el('div', cls);
  const open = openDiffs.has(key);
  const b = el('button', 'linkish what', `${open ? '▾' : '▸'} What changed`);
  b.setAttribute('aria-expanded', String(open));
  b.onclick = (e) => { e.stopPropagation(); if (open) openDiffs.delete(key); else openDiffs.add(key); repaint(); };
  wrap.appendChild(b);
  if (open) wrap.appendChild(el('div', 'diffs', AddOnLogic.differences(tone, live).join(' · ') || 'Nothing the panel saves'));
  return wrap;
}

/**
 * The OX tracks, each one box: its name, a lamp, and Recall; the track selected in LUNA also gets
 * Save to track when the OX isn't on its sound. A track opens to show its clips, by itself when
 * one of them is selected in LUNA or while it records. A selected audio track that isn't linked
 * gets a dashed row of its own at the end, with Link track. Only Recall changes the OX.
 */
function renderList() {
  const root = $('list');
  for (const c of root.querySelectorAll('.clips')) clipScroll.set(c.dataset.track, c.scrollTop);
  root.innerHTML = '';
  if (!session) return root.appendChild(el('p', 'empty', 'Open a session in LUNA.'));
  const sel = selection();
  const focused = sel?.track ?? null;
  const tracks = session.visibleTracks.filter((t) => AddOnLogic.isOxTrack(session, t));
  // Only an audio track can be recorded through the OX: drum outputs, instruments and buses are never offered.
  const kind = focused?.trackType?.value;
  const outsider = focused && !AddOnLogic.isOxTrack(session, focused) && (kind === undefined || kind === 'audio') ? focused : null;
  if (!tracks.length) root.appendChild(el('p', 'empty', outsider ? 'No tracks are linked yet.' : 'No tracks are linked yet. Select an audio track in LUNA to start.'));
  const recordingOn = new Map();
  for (const [, entry] of takes) recordingOn.set(entry.take.trackUid.value, entry);
  for (const track of tracks) root.appendChild(renderTrack(track, sel, recordingOn.get(track.id)));
  if (outsider) {
    // Its own place: the slot the track will take in the list once it is linked.
    const name = outsider.name.value ?? outsider.id;
    root.appendChild(el('div', 'divider', 'Selected in LUNA'));
    const box = el('div', 'grp cand');
    const top = el('div', 'rtop');
    const head = el('span', 'rh');
    head.append(el('span', 'chev', ''), el('span', 'rname', name));
    const acts = el('span', 'ract');
    const b = hw('Link track', 'lit', () => useOx(outsider), busy);
    b.title = `Link ${name} to OX Recall. The OX's sound is saved to it.`;
    b.setAttribute('aria-label', `Link ${name} to OX Recall`);
    acts.appendChild(b);
    top.append(head, el('span', 'pill', 'Not linked'), acts);
    box.appendChild(top);
    root.appendChild(box);
  }
  for (const c of root.querySelectorAll('.clips')) c.scrollTop = clipScroll.get(c.dataset.track) ?? 0;
  const clipId = sel?.kind === 'clip' ? sel.clip.id : null;
  if (clipId !== shownClip) root.querySelector('.cl.sel')?.scrollIntoView({ block: 'nearest' });
  shownClip = clipId;
}

function renderTrack(track, sel, rec) {
  const name = track.name.value ?? track.id;
  const focused = sel?.track.id === track.id;
  const selClipId = focused && sel.kind === 'clip' ? sel.clip.id : null;
  const def = AddOnLogic.trackTone(session, track);
  const key = `track:${track.id}`;
  const state = def ? toneState(def, key) : 'off';
  const recording = session.recordTakes.items.length > 0;
  // Clips recorded through the OX, plus the selected clip even when it has no sound saved.
  const lines = AddOnLogic.trackClips(session, track).filter((c) => c.tone || c.clip.id === selClipId);
  const auto = !!rec || selClipId != null;
  if (auto && !wasAuto.get(track.id)) openChoice.delete(track.id); // a new reason to open beats an old choice
  wasAuto.set(track.id, auto);
  // Every OX track opens: its clips, when it has any, and the unlink line at the bottom.
  const open = openChoice.has(track.id) ? openChoice.get(track.id) : auto;

  const box = el('div', `grp display${focused && sel.kind === 'track' ? ' picked' : ''}${state === 'on' ? ' is-on' : ''}`);
  const top = el('div', 'rtop');
  const head = el('button', 'rh');
  head.append(el('span', 'chev', open ? '▾' : '▸'), el('span', 'rname', name));
  if (track.recordEnabled.value) head.appendChild(el('span', 'rectag', 'REC'));
  head.setAttribute('aria-expanded', String(open));
  head.title = `${name}: select the track and ${open ? 'close' : 'open'} it`;
  // The first click on another track selects it in LUNA and opens it; after that, clicks open and close.
  head.onclick = () => {
    if (session.focusedTrack.value?.id !== track.id) {
      session.context.lastSelectedTrack.set(track.id); // selecting only shows; it never changes the OX
      openChoice.set(track.id, true);
    } else openChoice.set(track.id, !open);
    repaint();
  };
  const right = el('span', 'rright');
  if (def) right.appendChild(lamp(state));
  const acts = el('span', 'ract');
  // Save to track: only on the track selected in LUNA, and only when there is something to save.
  if (focused && state !== 'on' && !recording) {
    const save = hw('Save to track', 'lit', (e) => { e.stopPropagation(); saveDefault(track); }, busy || !ox.connected || !live);
    if (save.disabled) save.className = save.className.replace(' lit', '');
    save.title = `Save the OX's sound to ${name}`;
    acts.appendChild(save);
  }
  if (def && state !== 'on') acts.appendChild(recallButton(def, key, name, { lit: focused }));
  top.append(head, right);
  if (acts.childNodes.length) top.appendChild(acts);
  box.appendChild(top);
  if (!def) box.appendChild(el('div', 'rsub', 'No sound saved yet'));
  if (state === 'changed') box.appendChild(whatChanged(def, key, 'under'));

  if (open && (lines.length || rec)) {
    const list = el('div', 'clips');
    list.dataset.track = track.id;
    const explained = new Set(); // one "What changed" per recording, under the selected clip if it's one of them
    const owner = (c) => lines.find((x) => x.sourceUid === c.sourceUid && x.clip.id === selClipId) ?? lines.find((x) => x.sourceUid === c.sourceUid);
    for (const c of lines) {
      const line = el('div', `cl${c.clip.id === selClipId ? ' sel' : ''}`);
      line.appendChild(el('span', 'cn', c.name));
      list.appendChild(line);
      if (!c.tone) { line.appendChild(el('span', 'note', 'no OX sound')); continue; }
      if (c.tone.unknown) { line.appendChild(el('span', 'note', 'OX was offline')); continue; }
      const ckey = `source:${c.sourceUid}`;
      const cstate = toneState(c.tone, ckey);
      if (cstate === 'on') { line.classList.add('is-on'); line.appendChild(el('span', 'led on')); line.title = 'The OX is on the sound this clip was recorded with'; continue; }
      line.appendChild(el('span', `led${cstate === 'changed' ? ' half' : ''}`));
      if (cstate === 'changed') line.appendChild(el('span', 'cst', 'Changed'));
      line.appendChild(recallButton(c.tone, ckey, c.name, { lit: cstate === 'changed' || c.clip.id === selClipId, mini: true }));
      if (cstate === 'changed' && owner(c) === c && !explained.has(ckey)) { explained.add(ckey); list.appendChild(whatChanged(c.tone, ckey, 'cunder')); }
    }
    if (rec) {
      const line = el('div', 'cl rec');
      line.appendChild(el('span', 'cn', 'Recording'));
      const saved = rec.info?.saved;
      if (saved?.unknown || (!saved && !ox.connected)) line.appendChild(el('span', 'note', 'OX offline: sound not saved'));
      line.appendChild(el('span', 'led recdot'));
      list.appendChild(line);
    }
    box.appendChild(list);
  }
  if (open) {
    // Below the clips and outside their scrolling, so it is always in the same place.
    const tools = el('div', 'rtools');
    const unlink = el('button', 'linkish', 'Unlink track from OX Recall');
    unlink.disabled = busy || !!rec;
    unlink.onclick = (e) => { e.stopPropagation(); unmark(track); };
    unlink.title = rec ? `${name} is recording` : `${name} leaves this list. Its sound and its clips' sounds are kept.`;
    unlink.setAttribute('aria-label', `Unlink ${name} from OX Recall`);
    tools.appendChild(unlink);
    box.appendChild(tools);
  }
  return box;
}

function repaint() {
  oxNow = session && live && ox.connected ? AddOnLogic.oxNow(session, live, lastLoaded) : null;
  paintNow();
  renderList();
}

// ---------- OX ----------

/**
 * Is OX Link running, and should the panel use it? Inside LUNA on a Mac it is the only way; elsewhere it
 * is used when it can see the OX the panel is set to (or any OX, before one is set).
 */
async function detectLink() {
  link = await OxLink.list();
  viaLink = !!link && (linkOnly || (link.devices.length > 0 && (!oxHost || OxLink.knows(link, oxHost))));
  needsLink = linkOnly && !link;
  ox.socketFactory = viaLink ? OxLink.socketFactory : DIRECT;
  paintConn(); paintNow();
  return viaLink;
}

/** Connect to what OX Link sees: the saved OX if it's there, else the only one, else let the user pick. */
async function connectThroughLink({ quiet = false } = {}) {
  const devices = link?.devices ?? [];
  if (OxLink.knows(link, oxHost)) return connectOx({ quiet, address: oxHost });
  // A saved OX name that OX Link doesn't see yet: wait for that OX rather than quietly switching
  // to another one. (A saved IP may just be the same OX at a new address, so that may switch.)
  if (quiet && oxHost && !OxClient.rangeOf(oxHost)) return;
  if (devices.length === 1) { $('oxHost').value = devices[0].host; return connectOx({ quiet, address: devices[0].host }); }
  if (devices.length > 1) return pickOx(devices.map((d) => ({ label: d.name, host: d.host })));
  if (!quiet) {
    showHost(true);
    $('hostError').textContent = "OX Link is running but doesn't see an OX on this network. Check the OX is on and on the same network.";
  }
}

function pickOx(choices) {
  showHost(true, false);
  const row = $('hostFound');
  row.innerHTML = '';
  row.append(`Found ${choices.length} OXes:`);
  for (const c of choices) row.appendChild(hw(c.label, '', () => { $('oxHost').value = c.host; row.innerHTML = ''; connectOx({ address: c.host }); }));
  paintConn();
}

async function connectOx({ quiet = false, address = $('oxHost').value } = {}) {
  if (connecting) return;
  if (needsLink) { paintConn(); return showHost(true, false); }
  const parsed = AddOnLogic.parseOxAddress(address);
  if (parsed.error) {
    $('hostError').textContent = parsed.error;
    return showHost(true);
  }
  if (!quiet) { $('hostError').textContent = ''; $('oxHost').value = parsed.host; }
  if (!linkOnly) { // where OX Link isn't the only way, an address it doesn't know is reached directly
    viaLink = !!link && OxLink.knows(link, parsed.host);
    ox.socketFactory = viaLink ? OxLink.socketFactory : DIRECT;
  }
  if (parsed.host !== oxHost) { live = null; oxRig = null; }
  oxHost = parsed.host;
  localStorage.setItem(STORE + 'host', oxHost);
  connecting = true;
  lastAttempt = Date.now();
  if (!quiet) oxError = ''; // a background retry keeps showing the last failure until it works
  paintConn(); repaint();
  try {
    await ox.connect(oxHost);
    oxError = '';
  } catch (e) {
    oxError = e.message;
  }
  connecting = false;
  if (!quiet) {
    if (ox.connected) showHost(false, false);
    else {
      $('hostError').textContent = `No answer from an OX at ${oxHost}.`;
      showHost(true);
    }
  }
  paintConn(); await check();
  // An IP that stopped answering may just be the router handing the OX a new one: look for it.
  if (!ox.connected && !viaLink && !linkOnly && OxClient.rangeOf(oxHost) && Date.now() - lastSearch >= REFIND_EVERY_MS) findOx({ quiet: true });
}

/**
 * Search the network for OXes (read-only). One found: use it. Several: list them to pick from.
 * `quiet` is the automatic re-find after an IP stopped answering: it only switches when it finds
 * exactly one OX, and says nothing when it finds none.
 */
async function findOx({ quiet = false } = {}) {
  if (searching) return;
  // OX Link already knows every OX on the network; where it is the only way, it is the only way to look.
  await detectLink();
  if (linkOnly || link?.devices.length) {
    if (!link) return showHost(true, false); // the card with Start OX Link
    viaLink = true;
    ox.socketFactory = OxLink.socketFactory;
    return connectThroughLink({ quiet });
  }
  searching = true;
  lastSearch = Date.now();
  $('hostError').textContent = '';
  $('hostFound').innerHTML = '';
  paintConn();
  let found = [];
  try {
    found = await OxClient.find({
      first: OxClient.rangeOf(oxHost),
      onRange: (prefix, i, n) => { $('hostNote').textContent = `Looking for your OX on ${prefix}.x (${i + 1} of ${n})...`; },
      cancelled: () => ox.connected && quiet,
    });
  } finally {
    searching = false;
    $('hostNote').textContent = '';
  }
  if (ox.connected && quiet) return paintConn();
  if (found.length === 1) {
    const moved = oxHost && oxHost !== found[0];
    $('oxHost').value = found[0];
    await connectOx({ quiet, address: found[0] });
    if (ox.connected) { showHost(false, false); say(moved ? `Your OX moved to ${found[0]}. Connected.` : `Found your OX at ${found[0]}.`); }
    return;
  }
  if (found.length > 1) {
    showHost(true, false);
    const row = $('hostFound');
    row.append(`Found ${found.length} OXes:`);
    for (const host of found) {
      const b = hw(host, '', () => { $('oxHost').value = host; row.innerHTML = ''; connectOx({ address: host }); });
      row.appendChild(b);
    }
    return paintConn();
  }
  if (!quiet) {
    showHost(true);
    $('hostError').textContent = "Couldn't find an OX. Check it's on and on the same network as this computer, or type its IP address or name.";
  }
  paintConn();
}

/** Read the OX once: its current sound and rig name. Reading never changes it. */
async function check() {
  if (reading || !ox.connected) { if (!ox.connected) live = null; paintConn(); return repaint(); }
  reading = true;
  try {
    live = await ox.readTone();
    oxRig = await ox.readRigName();
  } catch (e) {
    if (!ox.connected) { oxError = e.message; live = null; paintConn(); }
  } finally {
    reading = false;
  }
  repaint();
}

setInterval(() => {
  const typing = document.activeElement?.tagName === 'INPUT';
  if (document.hidden || busy || typing) return;
  if (ox.connected) return check();
  // Where OX Link is the only way (or already in use): look for it, and connect once it's there.
  if ((linkOnly || viaLink) && !connecting && Date.now() - lastAttempt >= LINK_RETRY_MS) {
    lastAttempt = Date.now();
    detectLink().then((useLink) => { if (useLink && link.devices.length) connectThroughLink({ quiet: true }); });
    return;
  }
  // Lost the OX: keep trying the saved address. Reconnecting only reads; it never sends a tone.
  if (oxHost && !connecting && Date.now() - lastAttempt >= RETRY_EVERY_MS) {
    connectOx({ quiet: true, address: oxHost });
  }
}, CHECK_EVERY_MS);

async function openOxApp() {
  if (!luna || !(await luna.gui.available())) return say('Open OX app works when this panel runs inside LUNA.');
  try {
    await luna.gui.openUrl(`file://${OX_APP}`);
    say('Opening the OX app.');
  } catch {
    try {
      await luna.gui.revealPath(OX_APP);
      say("LUNA couldn't open the OX app directly, so it's shown in Finder.");
    } catch (e) {
      say(`Couldn't open the OX app: ${e.message}`, true);
    }
  }
}

/** Where LUNA says this add-on's icon is. OX Link ships in the same folder. '' when LUNA doesn't say. */
async function ownIconPath() {
  try {
    await luna.gui.addOns.load();
    await luna.gui.addOns.membersReady();
    return luna.gui.addOns.byId(ADD_ON_ID)?.icon.value || '';
  } catch {
    return '';
  }
}

/**
 * Start the OX Link that ships with this add-on. LUNA opens it (unpacking it the first time);
 * the panel connects once it runs. If it doesn't start, show its folder in Finder so it can be
 * opened by hand.
 */
async function startOxLink() {
  if (startingLink) return;
  if (!luna || !(await luna.gui.available())) return say('Start OX Link works when this panel runs inside LUNA.', true);
  startingLink = true;
  paintConn();
  say('Starting OX Link...');
  try {
    const places = OxLink.places(await ownIconPath());
    if (await OxLink.start({ openUrl: (url) => luna.gui.openUrl(url), places })) {
      say('OX Link is running. If macOS asks, allow it to find devices on your local network.');
      if (await detectLink() && link.devices.length) connectThroughLink({ quiet: true });
      return;
    }
    try {
      await luna.gui.revealPath(`${places[0].folder}/OX Link.zip`);
      say("OX Link didn't start, so it's shown in Finder. Double-click OX Link.zip, then OX Link in the folder that appears.", true);
    } catch {
      say("OX Link didn't start. Install OX Tone Recall again, or see Help.", true);
    }
  } finally {
    startingLink = false;
    paintConn();
  }
}

// ---------- Actions ----------

async function run(label, fn) {
  busy = true; repaint(); say(`${label}...`);
  try { say(await fn()); } catch (e) { say(`${label} failed: ${e.message}`, true); }
  busy = false;
  await check();
}

/** Start using the OX on a track: mark it and, when the OX is reachable, save what it's on now. */
function useOx(track) {
  return run('Saving', async () => {
    await AddOnLogic.markTrack(session, track, true);
    const name = track.name.value ?? track.id;
    if (!ox.connected) return `${name} is linked to OX Recall. Save its sound once the OX is back.`;
    await AddOnLogic.captureToTrack(session, track, ox, null);
    return `${name} is linked to OX Recall. Its sound is saved, and every clip recorded on it keeps its own.`;
  });
}

function unmark(track) {
  return run('Saving', async () => {
    await AddOnLogic.markTrack(session, track, false);
    openChoice.delete(track.id); // if it uses the OX again later, it starts closed
    return `${track.name.value} is unlinked from OX Recall. Its clips keep their sounds.`;
  });
}

/** Save to track: what the OX is on now becomes the track's sound. The OX is only read. */
function saveDefault(track) {
  return run('Saving', async () => {
    await AddOnLogic.captureToTrack(session, track, ox, null);
    return `Saved the OX's sound to ${track.name.value ?? track.id}. LUNA's Undo reverses it.`;
  });
}

/** Recall: the only action that changes the OX. `whose` is the track or clip the sound belongs to. */
function loadTone(tone, key, whose) {
  return run('Recalling', async () => {
    const r = await ox.writeTone(tone);
    lastLoaded = key;
    openDiffs.delete(key);
    if (r.failed.length) console.warn('OX load failures', r.failed);
    const notes = [
      r.skipped.length && `${r.skipped.length} settings skipped because the OX has a different plug-in there.`,
      r.failed.length && `${r.failed.length} settings the OX refused.`,
      r.left.length && `${r.left.length} ${r.left.length === 1 ? "setting didn't" : "settings didn't"} stay where Recall put ${r.left.length === 1 ? 'it' : 'them'}. See What changed.`,
    ].filter(Boolean);
    return [`Recalled ${whose}'s sound.`, ...notes].join(' ');
  });
}

// ---------- Recording ----------

/** Follow the takes being recorded: save each one's OX sound as soon as its file is named. */
function onTakes() {
  const now = new Set();
  for (const take of session.recordTakes.items) {
    now.add(take.id);
    if (!takes.has(take.id)) {
      takes.set(take.id, { take, info: null });
      keep(take.sourceUid.onChange(() => capture(take)));
    }
    capture(take);
  }
  for (const [id, entry] of takes) {
    if (now.has(id)) continue;
    takes.delete(id);
    if (entry.info) settleLater(entry.info);
  }
  repaint();
}

async function capture(take) {
  const entry = takes.get(take.id);
  if (!entry || entry.info || capturing.has(take.id) || !take.sourceUid.value || !take.trackUid.value) return;
  capturing.add(take.id);
  try {
    const info = { trackUid: take.trackUid.value, sourceUid: take.sourceUid.value, start: take.start.value };
    const saved = await AddOnLogic.captureTake(session, take, ox, { rig: oxRig });
    entry.info = { ...info, saved };
    // A take shorter than the read of the OX has already ended: its clip still needs its sound.
    if (!takes.has(take.id)) settleLater(entry.info);
    repaint(); // the recording line shows when nothing could be saved; no message needed
  } catch (e) {
    say(`Couldn't save the OX's sound with the recording: ${e.message}`, true);
  } finally {
    capturing.delete(take.id);
  }
}

/** LUNA turns a take into a clip shortly after it stops; make sure that clip finds its tone. */
function settleLater(info) {
  const s = session;
  for (const ms of SETTLE_AFTER_MS) {
    setTimeout(async () => {
      if (session !== s) return;
      try {
        const track = s.tracks.byId(info.trackUid);
        const playlist = track && s.playlistFor(track);
        await playlist?.clips.load();
        await playlist?.clips.membersReady();
        await AddOnLogic.settleTake(s, info);
      } catch { /* try again on the next round */ }
      repaint();
    }, ms);
  }
}

// ---------- LUNA ----------

/** Load the clips of each visible track's active playlist, so a clicked clip can be found. */
async function loadClips() {
  await session.playlists.membersReady();
  await Promise.all(session.visibleTracks.map((t) => session.playlistFor(t)?.clips.load()));
  bindClips();
  repaint();
}

let clipReleases = [];
function bindClips() {
  for (const u of clipReleases) u();
  clipReleases = session.visibleTracks.flatMap((t) => {
    const pl = session.playlistFor(t);
    return pl ? [pl.clips.onChange(repaint)] : [];
  });
}

async function bindSession() {
  release();
  session = luna.sessions.current();
  takes.clear();
  if (!session) return repaint();
  await session.ready();
  await session.tracks.membersReady();
  await AddOnLogic.loadStore(session);
  await AddOnLogic.sources(session).load();
  let note = null;
  try {
    const moved = await AddOnLogic.migrateComments(session);
    if (moved) note = [`Moved ${moved} preset${moved === 1 ? '' : 's'} out of track comments into the session.`, false];
  } catch (e) {
    note = [`Couldn't move presets out of track comments: ${e.message}`, true];
  }
  const ctx = session.context;
  const onSelect = () => repaint();
  keep(session.focusedTrack.onChange(onSelect));
  for (const prop of [ctx.selectionStart, ctx.selectionStop, ctx.selectionTracks]) keep(prop.onChange(onSelect));
  keep(session.tracks.onChange(() => { bindTracks(); loadClips(); }));
  keep(session.playlists.onChange(() => loadClips()));
  keep(session.recordTakes.onChange(onTakes));
  bindTracks();
  // Saved defaults and marks change from this panel, another open copy of it, and LUNA's undo.
  const store = AddOnLogic.store(session);
  keep(store.records.onChange(() => { repaint(); bindRecords(); }));
  keep(AddOnLogic.sources(session).records.onChange(repaint));
  bindRecords();
  await loadClips();
  if (note) say(...note);
}

let recordReleases = [];
function bindRecords() {
  for (const u of recordReleases) u();
  const store = AddOnLogic.store(session);
  recordReleases = (store.records.value ?? []).flatMap((id) => [store.value(id, AddOnLogic.FIELD).onChange(repaint), store.value(id, AddOnLogic.MARK_FIELD).onChange(repaint)]);
  keep(() => { for (const u of recordReleases) u(); recordReleases = []; });
}

let trackReleases = [];
function bindTracks() {
  for (const u of trackReleases) u();
  trackReleases = session.visibleTracks.flatMap((t) => [t.name.onChange(repaint), t.recordEnabled.onChange(repaint), t.playlistUid.onChange(() => loadClips())]);
  keep(() => { for (const u of trackReleases) u(); trackReleases = []; });
  keep(() => { for (const u of clipReleases) u(); clipReleases = []; });
}

async function connectLuna() {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('nowline').textContent = e instanceof Luna.NotRunning ? 'Waiting for LUNA...' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  $('openApp').disabled = !(await luna.gui.available());
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  await bindSession();
}

// ---------- Start ----------

const toggleHost = () => {
  const open = !$('host').classList.contains('open');
  if (open) $('oxHost').value = oxHost;
  showHost(open);
};
$('hostDone').onclick = () => showHost(false);
$('helpToggle').onclick = () => showHelp(!$('help').classList.contains('open'));
$('helpDone').onclick = () => { showHelp(false); $('helpToggle').focus(); };
$('hostToggle').onclick = toggleHost;
$('conn').onclick = toggleHost;
$('oxHost').onkeydown = (e) => {
  if (e.key === 'Enter') connectOx();
  if (e.key === 'Escape' && oxHost) { $('oxHost').value = oxHost; showHost(false, false); $('hostToggle').focus(); }
};
$('oxHost').oninput = () => { $('hostError').textContent = ''; };
$('oxConnect').onclick = () => connectOx();
$('oxFind').onclick = () => findOx();
for (const b of document.querySelectorAll('.start-link')) b.onclick = startOxLink; // in setup and in Help
$('linkGuide').hidden = !OxLink.runsOn(); // OX Link is a Mac app; elsewhere its Help section doesn't apply
$('openApp').hidden = !OxLink.runsOn(); // it opens the Mac OX app by its place in Applications; the Windows one's place isn't known
$('openApp').onclick = openOxApp;

// First run has no address: open the address panel and wait for one. Otherwise connect to
// the saved address; if it doesn't answer, connectOx opens the panel to change it.
const saved = AddOnLogic.parseOxAddress(localStorage.getItem(STORE + 'host') || '');
$('oxHost').value = saved.host ?? '';
oxHost = saved.host ?? '';
paintConn();
repaint();
(async () => {
  await detectLink();
  if (needsLink) return showHost(true, false); // the card with Start OX Link; the interval connects once it runs
  if (viaLink) return connectThroughLink();
  if (saved.host) connectOx();
  else { showHost(true, false); findOx(); } // first run: look for it straight away
})();
connectLuna();
