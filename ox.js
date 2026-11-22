// OX Tone Recall: talks to the OX Amp Top Box over Wi-Fi.
//
// Tone lives in the OX's live audio engine (mixerd, port 4740): the mixer (EQ, 1176, delay,
// plate, channel levels) and the cabinet/mic/room model. Only those controls are read or
// written. Speaker impedance and attenuation, outputs, Wi-Fi, firmware and factory reset are
// outside TONE_ROOTS and are refused by set().

const OX_MIXERD_PORT = 4740;
const OX_DEVICED_PORT = 4718; // rigs and presets; read-only here, for the rig name
const TONE_ROOTS = ['/mixers/0', '/device/inputs/cabinet_mic_room'];
const SKIP_CONTROL = /\/(meters|solo)(\/|$)/;

class OxClient {
  constructor({ socketFactory = (url) => new WebSocket(url), timeoutMs = 3000 } = {}) {
    this.socketFactory = socketFactory;
    this.timeoutMs = timeoutMs;
    this.host = null;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === 1;
  }

  /** Open the connection to mixerd. Resolves once the socket is open. */
  connect(host) {
    this.close();
    this.host = host;
    return OxClient._open(this.socketFactory, `ws://${host}:${OX_MIXERD_PORT}`, this.timeoutMs).then((ws) => {
      this.ws = ws;
      ws.onmessage = (e) => this._receive(e.data);
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        for (const [, p] of this.pending) p.reject(new Error('OX disconnected'));
        this.pending.clear();
      };
    });
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  static _open(factory, url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = factory(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error(`no answer from ${url}`)); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(ws); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot reach ${url}`)); };
    });
  }

  _receive(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const p = this.pending.get(msg.parameters?.message_id);
    if (!p) return;
    this.pending.delete(msg.parameters.message_id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.data);
  }

  _request(verb, path, query = {}, body) {
    if (!this.connected) return Promise.reject(new Error('OX not connected'));
    const id = this.nextId++;
    const params = new URLSearchParams({ ...query, message_id: String(id) }).toString();
    const line = `${verb} ${path}?${params}` + (body === undefined ? '' : ` ${JSON.stringify(body)}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OX timed out on ${verb} ${path}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(line);
    });
  }

  get(path, query) {
    return this._request('get', path, query);
  }

  /** Set one control's 0..1 value. Refuses anything outside the tone controls. */
  set(controlPath, normalized) {
    if (!OxClient.isToneControl(controlPath)) return Promise.reject(new Error(`refusing to write ${controlPath}`));
    if (typeof normalized !== 'number' || !(normalized >= 0 && normalized <= 1)) {
      return Promise.reject(new Error(`bad value ${normalized} for ${controlPath}`));
    }
    return this._request('set', `${controlPath}/normalized_value/value/`, { cmd_id: 'set_command' }, normalized);
  }

  static isToneControl(path) {
    return TONE_ROOTS.some((r) => path.startsWith(r + '/')) && path.includes('/controls/') && !SKIP_CONTROL.test(path);
  }

  /** Every tone control's 0..1 value, plus which plug-in sits in each effect slot. */
  async readTone() {
    const values = {};
    const plugins = {};
    for (const root of TONE_ROOTS) {
      const tree = await this.get(root, { recursive: 1, flatvalue: 1, propfilter: 'normalized_value,plugin_id' });
      OxClient.walk(root, tree, values, plugins);
    }
    return { values, plugins };
  }

  static walk(path, node, values, plugins) {
    const props = node?.properties || {};
    const parent = path.split('/').slice(-2, -1)[0];
    if (parent === 'controls' && typeof props.normalized_value === 'number' && OxClient.isToneControl(path)) {
      values[path] = props.normalized_value;
    }
    if (parent === 'effects' && 'plugin_id' in props) plugins[path] = props.plugin_id || '';
    for (const child of node?.children || []) OxClient.walk(`${path}/${child.path}`, child, values, plugins);
  }

  /**
   * Write saved values back, only those that differ from the OX now. Controls whose effect
   * slot holds a different plug-in than when saved are skipped.
   *
   * Some OX controls hold others: while the delay's Pan Link is on, Pan B follows Pan A, so a
   * value written to Pan B before the link comes off doesn't stay. So after writing, the OX is
   * read again and whatever still differs is written again, up to `passes` times. Returns what
   * happened: `changed` settings written, `left` the ones that still differ at the end.
   */
  async writeTone(saved, { tolerance = 1e-4, passes = 3 } = {}) {
    const result = { changed: 0, unchanged: 0, skipped: [], failed: [], left: [] };
    const written = new Set();
    const refused = new Set();
    for (let pass = 0; ; pass++) {
      const now = await this.readTone();
      const todo = [];
      for (const [path, value] of Object.entries(saved.values)) {
        const slot = path.slice(0, path.indexOf('/controls/'));
        const elsewhere = (saved.plugins && slot in saved.plugins && now.plugins[slot] !== saved.plugins[slot]) || !(path in now.values);
        if (elsewhere) { if (pass === 0) result.skipped.push(path); continue; }
        if (Math.abs(now.values[path] - value) <= tolerance) { if (pass === 0) result.unchanged++; continue; }
        if (!refused.has(path)) todo.push([path, value]);
      }
      if (!todo.length || pass === passes) { result.left = todo.map(([path]) => path); break; }
      for (const [path, value] of todo) {
        try {
          await this.set(path, value);
          written.add(path);
        } catch (e) {
          refused.add(path);
          result.failed.push(`${path}: ${e.message}`);
        }
      }
    }
    result.changed = written.size;
    return result;
  }

  /** The OX's current rig name, from deviced. Read-only; a separate short connection. */
  async readRigName() {
    const ws = await OxClient._open(this.socketFactory, `ws://${this.host}:${OX_DEVICED_PORT}`, this.timeoutMs);
    const ask = (path, id) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.timeoutMs);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.parameters?.message_id === id) { clearTimeout(timer); resolve(msg.data); }
      };
      ws.send(`get ${path}?message_id=${id}`);
    });
    try {
      const devices = await ask('/devices', 1);
      const uid = devices?.children?.[0]?.path;
      if (!uid) return null;
      const device = await ask(`/devices/${uid}`, 2);
      return device?.properties?.preset_name?.value ?? null;
    } finally {
      ws.close();
    }
  }
}

/**
 * Address ranges to search, most common home routers first: Linksys/Netgear, TP-Link, Xfinity,
 * Apple, eero, Google, Deco, Asus, and a few more. A page can't see this computer's own address,
 * so these are guesses; the range of the last address that worked is always tried first.
 */
OxClient.SEARCH_RANGES = ['192.168.1', '192.168.0', '10.0.0', '10.0.1', '192.168.4', '192.168.86', '192.168.68', '192.168.50', '192.168.2', '192.168.10', '172.16.0', '10.1.1'];

/**
 * Is there an OX at `host`? Asks the audio engine for the OX's cab, mic and room section, which
 * only an OX has. Read-only: one `get`, nothing is written. Resolves true or false.
 */
OxClient.isOx = function isOx(host, { socketFactory = (url) => new WebSocket(url), timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let ws;
    const done = (v) => { clearTimeout(timer); try { ws?.close(); } catch { /* already closed */ } resolve(v); };
    const timer = setTimeout(() => done(false), timeoutMs);
    try { ws = socketFactory(`ws://${host}:${OX_MIXERD_PORT}`); } catch { return done(false); }
    ws.onopen = () => ws.send('get /device/inputs/cabinet_mic_room?message_id=1');
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        done(msg.parameters?.message_id === 1 && !msg.error && !!msg.data);
      } catch { done(false); }
    };
    ws.onerror = () => done(false);
  });
};

/**
 * What is at `host`? The OX's audio engine also answers ordinary web requests, from any page,
 * so this asks it for the cab, mic and room section with one: 'ox' when it has one, 'alive' when
 * something answered or refused quickly but isn't (as far as this can tell) an OX, 'none' when
 * nothing answered in time. Read-only: one GET.
 */
OxClient.probe = async function probe(host, { fetchFn = (...a) => fetch(...a), timeoutMs = 1500 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchFn(`http://${host}:${OX_MIXERD_PORT}/device/inputs/cabinet_mic_room`, { signal: abort.signal, cache: 'no-store' });
    const msg = await res.json();
    return !msg.error && !!msg.data ? 'ox' : 'alive';
  } catch {
    return abort.signal.aborted ? 'none' : 'alive';
  } finally {
    clearTimeout(timer);
  }
};

const MAX_SOCKET_CHECKS = 32; // more "alive" addresses than this is an error from the network, not devices
const ROUTER_ENDS = [1, 254]; // where a home router usually sits in its range

/**
 * Look for OXes on the network, one address range at a time (`first` before the usual ones),
 * stopping after the first range with any. Resolves with their addresses, [] when none.
 * `onRange(prefix, index, count)` reports progress; `cancelled()` stops early.
 *
 * Each address gets a web request (`probe`), not a WebSocket. Chromium, which LUNA on Windows
 * and Chrome and Edge use, delays WebSockets once many are pending or have failed, so a sweep of
 * WebSockets finds nothing there and slows the real connection afterwards. Only when a range has
 * no OX by web request are its few answering addresses also asked by WebSocket (`isOx`), for an
 * OX that doesn't answer web requests. With `socketFactory` and no `fetchFn` (a caller bringing
 * its own sockets), every address is asked by WebSocket, as before.
 *
 * Ranges that exist on this network go first: Chromium keeps a dropped request's connection
 * attempt alive for a long while and only allows so many, so sweeping two ranges that aren't
 * there leaves no room to reach the one that is. A range is taken to exist when its router's
 * usual address (.1 or .254) answers or refuses; `first` still goes before all of them.
 */
OxClient.find = async function find({ first = null, ranges = OxClient.SEARCH_RANGES, socketFactory, fetchFn = socketFactory ? null : (...a) => fetch(...a), concurrency = 96, timeoutMs = 1500, onRange = () => {}, cancelled = () => false } = {}) {
  let order = [...new Set([first, ...ranges].filter(Boolean))];
  if (fetchFn && order.length > 1) {
    const here = new Set();
    await Promise.all(order.flatMap((prefix) => ROUTER_ENDS.map(async (end) => {
      if ((await OxClient.probe(`${prefix}.${end}`, { fetchFn, timeoutMs })) !== 'none') here.add(prefix);
    })));
    order = [...order.filter((p) => p === first), ...order.filter((p) => p !== first && here.has(p)), ...order.filter((p) => p !== first && !here.has(p))];
  }
  for (let r = 0; r < order.length; r++) {
    if (cancelled()) return [];
    const prefix = order[r];
    onRange(prefix, r, order.length);
    const found = [];
    const alive = [];
    let next = 1;
    const worker = async () => {
      while (next <= 254 && !cancelled()) {
        const host = `${prefix}.${next++}`;
        if (!fetchFn) { if (await OxClient.isOx(host, { socketFactory, timeoutMs })) found.push(host); continue; }
        const what = await OxClient.probe(host, { fetchFn, timeoutMs });
        if (what === 'ox') found.push(host);
        else if (what === 'alive') alive.push(host);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (!found.length && alive.length <= MAX_SOCKET_CHECKS) {
      for (const host of alive) {
        if (cancelled()) return [];
        if (await OxClient.isOx(host, { socketFactory, timeoutMs })) found.push(host);
      }
    }
    if (found.length) return found.sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]));
  }
  return [];
};

/** The address range ("10.0.0") of an IPv4 address, or null for a name. */
OxClient.rangeOf = (host) => (/^\d+\.\d+\.\d+\.\d+$/.test(host || '') ? host.split('.').slice(0, 3).join('.') : null);

/**
 * OX Link: a small Mac app that passes this panel's messages to the OX. Inside LUNA on a Mac it
 * is the only way to reach the OX, since LUNA lets add-on pages connect to this computer only.
 * It listens on LINK_URL, finds OXes by their network name, and refuses anything but an OX. It
 * ships zipped in this add-on's folder, and the panel asks LUNA to open it from there.
 */
const LINK_URL = 'ws://127.0.0.1:47474';
// In this add-on's folder: link/OX Link.zip, which the Mac unpacks beside itself into the folder
// link/OX Link, holding OX Link.app and version.txt.
const LINK_FOLDER = 'link';
const LINK_ZIP = 'OX Link.zip';
const LINK_UNPACKED = 'OX Link';
const LINK_APP = 'OX Link.app';
const LINK_MARK = 'version.txt';
const ADD_ONS_FOLDER = '/Library/Application Support/Universal Audio/LUNA/Add Ons';
const FOLDER_NAMES = ['OX Tone Recall', 'ox-tone-recall']; // what this add-on's folder is usually called
const fileUrl = (path) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;
const OxLink = {
  URL: LINK_URL,

  /** OX Link is a Mac app. Anywhere else the panel has no helper and reaches the OX directly. */
  runsOn(platform = globalThis.navigator?.platform ?? '') {
    return /^mac/i.test(platform);
  },

  /**
   * Where the OX Link that ships with this add-on could be, most likely first: for each, the
   * `folder` it is in and file:// URLs of its `zip` and its `app`, for luna.gui.openUrl. LUNA
   * doesn't tell a page which folder it is in, but it reports the full path of the add-on's icon,
   * and `link/` is beside it. After that, LUNA's Add Ons folder under the names this add-on is
   * usually installed as.
   */
  places(iconPath) {
    const icon = String(iconPath || '');
    const folders = icon.startsWith('/') && icon.lastIndexOf('/') > 0 ? [icon.slice(0, icon.lastIndexOf('/'))] : [];
    for (const name of FOLDER_NAMES) folders.push(`${ADD_ONS_FOLDER}/${name}`);
    return [...new Set(folders)].map((f) => {
      const folder = `${f}/${LINK_FOLDER}`;
      return { folder, zip: fileUrl(`${folder}/${LINK_ZIP}`), app: fileUrl(`${folder}/${LINK_UNPACKED}/${LINK_APP}`) };
    });
  },

  /**
   * Has the Mac unpacked OX Link in this add-on's own folder? The page can read its own files,
   * so it asks for the small text file that is unpacked along with the app.
   */
  async unpackedHere({ fetchFn = (...a) => fetch(...a) } = {}) {
    try {
      return (await fetchFn(`${LINK_FOLDER}/${encodeURIComponent(LINK_UNPACKED)}/${LINK_MARK}`, { cache: 'no-store' })).ok;
    } catch {
      return false;
    }
  },

  /**
   * Start OX Link. It ships zipped, because LUNA installs an add-on's files without the mark
   * that lets a program run, and the Mac puts that mark back when it unpacks a zip. So, for each
   * place OX Link could be: if it isn't unpacked in this add-on's folder yet, ask LUNA to open
   * the zip (the Mac unpacks it beside itself) and wait for it to appear; then ask LUNA to open
   * the app and wait for OX Link to answer. LUNA does nothing when a place has no such file, so
   * trying one is safe, and the next is only tried once the one before has had its time, so two
   * copies never start. A place whose zip didn't visibly unpack still gets its app opened, with
   * a shorter wait. Resolves with what OX Link reports, or null when it didn't start.
   */
  async start({ openUrl, places, unpacked = () => OxLink.unpackedHere(), list = () => OxLink.list(), unpackMs = 4000, waitMs = 6000, pollMs = 400, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    for (const place of places) {
      let there = false;
      try {
        there = await unpacked();
        if (!there) {
          await openUrl(place.zip);
          for (let waited = 0; waited < unpackMs && !there; waited += pollMs) { await sleep(pollMs); there = await unpacked(); }
        }
        await openUrl(place.app);
      } catch { continue; }
      for (let waited = 0; waited < (there ? waitMs : Math.min(waitMs, 2000)); waited += pollMs) {
        await sleep(pollMs);
        const info = await list();
        if (info) return info;
      }
    }
    return null;
  },

  /** What OX Link sees ({ version, devices: [{ name, host, address }] }), or null when it isn't running. */
  list({ socketFactory = (url) => new WebSocket(url), timeoutMs = 1200 } = {}) {
    return new Promise((resolve) => {
      let ws;
      let settled = false; // closing a socket that failed can report the failure again: answer once
      const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { ws?.close(); } catch { /* closed */ } resolve(v); };
      const timer = setTimeout(() => done(null), timeoutMs);
      try { ws = socketFactory(LINK_URL); } catch { return done(null); }
      ws.onopen = () => ws.send(JSON.stringify({ op: 'list' }));
      ws.onmessage = (e) => {
        try {
          const info = JSON.parse(e.data);
          done(info?.app === 'OX Link' ? { version: info.version, state: info.state, devices: Array.isArray(info.devices) ? info.devices : [] } : null);
        } catch { done(null); }
      };
      ws.onerror = () => done(null);
    });
  },

  /** Whether OX Link can see the OX at `host` (its name, network name or address). */
  knows(link, host) {
    const h = String(host || '').toLowerCase();
    return !!h && (link?.devices ?? []).some((d) => [d.name, d.host, d.address].some((x) => String(x || '').toLowerCase() === h));
  },

  /**
   * A socket factory for OxClient that goes through OX Link: ws://<host>:<port> becomes a
   * connection to OX Link that asks for that OX and port, then behaves like the direct socket.
   */
  socketFactory(url, { open = (u) => new WebSocket(u) } = {}) {
    const m = String(url).match(/^ws:\/\/([^/:]+):(\d+)/);
    const w = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null };
    const ws = open(LINK_URL);
    let ready = false;
    w.send = (data) => ws.send(data);
    w.close = () => { try { ws.close(); } catch { /* closed */ } };
    ws.onopen = () => ws.send(JSON.stringify({ op: 'connect', host: m?.[1], port: Number(m?.[2]) }));
    ws.onmessage = (e) => {
      if (ready) return w.onmessage?.(e);
      let reply = null;
      try { reply = JSON.parse(e.data); } catch { /* not a reply */ }
      if (reply?.ok === true) { ready = true; w.readyState = 1; w.onopen?.(); }
      else { w.onerror?.(new Error(reply?.error || 'OX Link refused')); w.close(); }
    };
    ws.onerror = () => w.onerror?.();
    ws.onclose = () => { w.readyState = 3; w.onclose?.(); };
    return w;
  },
};

globalThis.OxClient = OxClient;
globalThis.OxLink = OxLink;
