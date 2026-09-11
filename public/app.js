// Tab switching only. Save/Save as... are non-functional stubs for now —
// no click handlers, no profile logic yet.
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// --- Zones tab ---
//
// Two states only, not three (see CLAUDE.md "Two-state model: Server vs.
// Profile") -- the old draft layer (unsaved, in-browser-only edits, lost on
// navigation) is retired entirely:
//   Server  -- live meta.zones, evaluated by SignalK core.
//   Profile -- profiles.Default.zones, our own persisted config.
// Editing a row auto-saves into Profile (debounced); there's nothing else
// to lose by navigating away. "editableZones" below is the on-screen
// editable view of Profile for whichever row is expanded, not a separate
// unsaved copy of it.

const ZONE_STATE_CLASS = {
  nominal: 'zone-state-nominal',
  alert: 'zone-state-alert',
  warn: 'zone-state-warn',
  alarm: 'zone-state-alarm',
  emergency: 'zone-state-emergency'
};

let allPaths = [];
let defaultProfileZones = {};
let expandedPath = null;

// Only relevant for whichever row is currently expanded (accordion is
// single-open, so one set of live-view state is enough). undefined = this
// row hasn't fetched live data yet, still showing Profile. null = fetched,
// server has no live zones for this path. array = fetched live zones.
let liveZones;
let liveFetchError = null;
let liveSyncStatus = null; // {type: 'pending'|'error', message} -- Get live's own network status

// Live value marker: one WebSocket subscription for whichever row is
// expanded, opened on expand and closed on collapse/switch — see the header
// click handler. liveValue undefined = no reading yet; liveValueError set on
// socket failure. Distinct from liveZones above -- this is the path's
// current numeric reading, not its zone bounds.
let liveValueSocket = null;
let liveValue;
let liveValueError = null;

// The editable view of Profile for whichever row is expanded -- same
// single-active-row pattern as liveZones/liveValue above. Plain numeric
// inputs, not drag -- that's deliberately deferred to a later session.
// A path's real zones are an array (a warn band and a separate alarm band
// on the same path is normal), so this is a list, not a single triple.
let editableZones = [];
let autosaveTimer = null;
let autosaveStatus = null; // {type: 'pending'|'success'|'error', message} -- editing -> Profile
let commitStatus = null; // {type: 'pending'|'success'|'error', message} -- Commit's own Profile -> Server push

// Global Refresh/Send-to-server state (see CLAUDE.md "Two-state model").
// mismatchedPaths: null = never refreshed (no badges shown); Set<path> =
// the result of the last Refresh click. Send-to-server always re-checks
// fresh at click time rather than trusting this.
let mismatchedPaths = null;
let refreshStatus = null; // {type: 'pending'|'success'|'error', message}
// sendStatus: null (idle) | {type:'checking'} | {type:'confirm', count, paths} |
// {type:'sending'} | {type:'success'|'error'|'none', message}
let sendStatus = null;

const AUTOSAVE_DEBOUNCE_MS = 600;

function emptyZoneRow() {
  return { lower: '', upper: '', state: 'alarm', message: undefined };
}

// Converts a Profile/live zones array (numbers, per the meta.zones shape)
// into the editable row shape (strings, one per input). An empty/missing
// input starts the editor with one blank row rather than nothing, so
// there's always something to type into without an extra "Add zone" click.
// There's no UI for `message` (not part of this session's scope) -- carried
// through untouched rather than dropped, see editableRowsToZones below for
// why that matters now that edits auto-save.
function zonesToRows(zones) {
  if (!zones || zones.length === 0) return [emptyZoneRow()];
  return zones.map((z) => ({
    lower: typeof z.lower === 'number' ? String(z.lower) : '',
    upper: typeof z.upper === 'number' ? String(z.upper) : '',
    state: z.state || 'alarm',
    message: z.message
  }));
}

// The reverse: editable rows -> a clean zones array ready to send to the
// backend. A row left fully blank (e.g. an unused "Add zone" row) is just
// not-yet-used, not an error -- skipped silently. A genuinely empty result
// (every zone removed) is itself a legitimate end state -- "no alarm on
// this path" -- and both /commit-zone and /persist-zone accept it.
// `message` is passed through even though there's no input for it: under
// the old draft-based design a message set by something other than this
// UI (e.g. an external tool) only got silently dropped if the user
// explicitly clicked Commit. Under auto-save, ANY edit -- typing in a
// different zone's bound, changing a state dropdown -- now re-saves the
// whole row on every change, so without this the message would vanish on
// the very next keystroke, not just on an explicit save. Also matters for
// Refresh/Send-to-server's comparison below, which treats message as part
// of a zone's identity -- dropping it here would show every such path as
// permanently "differs from server" no matter what.
function editableRowsToZones(rows) {
  const zones = [];
  for (const row of rows) {
    const lowerText = row.lower.trim();
    const upperText = row.upper.trim();
    const lower = lowerText === '' ? undefined : Number(lowerText);
    const upper = upperText === '' ? undefined : Number(upperText);
    if (lower === undefined && upper === undefined) continue;
    const zone = { lower: lower, upper: upper, state: row.state };
    if (row.message) zone.message = row.message;
    zones.push(zone);
  }
  return zones;
}

function pathSource(path) {
  return path.split('.')[0];
}

function formatLiveValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  return JSON.stringify(value);
}

// WS stream at /signalk/v1/stream, subscribe=none on connect so nothing is
// sent until we explicitly ask for this one path — confirmed against
// signalk-server source (src/interfaces/ws.js: query.subscribe === 'none'
// skips the default self-subscription; src/subscriptionmanager.js: a
// subscribe message is {context, subscribe: [{path, period}]}, context
// 'vessels.self' matches the own vessel). Deltas arrive as
// {updates: [{values: [{path, value}]}]} — distinct from the meta deltas
// used to set zones, which use updates[].meta instead of updates[].values.
function openLiveValueSocket(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/signalk/v1/stream?subscribe=none');

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        context: 'vessels.self',
        subscribe: [{ path: path, period: 1000 }]
      })
    );
  });

  ws.addEventListener('message', (evt) => {
    // Guard against a stale socket's trailing message landing after a
    // different row has already been expanded.
    if (path !== expandedPath) return;
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }
    if (!msg.updates) return;
    msg.updates.forEach((update) => {
      (update.values || []).forEach((v) => {
        if (v.path === path) {
          liveValue = v.value;
          liveValueError = null;
          // Update the readout text in place rather than a full
          // renderZonesList(). A streaming path ticks this every ~1s
          // (the subscription period below) -- a full re-render would tear
          // down and rebuild every input in the row on each tick, stealing
          // focus and dropping keystrokes out from under anyone actively
          // typing into the zone inputs just below it.
          updateLiveValueReadout();
        }
      });
    });
  });

  ws.addEventListener('error', () => {
    if (path !== expandedPath) return;
    liveValueError = 'Live value subscription failed.';
    renderZonesList();
  });

  return ws;
}

function fillLiveValueReadout(el) {
  el.classList.toggle('zone-bar-error', !!liveValueError);
  el.textContent = liveValueError || 'Current value: ' + (liveValue === undefined ? 'no data yet' : formatLiveValue(liveValue));
}

// In-place update, deliberately not a renderZonesList() call -- see the
// comment at the call site in the WS message handler above.
function updateLiveValueReadout() {
  const el = document.getElementById('live-value-readout');
  if (el) fillLiveValueReadout(el);
}

function closeLiveValueSocket() {
  if (liveValueSocket) {
    liveValueSocket.close();
    liveValueSocket = null;
  }
  liveValue = undefined;
  liveValueError = null;
}

// --- Profile <-> Server plumbing -------------------------------------

// POST /persist-zone: Server -> Profile read result, or an editor's own
// edits, written into Profile. Never touches meta, never calls
// app.handleMessage -- shared by autosave (below) and "Get live"'s
// persist step.
function persistToProfile(path, zones) {
  return fetch('/plugins/signalk-alarms/persist-zone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path, zones: zones })
  }).then((r) => r.json().then((data) => ({ ok: r.ok, data: data })));
}

// POST /commit-zone: Profile -> Server, one path. Writes meta.zones (the
// real push to the live alarm system) and, as a side effect, re-persists
// the same data to Profile -- a harmless no-op re-save of data that's
// already there under the auto-save model, not something the caller needs
// to think about. Shared by the per-row Commit button and the global
// Send-to-server action below.
function pushZonesToServer(path, zones) {
  return fetch('/plugins/signalk-alarms/commit-zone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path, zones: zones })
  }).then((r) => r.json().then((data) => ({ ok: r.ok, data: data, path: path })));
}

function fillAutosaveIndicator(el) {
  if (!autosaveStatus) {
    el.textContent = '';
    el.className = 'autosave-status';
    return;
  }
  el.textContent = autosaveStatus.message;
  el.className = 'autosave-status autosave-status-' + autosaveStatus.type;
}

// In-place update, same reasoning as updateLiveValueReadout above -- this
// fires mid-typing (on the debounce timer), so it must not tear down the
// inputs the user might still be focused on.
function updateAutosaveIndicator() {
  const el = document.getElementById('autosave-status');
  if (el) fillAutosaveIndicator(el);
}

// Editing -> Profile, immediate (no debounce) -- used for discrete actions
// (state dropdown change, Remove) where there's no "pause in typing" to
// wait for. rows is passed explicitly (not read from the mutable
// editableZones variable at fire time) so this stays correct even if the
// user has since switched to a different row -- see scheduleAutosave below
// for why that distinction matters for the debounced path.
function saveProfileNow(path, rows) {
  const zones = editableRowsToZones(rows);
  autosaveStatus = { type: 'pending', message: 'Saving...' };
  updateAutosaveIndicator();
  persistToProfile(path, zones)
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Autosave failed');
      defaultProfileZones[path] = data.zones;
      if (mismatchedPaths) mismatchedPaths.delete(path);
      autosaveStatus = { type: 'success', message: 'Saved' };
      updateAutosaveIndicator();
    })
    .catch((err) => {
      autosaveStatus = { type: 'error', message: err.message };
      updateAutosaveIndicator();
    });
}

// Editing -> Profile, debounced -- used for the lower/upper text inputs,
// where a write per keystroke would be wasteful. 600ms: long enough that a
// normal typing burst (e.g. "123") collapses into one save, short enough
// that switching away or hitting Commit right after typing doesn't lose the
// edit for long. `rows` (the specific editableZones array instance for
// this row) is captured by this closure at schedule time, not read from
// the mutable `editableZones` variable inside the timeout callback -- if it
// read the variable by name instead, switching to a different row before
// the timer fires would reassign that variable and the pending save would
// silently apply this row's stale values to whatever path is expanded when
// the timer finally fires. Capturing by parameter avoids that entirely.
function scheduleAutosave(path, rows) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    saveProfileNow(path, rows);
  }, AUTOSAVE_DEBOUNCE_MS);
}

function flushPendingAutosave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

// --- Refresh / Send-to-server comparison -------------------------------

// Order-independent deep equality of two zone arrays. Each zone reduces to
// a key of its meaningful fields (state, lower, upper, message); the two
// arrays match if they contain the same multiset of keys, regardless of
// order or of which array is "first". Duplicate identical zone entries are
// handled correctly (both sides need the same count of that exact key) --
// an unlikely real case, but not silently mishandled by this approach.
function zoneKey(zone) {
  return [
    zone.state || '',
    typeof zone.lower === 'number' ? zone.lower : '',
    typeof zone.upper === 'number' ? zone.upper : '',
    zone.message || ''
  ].join('|');
}

function zonesEqual(a, b) {
  const ka = (a || []).map(zoneKey).sort();
  const kb = (b || []).map(zoneKey).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
  }
  return true;
}

function fetchLiveZonesBulk() {
  return fetch('/plugins/signalk-alarms/live-zones').then((r) => r.json());
}

// Compares every known path's Profile zones against its live zones (a
// path absent from either side is treated as []) and returns the Set of
// paths that differ. Only iterates allPaths -- a path Refresh doesn't show
// a row for has nothing to badge either way.
function computeMismatches(liveZonesByPath) {
  const mismatches = new Set();
  allPaths.forEach((path) => {
    const profileZones = defaultProfileZones[path] || [];
    const liveZones = liveZonesByPath[path] || [];
    if (!zonesEqual(profileZones, liveZones)) mismatches.add(path);
  });
  return mismatches;
}

function renderGlobalActions() {
  const container = document.getElementById('global-actions');
  container.innerHTML = '';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'refresh-btn';
  refreshBtn.disabled = !!(refreshStatus && refreshStatus.type === 'pending');
  refreshBtn.textContent = refreshStatus && refreshStatus.type === 'pending' ? 'Refreshing...' : 'Refresh';
  refreshBtn.title = 'Compare every path\'s stored zones against what\'s actually live on the server. Read-only.';
  refreshBtn.addEventListener('click', () => {
    refreshStatus = { type: 'pending', message: 'Refreshing...' };
    renderGlobalActions();
    fetchLiveZonesBulk()
      .then((liveZonesByPath) => {
        mismatchedPaths = computeMismatches(liveZonesByPath);
        refreshStatus = {
          type: 'success',
          message: mismatchedPaths.size === 0 ? 'All paths match the server.' : mismatchedPaths.size + ' path(s) differ from the server.'
        };
        renderGlobalActions();
        renderZonesList();
      })
      .catch((err) => {
        refreshStatus = { type: 'error', message: 'Refresh failed: ' + err.message };
        renderGlobalActions();
      });
  });
  container.appendChild(refreshBtn);

  if (sendStatus && sendStatus.type === 'confirm') {
    const confirmText = document.createElement('span');
    confirmText.className = 'send-confirm-text';
    confirmText.textContent = 'Send ' + sendStatus.count + ' changed path' + (sendStatus.count === 1 ? '' : 's') + ' to the server?';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'send-confirm-btn';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', () => {
      const paths = sendStatus.paths;
      sendStatus = { type: 'sending' };
      renderGlobalActions();
      Promise.all(paths.map((path) => pushZonesToServer(path, defaultProfileZones[path] || [])))
        .then((results) => {
          const failed = results.filter((r) => !r.ok);
          if (mismatchedPaths) {
            results.filter((r) => r.ok).forEach((r) => mismatchedPaths.delete(r.path));
          }
          if (failed.length === 0) {
            sendStatus = { type: 'success', message: 'Sent ' + paths.length + ' path(s) to the server.' };
          } else {
            sendStatus = {
              type: 'error',
              message: failed.length + ' of ' + paths.length + ' path(s) failed to send (' + failed[0].data.error + (failed.length > 1 ? ', ...' : '') + ').'
            };
          }
          renderGlobalActions();
          renderZonesList();
        })
        .catch((err) => {
          sendStatus = { type: 'error', message: 'Send failed: ' + err.message };
          renderGlobalActions();
        });
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'send-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      sendStatus = null;
      renderGlobalActions();
    });

    container.appendChild(confirmText);
    container.appendChild(confirmBtn);
    container.appendChild(cancelBtn);
  } else {
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'send-btn';
    sendBtn.disabled = !!(sendStatus && (sendStatus.type === 'checking' || sendStatus.type === 'sending'));
    sendBtn.textContent =
      sendStatus && sendStatus.type === 'sending'
        ? 'Sending...'
        : sendStatus && sendStatus.type === 'checking'
          ? 'Checking...'
          : 'Send to server';
    sendBtn.title = 'Push every path where Profile differs from the server. Re-checks fresh when clicked, then asks for confirmation.';
    sendBtn.addEventListener('click', () => {
      sendStatus = { type: 'checking' };
      renderGlobalActions();
      fetchLiveZonesBulk()
        .then((liveZonesByPath) => {
          const mismatches = computeMismatches(liveZonesByPath);
          const paths = Array.from(mismatches);
          if (paths.length === 0) {
            sendStatus = { type: 'none', message: 'No changes to send.' };
          } else {
            sendStatus = { type: 'confirm', count: paths.length, paths: paths };
          }
          renderGlobalActions();
        })
        .catch((err) => {
          sendStatus = { type: 'error', message: 'Failed to check for changes: ' + err.message };
          renderGlobalActions();
        });
    });
    container.appendChild(sendBtn);
  }

  if (refreshStatus && !(sendStatus && sendStatus.type === 'confirm')) {
    const refreshStatusEl = document.createElement('span');
    refreshStatusEl.className = 'refresh-status refresh-status-' + refreshStatus.type;
    refreshStatusEl.textContent = refreshStatus.message;
    container.appendChild(refreshStatusEl);
  }

  if (sendStatus && sendStatus.type !== 'confirm' && sendStatus.type !== 'checking' && sendStatus.type !== 'sending') {
    const sendStatusEl = document.createElement('span');
    sendStatusEl.className = 'send-status send-status-' + sendStatus.type;
    sendStatusEl.textContent = sendStatus.message;
    container.appendChild(sendStatusEl);
  }
}

function buildZoneBar(zones, sizeClass, emptyMessage) {
  const bar = document.createElement('div');
  bar.className = 'zone-bar ' + sizeClass;

  if (!zones || zones.length === 0) {
    if (sizeClass === 'full') {
      const empty = document.createElement('div');
      empty.className = 'zone-bar-empty';
      empty.textContent = emptyMessage || 'No zones defined for this path yet.';
      bar.appendChild(empty);
    }
    return bar;
  }

  // No stored display range (pathSettings min/max) exists yet for any path —
  // that UI doesn't exist yet. This auto-fits the bar to the zones' own
  // bounds purely so something renders; it is not the real editor scale.
  // A committed zone can legitimately have only one bound set (the other
  // left unbounded, per the zone schema) -- fall back to the other defined
  // bound, or a 1-unit span, rather than producing NaN geometry.
  const lows = zones.map((z) => z.lower).filter((v) => typeof v === 'number');
  const highs = zones.map((z) => z.upper).filter((v) => typeof v === 'number');
  const lowest = lows.length ? Math.min(...lows) : highs.length ? Math.min(...highs) - 1 : 0;
  const highest = highs.length ? Math.max(...highs) : lowest + 1;
  const span = highest - lowest || 1;

  zones.forEach((zone) => {
    const zLower = typeof zone.lower === 'number' ? zone.lower : lowest;
    const zUpper = typeof zone.upper === 'number' ? zone.upper : highest;
    const seg = document.createElement('div');
    seg.className = 'zone-bar-segment ' + (ZONE_STATE_CLASS[zone.state] || '');
    seg.style.left = ((zLower - lowest) / span) * 100 + '%';
    seg.style.width = ((zUpper - zLower) / span) * 100 + '%';
    seg.title =
      zone.state + ': ' + (typeof zone.lower === 'number' ? zone.lower : '-inf') + ' - ' + (typeof zone.upper === 'number' ? zone.upper : '+inf');
    bar.appendChild(seg);
  });

  return bar;
}

function renderZonesList() {
  const list = document.getElementById('zones-list');
  list.innerHTML = '';

  const search = document.getElementById('zones-search').value.trim().toLowerCase();
  const source = document.getElementById('zones-source-filter').value;

  const filtered = allPaths.filter((path) => {
    if (source && pathSource(path) !== source) return false;
    if (search && path.toLowerCase().indexOf(search) === -1) return false;
    return true;
  });

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'placeholder';
    empty.textContent = 'No paths match.';
    list.appendChild(empty);
    return;
  }

  filtered.forEach((path) => {
    const row = document.createElement('div');
    row.className = 'path-row' + (expandedPath === path ? ' expanded' : '');

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'path-row-header';

    const name = document.createElement('span');
    name.className = 'path-name';
    name.textContent = path;

    const badge = document.createElement('span');
    badge.className = 'source-badge';
    badge.textContent = pathSource(path);

    header.appendChild(name);

    // Per the global Refresh action (CLAUDE.md "Two-state model"): marks
    // every row whose Profile zones differ from the server, including
    // collapsed rows -- the point is a whole-list-at-a-glance scan, so this
    // lives in the header, not inside the (collapsed, invisible) body.
    if (mismatchedPaths && mismatchedPaths.has(path)) {
      const mismatchBadge = document.createElement('span');
      mismatchBadge.className = 'mismatch-badge';
      mismatchBadge.textContent = '≠ server';
      mismatchBadge.title = "Profile's stored zones differ from what's live on the server, as of the last Refresh.";
      header.appendChild(mismatchBadge);
    }

    header.appendChild(badge);
    // Mini preview always reflects Profile, regardless of whether the
    // expanded view below is currently showing a live fetch.
    header.appendChild(buildZoneBar(defaultProfileZones[path], 'mini'));

    header.addEventListener('click', () => {
      expandedPath = expandedPath === path ? null : path;
      liveZones = undefined;
      liveFetchError = null;
      // Reads from Profile -- there's no separate "blank vs. populated"
      // draft state to worry about anymore, Profile IS what's shown.
      editableZones = zonesToRows(defaultProfileZones[path]);
      commitStatus = null;
      liveSyncStatus = null;
      autosaveStatus = null;
      closeLiveValueSocket();
      if (expandedPath) {
        liveValueSocket = openLiveValueSocket(expandedPath);
      }
      renderZonesList();
    });

    const body = document.createElement('div');
    body.className = 'path-row-body';

    // liveZones/liveFetchError are single (not per-path) state — only
    // meaningful for whichever row is actually expanded, since expanding a
    // *different* row resets them (see the header click handler above).
    // Building this content for collapsed rows too would read stale state
    // that belongs to no particular path.
    if (path === expandedPath) {
      const toolbar = document.createElement('div');
      toolbar.className = 'zone-bar-toolbar';

      const label = document.createElement('span');
      label.className = 'zone-bar-source-label' + (liveZones !== undefined ? ' live' : '');
      label.textContent = liveZones !== undefined ? 'Live (from server)' : 'Profile (Default)';

      const liveBtn = document.createElement('button');
      liveBtn.type = 'button';
      liveBtn.className = 'get-live-btn';
      liveBtn.disabled = !!(liveSyncStatus && liveSyncStatus.type === 'pending');
      liveBtn.textContent = liveSyncStatus && liveSyncStatus.type === 'pending' ? 'Loading...' : 'Get live';
      liveBtn.addEventListener('click', async () => {
        liveSyncStatus = { type: 'pending', message: 'Syncing from live...' };
        renderZonesList();
        try {
          const liveRes = await fetch('/plugins/signalk-alarms/live-meta?path=' + encodeURIComponent(path));
          const liveData = await liveRes.json();
          if (!liveRes.ok) throw new Error(liveData.error || 'Failed to fetch live data');

          liveZones = liveData.zones;
          liveFetchError = null;
          // Get live is Server -> Profile (and the visible row), per
          // CLAUDE.md "Two-state model" -- overwrites the editable list,
          // no confirmation needed (reading live data and saving our own
          // record of it isn't a change to the live system).
          editableZones = zonesToRows(liveData.zones);
          renderZonesList();

          // Persists straight through to Profile, not just the row --
          // deliberately a separate call from the live read above, and
          // deliberately never touches meta/app.handleMessage. Get live
          // reads live, writes Profile + the row, nothing else.
          const { ok, data } = await persistToProfile(path, liveData.zones || []);
          if (!ok) throw new Error(data.error || 'Failed to save synced zones to Profile');

          // Keep the local cache in sync with what the server just
          // persisted, so the mini bar and a later collapse/re-expand of
          // this row (which reads from defaultProfileZones, not liveZones)
          // reflect it without a full page reload.
          defaultProfileZones[path] = data.zones;
          if (mismatchedPaths) mismatchedPaths.delete(path);
          liveSyncStatus = null;
          renderZonesList();
        } catch (err) {
          liveFetchError = err.message;
          liveSyncStatus = null;
          renderZonesList();
        }
      });

      toolbar.appendChild(label);
      toolbar.appendChild(liveBtn);
      body.appendChild(toolbar);

      if (liveFetchError) {
        const err = document.createElement('div');
        err.className = 'zone-bar-empty zone-bar-error';
        err.textContent = 'Failed to fetch live data: ' + liveFetchError;
        body.appendChild(err);
      } else if (liveZones !== undefined) {
        const bar = buildZoneBar(liveZones, 'full', 'No live zones for this path.');
        bar.classList.add('live');
        body.appendChild(bar);
      } else {
        body.appendChild(buildZoneBar(defaultProfileZones[path], 'full'));
      }

      const valueReadout = document.createElement('div');
      valueReadout.id = 'live-value-readout';
      valueReadout.className = 'live-value-readout';
      fillLiveValueReadout(valueReadout);
      body.appendChild(valueReadout);

      // Editable zone list: an "Add zone" control, per-row lower/upper/
      // state/Remove, auto-saving into Profile as you go (see
      // scheduleAutosave/saveProfileNow above) -- not drag, that's
      // deliberately deferred. A real path typically needs more than one
      // zone (a warn band and a separate alarm band on the same path is
      // normal), so this is the actual meta.zones array shape, not a
      // single-zone placeholder.
      const editSection = document.createElement('div');
      editSection.className = 'commit-section';

      const editListEl = document.createElement('div');
      editListEl.className = 'draft-zones-list';

      editableZones.forEach((zone, idx) => {
        const zoneRow = document.createElement('div');
        zoneRow.className = 'commit-inputs';

        const lowerInput = document.createElement('input');
        lowerInput.type = 'number';
        lowerInput.placeholder = 'Lower (blank = unbounded)';
        lowerInput.value = zone.lower;
        lowerInput.addEventListener('input', () => {
          editableZones[idx].lower = lowerInput.value;
          scheduleAutosave(path, editableZones);
        });

        const upperInput = document.createElement('input');
        upperInput.type = 'number';
        upperInput.placeholder = 'Upper (blank = unbounded)';
        upperInput.value = zone.upper;
        upperInput.addEventListener('input', () => {
          editableZones[idx].upper = upperInput.value;
          scheduleAutosave(path, editableZones);
        });

        const stateSelect = document.createElement('select');
        // "normal" is @signalk/zones'/server core's own implicit fallback
        // for an undefined gap between zones, never a state to set
        // explicitly -- see CLAUDE.md "Tab 1 — Zones: editor UI decided".
        ['nominal', 'alert', 'warn', 'alarm', 'emergency'].forEach((s) => {
          const opt = document.createElement('option');
          opt.value = s;
          opt.textContent = s;
          if (s === zone.state) opt.selected = true;
          stateSelect.appendChild(opt);
        });
        stateSelect.addEventListener('change', () => {
          editableZones[idx].state = stateSelect.value;
          // Discrete action, not continuous typing -- save immediately
          // rather than debouncing.
          flushPendingAutosave();
          saveProfileNow(path, editableZones);
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-zone-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.title = 'Remove this zone';
        removeBtn.addEventListener('click', () => {
          editableZones.splice(idx, 1);
          flushPendingAutosave();
          saveProfileNow(path, editableZones);
          renderZonesList();
        });

        zoneRow.appendChild(lowerInput);
        zoneRow.appendChild(upperInput);
        zoneRow.appendChild(stateSelect);
        zoneRow.appendChild(removeBtn);
        editListEl.appendChild(zoneRow);
      });

      editSection.appendChild(editListEl);

      const addZoneBtn = document.createElement('button');
      addZoneBtn.type = 'button';
      addZoneBtn.className = 'add-zone-btn';
      addZoneBtn.textContent = 'Add zone';
      addZoneBtn.addEventListener('click', () => {
        editableZones.push(emptyZoneRow());
        renderZonesList();
        // A freshly-added blank row has no bounds, so it's filtered out of
        // what gets persisted -- nothing to save until it's actually filled
        // in, which the input handlers above already cover.
      });
      editSection.appendChild(addZoneBtn);

      const autosaveEl = document.createElement('span');
      autosaveEl.id = 'autosave-status';
      fillAutosaveIndicator(autosaveEl);
      editSection.appendChild(autosaveEl);

      body.appendChild(editSection);

      // Commit: Profile -> Server only, per CLAUDE.md "Two-state model".
      // Profile already auto-saved as the row was edited above, so this
      // doesn't need to "save" anything itself -- it just pushes whatever's
      // currently in the row (via pushZonesToServer -> /commit-zone, the
      // same per-path write the global Send-to-server action below uses)
      // to the live server. /commit-zone does also re-persist Profile as a
      // side effect, but that's re-saving data that's already there under
      // the auto-save model -- a harmless no-op, not something this button
      // needs to think about.
      const commitSection = document.createElement('div');
      commitSection.className = 'commit-status-section';

      const commitBtn = document.createElement('button');
      commitBtn.type = 'button';
      commitBtn.className = 'commit-btn';
      commitBtn.textContent = 'Commit';
      commitBtn.disabled = !!(commitStatus && commitStatus.type === 'pending');
      commitBtn.addEventListener('click', () => {
        flushPendingAutosave();
        const zonesToSend = editableRowsToZones(editableZones);
        commitStatus = { type: 'pending', message: 'Committing...' };
        renderZonesList();
        pushZonesToServer(path, zonesToSend)
          .then(({ ok, data }) => {
            if (!ok) throw new Error(data.error || 'Commit failed');
            defaultProfileZones[path] = data.zones;
            editableZones = zonesToRows(data.zones);
            if (mismatchedPaths) mismatchedPaths.delete(path);
            commitStatus = { type: 'success', message: 'Committed — live now.' };
            renderZonesList();
          })
          .catch((err) => {
            commitStatus = { type: 'error', message: err.message };
            renderZonesList();
          });
      });
      commitSection.appendChild(commitBtn);

      if (commitStatus) {
        const statusEl = document.createElement('div');
        statusEl.className = 'commit-status commit-status-' + commitStatus.type;
        statusEl.textContent = commitStatus.message;
        commitSection.appendChild(statusEl);
      }

      body.appendChild(commitSection);
    }

    row.appendChild(header);
    row.appendChild(body);
    list.appendChild(row);
  });
}

function populateSourceFilter(paths) {
  const select = document.getElementById('zones-source-filter');
  const sources = Array.from(new Set(paths.map(pathSource))).sort();
  sources.forEach((source) => {
    const opt = document.createElement('option');
    opt.value = source;
    opt.textContent = source;
    select.appendChild(opt);
  });
}

function loadZonesTab() {
  Promise.all([
    fetch('/plugins/signalk-alarms/paths').then((r) => r.json()),
    fetch('/plugins/signalk-alarms/config').then((r) => r.json()),
    fetch('/plugins/signalk-alarms/values').then((r) => r.json())
  ])
    .then(([paths, config, values]) => {
      // Zones apply to raw data paths, not notification paths — those
      // belong to Tab 2. Not specified in CLAUDE.md; excluding
      // "notifications.*" here is a judgment call, flagged in the summary.
      //
      // Type filtering resolves the path-type question flagged in earlier
      // sessions: exclude a path only if its current value is CONFIRMED
      // non-numeric (string, object, or boolean — a zone can't apply to any
      // of those). A path with no value reported yet (key absent from
      // `values`, i.e. `values[p] === undefined`) is a different case —
      // never having reported data isn't evidence it's non-numeric, so it
      // stays in the list.
      allPaths = paths
        .filter((p) => p && !p.startsWith('notifications.'))
        .filter((p) => {
          const v = values[p];
          return v === undefined || typeof v === 'number';
        })
        .sort();
      // GET /plugins/signalk-alarms/config returns the full stored envelope
      // ({enabled, configuration}), not our data directly — our
      // pathSettings/profiles live under .configuration. Confirmed against
      // signalk-server's own source (getPluginOptions/appCopy.savePluginOptions
      // in src/interfaces/plugins.ts).
      const ourData = (config && config.configuration) || {};
      defaultProfileZones =
        (ourData.profiles && ourData.profiles.Default && ourData.profiles.Default.zones) || {};

      populateSourceFilter(allPaths);
      renderGlobalActions();
      renderZonesList();
    })
    .catch((err) => {
      const list = document.getElementById('zones-list');
      list.innerHTML = '';
      const errMsg = document.createElement('p');
      errMsg.className = 'placeholder';
      errMsg.textContent = 'Failed to load paths: ' + err.message;
      list.appendChild(errMsg);
    });
}

document.getElementById('zones-search').addEventListener('input', renderZonesList);
document.getElementById('zones-source-filter').addEventListener('change', renderZonesList);

loadZonesTab();
