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
//   Profile -- profiles[activeProfile].zones, our own persisted config.
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

// Sort key for "boundary value, small to large" (buildZoneBar below) -- a
// zone with no defined lower bound is conceptually the smallest (unbounded
// downward), so it sorts first.
function zoneSortValue(zone) {
  return typeof zone.lower === 'number' ? zone.lower : -Infinity;
}

// Same idea for the editable zone list (editableZones' rows are the
// string-shaped input values, not the numeric zones shape zoneSortValue
// above expects) -- a blank or non-numeric lower field sorts first, same
// "unbounded downward = smallest" treatment.
function editableZoneSortValue(row) {
  const trimmed = (row.lower || '').toString().trim();
  if (trimmed === '') return -Infinity;
  const num = Number(trimmed);
  return isNaN(num) ? -Infinity : num;
}

let allPaths = [];
let defaultProfileZones = {};
let expandedPath = null;

// Which profile is currently staged/active, and the full list of saved
// profile names (for the profile-bar dropdown) -- see the "Profile bar"
// section near the end of this file. Set from GET /config's own
// activeProfile/profiles keys at each tab's load time (both Zones' and
// Notifications' load functions set these identically, since both already
// fetch the same /config envelope -- harmless redundancy, not a race).
let activeProfile = 'Default';
let profileNames = ['Default'];

// path -> units string (or null), bulk-loaded once at tab load (GET /units)
// same as defaultProfileZones -- display-only, feeds formatWithUnit() for
// the live-typing hint and existing-zone boundary labels below. Never read
// by persist-zone/commit-zone -- storage stays raw SI regardless of this.
let pathUnits = {};

// liveFetchError: only relevant for whichever row is currently expanded
// (accordion is single-open). Surfaces a "Get live" failure (bad fetch or
// failed persist) as an error message -- no more separate "live preview"
// state to hold the fetched result itself, since Get live writes straight
// into Profile (editableZones/defaultProfileZones) rather than previewing
// it in a side channel. See CLAUDE.md "Per-row sync-status display".
let liveFetchError = null;
let liveSyncStatus = null; // {type: 'pending'|'error', message} -- Get live's own network status

// Live value marker: one WebSocket subscription for whichever row is
// expanded, opened on expand and closed on collapse/switch — see the header
// click handler. liveValue undefined = no reading yet; liveValueError set on
// socket failure. This is the path's current numeric reading, distinct from
// its zone bounds.
let liveValueSocket = null;
let liveValue;
let liveValueError = null;

// The editable view of Profile for whichever row is expanded -- same
// single-active-row pattern as liveValue above. Plain numeric inputs, not
// drag -- that's deliberately deferred to a later session. A path's real
// zones are an array (a warn band and a separate alarm band on the same
// path is normal), so this is a list, not a single triple.
let editableZones = [];
// Copy/paste (CLAUDE.md "Copy/paste zones between paths"): a single shared,
// in-memory clipboard slot, not the OS clipboard and not persisted across a
// reload -- just a JS variable, deliberately never reset except by a fresh
// page load (switching rows, Committing, etc. all leave it alone). Holds
// the same string-shaped editable-row objects editableZones itself uses
// (not the clean numeric zones shape), so pasting is just "replace
// editableZones with a clone of this" -- no conversion step, same shape the
// rest of the editor already works with.
let copiedZones = null;
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

// Deep-enough clone for a row array (each row is a flat object of
// primitives -- lower/upper/state/message are all strings or undefined, no
// nesting) -- used by Copy (to snapshot editableZones without the clipboard
// staying aliased to the live row, which future edits to that row would
// then silently leak into) and by Paste (so editing the pasted row doesn't
// mutate the clipboard itself, corrupting a later paste elsewhere).
function cloneZoneRows(rows) {
  return rows.map((z) => ({ lower: z.lower, upper: z.upper, state: z.state, message: z.message }));
}

function pathSource(path) {
  return path.split('.')[0];
}

// Display-only unit conversion, reused for all three surfaces that show a
// raw SI number to a human: the Zones tab's live-typing hint, its existing-
// zone boundary labels, and (below) the "Current value" readout -- one
// conversion table, not three. Storage/commit always stays in raw SI, this
// never feeds back into what gets sent to persist-zone/commit-zone. Units
// not explicitly handled here (V, A, m, ...) fall through to the plain
// rawValue, unconverted -- no guessing at conversions this doesn't know
// about.
function formatWithUnit(rawValue, units) {
  if (typeof rawValue !== 'number' || isNaN(rawValue)) return '';
  switch (units) {
    case 'K':
      return `${rawValue} (${(rawValue - 273.15).toFixed(1)}°C)`;
    case 'rad':
      return `${rawValue} (${((rawValue * 180) / Math.PI).toFixed(1)}°)`;
    case 'ratio':
      return `${rawValue} (${(rawValue * 100).toFixed(0)}%)`;
    case 'm/s':
      return `${rawValue} (${(rawValue * 1.94384449).toFixed(1)}kt)`;
    default:
      return `${rawValue}`;
  }
}

// Non-number live values (a path with no data yet reports undefined,
// handled separately by the readout's own "no data yet" text; anything
// object/string-shaped is a defensive fallback, not expected for this
// tab's numeric-only path list) fall back to JSON.stringify rather than
// going through formatWithUnit at all.
function formatLiveValue(value, units) {
  if (typeof value === 'number') {
    // Rounded here only -- a live streaming value can carry many decimal
    // digits of floating-point noise (e.g. 0.9260002345867262), which
    // formatWithUnit's own bare `${rawValue}` would print in full. Boundary
    // labels and the live-typing hints call formatWithUnit directly and
    // must keep showing exactly what's typed/stored, unrounded -- this
    // rounding is deliberately local to the live-value readout, not pushed
    // into formatWithUnit itself.
    return formatWithUnit(Number(value.toFixed(2)), units);
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
          // Update the readout text AND the bar's live-value marker in
          // place rather than a full renderZonesList(). A streaming path
          // ticks this every ~1s (the subscription period below) -- a full
          // re-render would tear down and rebuild every input in the row on
          // each tick, stealing focus and dropping keystrokes out from
          // under anyone actively typing into the zone inputs just below
          // it. updateZoneBars() only swaps the bar wrapper itself (see its
          // own comment), so it's exposed to the exact same tick-frequency
          // constraint as the readout and is safe here for the same reason.
          updateLiveValueReadout();
          updateZoneBars(path);
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
  // liveValue is only ever populated for whichever path is currently
  // expanded (see the WS handler above), so pathUnits[expandedPath] is the
  // right lookup here without needing a separate path param threaded
  // through both call sites (the initial render and the in-place WS-tick
  // update in updateLiveValueReadout() below).
  el.textContent =
    liveValueError || 'Current value: ' + (liveValue === undefined ? 'no data yet' : formatLiveValue(liveValue, pathUnits[expandedPath]));
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
      // Autosave only ever writes Profile, never Server -- unlike Get
      // live/Commit/Send-to-server (which genuinely sync the two and
      // correctly clear the mismatch), an edit here should be treated as
      // differing from the server until the next Refresh/Commit/
      // Send-to-server proves otherwise. Found this inverted (silently
      // marking a just-edited, never-pushed path as "matches") while
      // wiring up the sync-status indicator -- a real bug from last
      // session, not something introduced here.
      if (mismatchedPaths) mismatchedPaths.add(path);
      autosaveStatus = { type: 'success', message: 'Saved' };
      updateAutosaveIndicator();
      updateSyncStatusBadges(path);
      // Found via direct testing this session, not assumed: Remove/Paste/
      // state-dropdown-change all call a synchronous renderZonesList()
      // right after kicking off this (async) save -- which runs BEFORE
      // this .then() updates defaultProfileZones[path] above, so that
      // render still shows the pre-edit bar. The inputs themselves were
      // already correct (that part of the row is local state, mutated
      // before the save even starts) -- only the bar, which reads
      // defaultProfileZones, was stale. In-place update here (not a full
      // renderZonesList()) so this is also safe to run for the debounced
      // typing path, which deliberately avoids full re-renders to protect
      // focus -- this only ever touches the bar elements, never the inputs.
      updateZoneBars(path);
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

// --- Unsaved-changes guard (Send to server vs. saved profiles) ---------
//
// Whole-object versions of zonesEqual above, plus an analogous comparison
// for notifications -- used only by the "does currently-staged state match
// ANY saved profile" check before Send to server, not by Refresh/mismatch
// (which stays exactly as it was: Profile zones vs. live Server zones,
// one path at a time).

function zonesObjectsEqual(a, b) {
  const paths = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const p of paths) {
    if (!zonesEqual((a || {})[p], (b || {})[p])) return false;
  }
  return true;
}

function notificationEntryKey(entry) {
  if (!entry) return '';
  return [entry.sound || '', entry.mode || '', typeof entry.intervalSeconds === 'number' ? entry.intervalSeconds : ''].join('|');
}

function notificationsEqual(a, b) {
  const paths = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const p of paths) {
    const aStates = (a || {})[p] || {};
    const bStates = (b || {})[p] || {};
    const states = new Set([...Object.keys(aStates), ...Object.keys(bStates)]);
    for (const s of states) {
      if (notificationEntryKey(aStates[s]) !== notificationEntryKey(bStates[s])) return false;
    }
  }
  return true;
}

// The currently-staged {zones, notifications, defaultSound} -- same shape
// GET/POST /profiles/:name use, built from the exact same in-memory state
// Save/Save As already send. Shared by the profile bar (below) and this
// guard, so there's one definition of "what's staged right now".
function currentStagedProfileContent() {
  return {
    zones: defaultProfileZones,
    notifications: notifRowsToConfig(notifRows),
    defaultSound: notifDefaultSound || null
  };
}

function profileContentMatches(staged, profile) {
  return (
    zonesObjectsEqual(staged.zones, profile.zones) &&
    notificationsEqual(staged.notifications, profile.notifications) &&
    (staged.defaultSound || null) === (profile.defaultSound || null)
  );
}

// Fetches every saved profile's full content (GET /profiles/:name, one per
// name -- no separate bulk-content route exists per spec, and profile
// counts are small enough that N small requests is fine) and checks
// whether the currently-staged state deep-equals ANY of them, not just the
// active one -- a Merge can produce a combination that matches neither
// source profile it was merged from.
function stagedMatchesAnyProfile() {
  const staged = currentStagedProfileContent();
  return Promise.all(profileNames.map((name) => fetch('/plugins/signalk-alarms/profiles/' + encodeURIComponent(name)).then((r) => r.json()))).then(
    (profiles) => profiles.some((profile) => profileContentMatches(staged, profile))
  );
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

// --- Per-row sync-status indicator (CLAUDE.md "Two-state model" ->
// "Per-row sync-status display") -----------------------------------------
//
// Reuses mismatchedPaths -- the exact same state that already drives the
// thumbnail's mismatch badge -- rather than tracking this as a second,
// parallel fact. Three states, not two: a path Refresh has never checked
// is genuinely unknown, not a false "matches".
function syncStatusFor(path) {
  if (!mismatchedPaths) return 'unknown';
  return mismatchedPaths.has(path) ? 'differs' : 'matches';
}

function fillSyncStatusBadge(el, path) {
  const status = syncStatusFor(path);
  el.className = 'sync-status-badge sync-status-' + status;
  if (status === 'unknown') {
    el.textContent = 'Not yet checked';
    el.title = "Run Refresh to compare this path's Profile zones against the server.";
  } else if (status === 'differs') {
    el.textContent = '≠ server';
    el.title = "Profile's stored zones differ from what's live on the server, as of the last Refresh.";
  } else {
    el.textContent = '✓ matches server';
    el.title = "Profile's stored zones match what's live on the server, as of the last Refresh.";
  }
}

function buildSyncStatusBadge(path) {
  const el = document.createElement('span');
  el.dataset.syncPath = path;
  fillSyncStatusBadge(el, path);
  return el;
}

// In-place update for every badge belonging to this path (the thumbnail's,
// and the expanded row's copy if this happens to be the expanded path) --
// deliberately not a renderZonesList() call. Autosave (the only caller)
// fires mid-typing; a full re-render there would tear down and rebuild the
// inputs the user might still be focused on, same reasoning as
// updateLiveValueReadout/updateAutosaveIndicator above.
function updateSyncStatusBadges(path) {
  document.querySelectorAll('.sync-status-badge[data-sync-path="' + path + '"]').forEach((el) => {
    fillSyncStatusBadge(el, path);
  });
}

// The pre-existing Send-to-server flow (re-check live zones, count
// mismatches, ask for confirmation) -- unchanged in what it does, just
// extracted so the new unsaved-changes guard (below) can run first and
// fall through into this exact same flow afterward, whether the user
// picked "Send without saving" or "Save and send" (after the save
// actually completes).
function proceedToMismatchCheck() {
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
  } else if (sendStatus && sendStatus.type === 'unsaved-confirm') {
    // Reached only when the currently-staged state matches NO saved
    // profile (checked fresh by sendBtn's click handler below, via
    // stagedMatchesAnyProfile) -- three real choices, not a plain OK/
    // Cancel, per the explicit requirement.
    const text = document.createElement('span');
    text.className = 'send-confirm-text';
    text.textContent = "This configuration doesn't match any saved profile. Save it before sending to server?";

    const saveAndSendBtn = document.createElement('button');
    saveAndSendBtn.type = 'button';
    saveAndSendBtn.className = 'send-confirm-btn';
    saveAndSendBtn.textContent = 'Save and send';
    saveAndSendBtn.addEventListener('click', () => {
      sendStatus = { type: 'checking' };
      renderGlobalActions();
      saveProfileContent(activeProfile, currentStagedProfileContent())
        .then(({ ok, data }) => {
          if (!ok) throw new Error(data.error || 'Save failed');
          proceedToMismatchCheck();
        })
        .catch((err) => {
          sendStatus = { type: 'error', message: 'Save failed: ' + err.message };
          renderGlobalActions();
        });
    });

    const sendWithoutSavingBtn = document.createElement('button');
    sendWithoutSavingBtn.type = 'button';
    sendWithoutSavingBtn.className = 'send-confirm-btn';
    sendWithoutSavingBtn.textContent = 'Send without saving';
    sendWithoutSavingBtn.addEventListener('click', () => {
      proceedToMismatchCheck();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'send-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      sendStatus = null;
      renderGlobalActions();
    });

    container.appendChild(text);
    container.appendChild(saveAndSendBtn);
    container.appendChild(sendWithoutSavingBtn);
    container.appendChild(cancelBtn);
  } else {
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'send-btn';
    sendBtn.disabled = !!(
      sendStatus &&
      (sendStatus.type === 'checking' || sendStatus.type === 'sending' || sendStatus.type === 'unsaved-check')
    );
    sendBtn.textContent =
      sendStatus && sendStatus.type === 'sending'
        ? 'Sending...'
        : sendStatus && (sendStatus.type === 'checking' || sendStatus.type === 'unsaved-check')
          ? 'Checking...'
          : 'Send to server';
    sendBtn.title = 'Push every path where Profile differs from the server. Re-checks fresh when clicked, then asks for confirmation.';
    sendBtn.addEventListener('click', () => {
      // Unsaved-changes guard, checked BEFORE the pre-existing mismatch-
      // count flow: does the currently-staged state match any saved
      // profile at all? If it matches none, ask before proceeding; if it
      // matches one (the common case -- nothing's been edited since the
      // last Save), skip straight to the existing flow, unchanged.
      sendStatus = { type: 'unsaved-check' };
      renderGlobalActions();
      stagedMatchesAnyProfile()
        .then((matches) => {
          if (matches) {
            proceedToMismatchCheck();
          } else {
            sendStatus = { type: 'unsaved-confirm' };
            renderGlobalActions();
          }
        })
        .catch((err) => {
          sendStatus = { type: 'error', message: 'Failed to check saved profiles: ' + err.message };
          renderGlobalActions();
        });
    });
    container.appendChild(sendBtn);
  }

  if (refreshStatus && !(sendStatus && (sendStatus.type === 'confirm' || sendStatus.type === 'unsaved-confirm'))) {
    const refreshStatusEl = document.createElement('span');
    refreshStatusEl.className = 'refresh-status refresh-status-' + refreshStatus.type;
    refreshStatusEl.textContent = refreshStatus.message;
    container.appendChild(refreshStatusEl);
  }

  if (
    sendStatus &&
    sendStatus.type !== 'confirm' &&
    sendStatus.type !== 'checking' &&
    sendStatus.type !== 'sending' &&
    sendStatus.type !== 'unsaved-check' &&
    sendStatus.type !== 'unsaved-confirm'
  ) {
    const sendStatusEl = document.createElement('span');
    sendStatusEl.className = 'send-status send-status-' + sendStatus.type;
    sendStatusEl.textContent = sendStatus.message;
    container.appendChild(sendStatusEl);
  }
}

// units, if given, formats the label via formatWithUnit() (e.g.
// "273.15 (0.0°C)") instead of a bare number -- display only, see
// formatWithUnit's own comment.
function buildBoundaryLabel(value, leftPercent, units) {
  const label = document.createElement('span');
  label.className = 'zone-bar-boundary-label';
  label.style.left = leftPercent + '%';
  label.textContent = formatWithUnit(value, units);
  return label;
}

// Returns a wrapper containing the colored bar and, for the 'full' size
// only, a row of numeric boundary labels underneath (CLAUDE.md "Zone
// boundary value labels on the bar"). Decided to only add labels to 'full',
// not 'mini': the thumbnail is 140x10px, not enough room for legible
// numbers even for a single zone, let alone 2+ -- the full bar (28px tall,
// full content width) has room. Callers are unaffected by the wrapper --
// both just .appendChild() the return value, same as when this returned
// the bar div directly. `units` (a path's meta.units, from pathUnits) is
// only ever used for the 'full' labelsRow below -- mini never renders
// labels at all, so there's nothing for it to affect there.
//
// `currentValue`, if a number within [lowest, highest], draws a live-value
// marker on the bar -- same 'full'-only scoping as labels/units, since the
// live value backing it is only ever known for whichever row is currently
// expanded (see openLiveValueSocket) and mini/collapsed rows never open a
// second live-value subscription for themselves. Reuses the exact
// lowest/highest/span already computed below for the zone segments
// themselves, rather than a separate coordinate system that could drift out
// of alignment with them.
function buildZoneBar(zones, sizeClass, emptyMessage, units, currentValue) {
  const wrapper = document.createElement('div');
  wrapper.className = 'zone-bar-wrapper ' + sizeClass;

  const bar = document.createElement('div');
  bar.className = 'zone-bar ' + sizeClass;
  wrapper.appendChild(bar);

  if (!zones || zones.length === 0) {
    if (sizeClass === 'full') {
      const empty = document.createElement('div');
      empty.className = 'zone-bar-empty';
      empty.textContent = emptyMessage || 'No zones defined for this path yet.';
      bar.appendChild(empty);
    }
    return wrapper;
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

  const labelsRow = sizeClass === 'full' ? document.createElement('div') : null;
  if (labelsRow) labelsRow.className = 'zone-bar-labels';

  // Display order only (segments are absolutely positioned by their own
  // lower/upper regardless of iteration order, so this doesn't change the
  // bar's visual layout) -- but it does put the boundary labelsRow's DOM
  // order in left-to-right sync with the bar above it, and is what the
  // task actually asked for: "the displayed order always matches the
  // physical bar's left-to-right layout". A sorted copy, not an in-place
  // sort -- `zones` here is defaultProfileZones[path] itself, not a copy.
  const sortedZones = zones.slice().sort((a, b) => zoneSortValue(a) - zoneSortValue(b));

  sortedZones.forEach((zone) => {
    const zLower = typeof zone.lower === 'number' ? zone.lower : lowest;
    const zUpper = typeof zone.upper === 'number' ? zone.upper : highest;
    const seg = document.createElement('div');
    seg.className = 'zone-bar-segment ' + (ZONE_STATE_CLASS[zone.state] || '');
    seg.style.left = ((zLower - lowest) / span) * 100 + '%';
    seg.style.width = ((zUpper - zLower) / span) * 100 + '%';
    seg.title =
      zone.state + ': ' + (typeof zone.lower === 'number' ? zone.lower : '-inf') + ' - ' + (typeof zone.upper === 'number' ? zone.upper : '+inf');
    bar.appendChild(seg);

    // Only a REAL, explicitly-set bound gets a label -- zLower/zUpper above
    // substitute lowest/highest purely to give an unbounded edge somewhere
    // to render, that's not an actual configured value worth printing.
    // Contiguous zones sharing a boundary (the current default) produce the
    // same number from both sides at the same x-position -- expected per
    // CLAUDE.md, not de-duplicated.
    if (labelsRow) {
      if (typeof zone.lower === 'number') {
        labelsRow.appendChild(buildBoundaryLabel(zone.lower, ((zLower - lowest) / span) * 100, units));
      }
      if (typeof zone.upper === 'number') {
        labelsRow.appendChild(buildBoundaryLabel(zone.upper, ((zUpper - lowest) / span) * 100, units));
      }
    }
  });

  if (labelsRow) wrapper.appendChild(labelsRow);

  // Live-value marker: only within [lowest, highest] -- outside that range
  // (or no live value yet) means no marker at all, not clamped to an edge,
  // per the explicit "omit, don't clamp" requirement. Appended after the
  // segments so it paints on top of them (plain DOM order, no z-index
  // needed) -- it's only 2px wide, so the sliver of segment it covers at
  // any given moment is negligible, and its own title tooltip is more
  // useful there than the segment's.
  if (sizeClass === 'full' && typeof currentValue === 'number' && !isNaN(currentValue) && currentValue >= lowest && currentValue <= highest) {
    const marker = document.createElement('div');
    marker.className = 'zone-bar-value-marker';
    marker.style.left = ((currentValue - lowest) / span) * 100 + '%';
    // Rounded the same way formatLiveValue rounds the Current Value text
    // (currentValue is a live streaming reading, same floating-point-noise
    // concern) -- boundary labels/typing hints call formatWithUnit directly
    // and stay unrounded, this is only the marker's own tooltip.
    marker.title = 'Current value: ' + formatWithUnit(Number(currentValue.toFixed(2)), units);
    bar.appendChild(marker);
  }

  return wrapper;
}

// In-place refresh for every zone bar belonging to this path (the
// thumbnail's, and the expanded row's copy if this happens to be the
// expanded path) -- same data-attribute-driven pattern as
// updateSyncStatusBadges. Rebuilds each from the current
// defaultProfileZones[path] and swaps it in, without touching anything
// else in the row (inputs, buttons) -- called from saveProfileNow's async
// completion (including the debounced-typing path) AND from the live-value
// WS tick handler below, so it must never risk stealing focus from an input
// mid-type the way a full renderZonesList() would -- safe here since only
// the bar wrapper itself (segments/labels/marker) is replaced, never the
// inputs/buttons that live alongside it in the row.
// liveValue is only meaningful for the 'full' bar of whichever path is
// actually expanded (see openLiveValueSocket) -- a mini/thumbnail bar for
// this same path, or a 'full' bar for some other path this selector
// happens to also match, never gets a marker regardless of the current
// global liveValue.
function updateZoneBars(path) {
  document.querySelectorAll('.zone-bar-wrapper[data-bar-path="' + path + '"]').forEach((oldWrapper) => {
    const sizeClass = oldWrapper.classList.contains('mini') ? 'mini' : 'full';
    const currentValue = sizeClass === 'full' && path === expandedPath ? liveValue : undefined;
    const newWrapper = buildZoneBar(defaultProfileZones[path], sizeClass, undefined, pathUnits[path], currentValue);
    newWrapper.dataset.barPath = path;
    oldWrapper.replaceWith(newWrapper);
  });
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

    // Per-row sync-status indicator (CLAUDE.md "Two-state model" -> "Per-row
    // sync-status display"): shown on the thumbnail here AND inside the
    // expanded body below, both built from the same buildSyncStatusBadge()
    // -- one source of truth (mismatchedPaths), not two. Lives in the
    // header (not just the body) since collapsed rows need it too -- the
    // whole point is a whole-list-at-a-glance scan.
    header.appendChild(buildSyncStatusBadge(path));

    header.appendChild(badge);
    // Mini preview always reflects Profile, regardless of whether the
    // expanded view below is currently showing a live fetch. data-bar-path
    // lets updateZoneBars() find and refresh this in place after an
    // autosave, without a full re-render -- see that function's comment.
    const miniBar = buildZoneBar(defaultProfileZones[path], 'mini');
    miniBar.dataset.barPath = path;
    header.appendChild(miniBar);

    header.addEventListener('click', () => {
      expandedPath = expandedPath === path ? null : path;
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

    // liveFetchError is single (not per-path) state — only meaningful for
    // whichever row is actually expanded, since expanding a *different* row
    // resets it (see the header click handler above). Building this
    // content for collapsed rows too would read stale state that belongs
    // to no particular path.
    if (path === expandedPath) {
      const toolbar = document.createElement('div');
      toolbar.className = 'zone-bar-toolbar';

      // Per-row sync-status indicator, same badge/source-of-truth as the
      // thumbnail's above -- per CLAUDE.md "Per-row sync-status display",
      // this REPLACES the old "LIVE (FROM SERVER)" / "STORED (DEFAULT
      // PROFILE)" toggle label that used to live here. That label no
      // longer reflects how data actually flows: the bar below always
      // shows Profile now (Get live writes into Profile rather than
      // previewing it), so a leftover live/stored label would just be a
      // second, contradictory claim sitting next to the real one.
      toolbar.appendChild(buildSyncStatusBadge(path));

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

          liveFetchError = null;
          // Get live is Server -> Profile (and the visible row), per
          // CLAUDE.md "Two-state model" -- overwrites the editable list,
          // no confirmation needed (reading live data and saving our own
          // record of it isn't a change to the live system). No separate
          // "live preview" state anymore -- editableZones IS the row now,
          // same array Profile edits use, so this doesn't need its own
          // render branch the way it used to.
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
          // this row (which reads from defaultProfileZones) reflect it
          // without a full page reload. Also fixes the main bar staleness
          // bug this session found: since the bar below always renders
          // from defaultProfileZones now (no more liveZones branch), simply
          // updating this and calling renderZonesList() is enough to keep
          // it current after Commit too, not just after Get live.
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

      toolbar.appendChild(liveBtn);
      body.appendChild(toolbar);

      if (liveFetchError) {
        const err = document.createElement('div');
        err.className = 'zone-bar-empty zone-bar-error';
        err.textContent = 'Failed to fetch live data: ' + liveFetchError;
        body.appendChild(err);
      }

      // Always Profile -- no more live-preview branch. Reflects the
      // current data immediately after Commit, Get live, autosave, or a
      // fresh expand alike, since it's the same defaultProfileZones object
      // every other action here already keeps up to date. data-bar-path,
      // see updateZoneBars() -- same in-place-refresh pattern as the
      // thumbnail's mini bar above.
      const mainBar = buildZoneBar(defaultProfileZones[path], 'full', undefined, pathUnits[path], liveValue);
      mainBar.dataset.barPath = path;
      body.appendChild(mainBar);

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

      // Sorted for display only, same {row, originalIndex}-pair technique
      // as the Notifications tab's rows above -- every input below mutates
      // editableZones[idx] directly, so preserving the original index (not
      // just sorting the rows themselves) is what keeps those mutations
      // hitting the right entry regardless of on-screen order. The
      // underlying editableZones array order is never changed by this.
      const sortedEditableZones = editableZones
        .map((zone, originalIndex) => ({ zone: zone, originalIndex: originalIndex }))
        .sort((a, b) => editableZoneSortValue(a.zone) - editableZoneSortValue(b.zone));

      sortedEditableZones.forEach(({ zone, originalIndex }) => {
        const idx = originalIndex;
        const zoneRow = document.createElement('div');
        zoneRow.className = 'commit-inputs';

        const lowerInput = document.createElement('input');
        lowerInput.type = 'number';
        lowerInput.placeholder = 'Lower (blank = unbounded)';
        lowerInput.value = zone.lower;

        // Live unit-conversion hint, next to the input -- updates on every
        // keystroke, not just on blur/save. A blank input is NOT "0"; an
        // empty string would otherwise coerce to Number('') === 0 and show
        // a bogus converted value for an unset bound.
        const lowerHint = document.createElement('span');
        lowerHint.className = 'unit-hint';
        function updateLowerHint() {
          const raw = lowerInput.value.trim();
          lowerHint.textContent = formatWithUnit(raw === '' ? NaN : Number(raw), pathUnits[path]);
        }
        updateLowerHint();

        lowerInput.addEventListener('input', () => {
          editableZones[idx].lower = lowerInput.value;
          updateLowerHint();
          scheduleAutosave(path, editableZones);
        });

        const upperInput = document.createElement('input');
        upperInput.type = 'number';
        upperInput.placeholder = 'Upper (blank = unbounded)';
        upperInput.value = zone.upper;

        const upperHint = document.createElement('span');
        upperHint.className = 'unit-hint';
        function updateUpperHint() {
          const raw = upperInput.value.trim();
          upperHint.textContent = formatWithUnit(raw === '' ? NaN : Number(raw), pathUnits[path]);
        }
        updateUpperHint();

        upperInput.addEventListener('input', () => {
          editableZones[idx].upper = upperInput.value;
          updateUpperHint();
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
        zoneRow.appendChild(lowerHint);
        zoneRow.appendChild(upperInput);
        zoneRow.appendChild(upperHint);
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

      // Copy/paste (CLAUDE.md "Copy/paste zones between paths"): replaces
      // wildcard path-group expansion for the common "several similar
      // paths want identical zones" case, without pattern-matching
      // machinery. Copy snapshots THIS row's current editableZones into the
      // shared copiedZones slot (cloned, so later edits to this row don't
      // leak into the clipboard); Paste (on any other expanded row)
      // replaces that row's editableZones with a clone of the clipboard and
      // runs it through the exact same saveProfileNow() autosave path any
      // other edit already uses -- no new persistence mechanism, and it
      // correctly marks the pasted path as differing from server via the
      // same mismatchedPaths.add() fix from last session, not a special
      // case here.
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'copy-zone-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.title = "Copy this path's zones to paste into another path";
      copyBtn.addEventListener('click', () => {
        copiedZones = cloneZoneRows(editableZones);
        renderZonesList();
      });
      editSection.appendChild(copyBtn);

      const pasteBtn = document.createElement('button');
      pasteBtn.type = 'button';
      pasteBtn.className = 'paste-zone-btn';
      pasteBtn.textContent = 'Paste';
      // Disabled (not hidden) until something's been copied this session --
      // keeps the control discoverable/in-place rather than the layout
      // shifting once it becomes available.
      pasteBtn.disabled = !copiedZones;
      pasteBtn.title = copiedZones ? "Replace this path's zones with the copied ones" : 'Copy zones from another path first';
      pasteBtn.addEventListener('click', () => {
        if (!copiedZones) return;
        editableZones = cloneZoneRows(copiedZones);
        // Discrete action, not continuous typing -- save immediately
        // rather than debouncing, same as Remove/state-dropdown-change.
        flushPendingAutosave();
        saveProfileNow(path, editableZones);
        renderZonesList();
        // Deliberately no auto-Commit -- pasting only changes Profile, same
        // as typing; Commit/Send-to-server still push it live separately.
      });
      editSection.appendChild(pasteBtn);

      if (copiedZones) {
        const clipboardStatusEl = document.createElement('span');
        clipboardStatusEl.className = 'clipboard-status';
        clipboardStatusEl.textContent = copiedZones.length + ' zone(s) copied';
        editSection.appendChild(clipboardStatusEl);
      }

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
    fetch('/plugins/signalk-alarms/values').then((r) => r.json()),
    fetch('/plugins/signalk-alarms/units').then((r) => r.json())
  ])
    .then(([paths, config, values, units]) => {
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
      // activeProfile/profileNames come from this same envelope rather than
      // a separate GET /profiles call -- configuration.profiles' own keys
      // are the profile names, and configuration.activeProfile is right
      // there already, so a second request would just be redundant. GET
      // /profiles (index.js) still exists per spec, just isn't needed here.
      activeProfile = ourData.activeProfile || 'Default';
      profileNames = Object.keys(ourData.profiles || {});
      defaultProfileZones =
        (ourData.profiles && ourData.profiles[activeProfile] && ourData.profiles[activeProfile].zones) || {};
      pathUnits = units || {};

      populateSourceFilter(allPaths);
      renderGlobalActions();
      renderZonesList();
      renderProfileBar();
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

// --- Notifications tab ---
//
// Plugin-owned config only (path -> state -> {sound, mode, intervalSeconds},
// plus a single defaultSound), now living under profiles[activeProfile]
// rather than flat top-level keys -- NOT SignalK path metadata, so unlike
// the Zones tab there's no Server/Profile split, no Get Live/Commit/
// Refresh/Send-to-server: just one editable list and one Save button, same
// as any plain settings form. See index.js's /notification-config route for
// why this posts there rather than the generic POST /plugins/<id>/config.

let notifRows = [];
let availableSounds = [];
let notifDefaultSound = '';
let notifSaveStatus = null; // {type: 'pending'|'success'|'error', message}

const NOTIF_STATES = ['alert', 'warn', 'alarm', 'emergency'];
const NOTIF_MODES = ['once', 'repeat'];

// Display order only -- render-time sort, never reorders the underlying
// notifRows array (see renderNotifRows below), so this has no effect on
// what gets POSTed or how it's stored. Path alphabetically first; within
// the same path, severity order (reusing NOTIF_STATES' own ordering above)
// reads more sensibly than alphabetical would for states specifically --
// "alert, warn, alarm, emergency" is a meaningful escalation, whereas
// alphabetical ("alarm, alert, emergency, warn") isn't.
function notifStateSortOrder(state) {
  const i = NOTIF_STATES.indexOf(state);
  return i === -1 ? NOTIF_STATES.length : i;
}

function emptyNotifRow() {
  return { path: '', state: 'alert', sound: '', mode: 'once', intervalSeconds: 30 };
}

// Flattens the stored {path: {state: {sound,mode,intervalSeconds}}} shape
// into one row per path+state binding -- easier to render/edit as a flat
// list than as nested selects.
function configToNotifRows(notifications) {
  const rows = [];
  Object.keys(notifications || {}).forEach((path) => {
    const stateMap = notifications[path] || {};
    Object.keys(stateMap).forEach((state) => {
      const entry = stateMap[state] || {};
      rows.push({
        path: path,
        state: state,
        sound: entry.sound || '',
        mode: entry.mode || 'once',
        intervalSeconds: typeof entry.intervalSeconds === 'number' ? entry.intervalSeconds : 30
      });
    });
  });
  return rows;
}

// The reverse, ready to POST. A row with no path or no sound chosen yet
// (e.g. a just-added blank row) is skipped silently, not an error -- same
// not-yet-used treatment the Zones tab already gives a blank zone row.
function notifRowsToConfig(rows) {
  const notifications = {};
  rows.forEach((row) => {
    let path = row.path.trim();
    if (!path || !row.sound) return;
    // Belt-and-suspenders alongside the path input's own blur handler
    // (below): a real notification delta's path always carries the full
    // "notifications.*" prefix, so a bare path here could never match one
    // and would be silent dead configuration -- exactly the bug found
    // during discovery (a "propulsion.head.temperature" entry that could
    // never fire). Fixed here too so this can't recur even if a row is
    // saved without ever blurring its path input (e.g. Save clicked
    // immediately after typing).
    if (!path.startsWith('notifications.')) path = 'notifications.' + path;
    if (!notifications[path]) notifications[path] = {};
    const entry = { sound: row.sound, mode: row.mode };
    if (row.mode === 'repeat') {
      entry.intervalSeconds = Number(row.intervalSeconds) || 30;
    }
    notifications[path][row.state] = entry;
  });
  return notifications;
}

// Same fetch-then-{ok,data} shape as persistToProfile/pushZonesToServer
// above, so the Save handler below can reuse their exact
// "!ok -> throw new Error(data.error)" idiom rather than inventing a
// slightly different one for this tab.
function postNotificationConfig(payload) {
  return fetch('/plugins/signalk-alarms/notification-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then((r) => r.json().then((data) => ({ ok: r.ok, data: data })));
}

function fetchSounds() {
  return fetch('/plugins/signalk-alarms/sounds')
    .then((r) => r.json())
    .then((data) => data.sounds || []);
}

// Shared by each row's sound <select> and the single default-sound
// <select> -- populated from GET /sounds (an actual directory listing),
// never a hardcoded list, same reasoning CLAUDE.md already applies to the
// Zones tab's sound picker. A currently-selected filename that's no longer
// present on disk (e.g. deleted since it was configured) is kept as an
// explicit extra option rather than silently reverting to blank, so a
// missing file is visible instead of hidden.
function populateSoundSelect(select, selected, emptyLabel) {
  select.innerHTML = '';
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = emptyLabel;
  select.appendChild(emptyOpt);
  availableSounds.forEach((sound) => {
    const opt = document.createElement('option');
    opt.value = sound;
    opt.textContent = sound;
    if (sound === selected) opt.selected = true;
    select.appendChild(opt);
  });
  if (selected && !availableSounds.includes(selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected + ' (missing from sounds directory)';
    opt.selected = true;
    select.appendChild(opt);
  }
}

function renderDefaultSoundSelect() {
  const select = document.getElementById('notif-default-sound');
  populateSoundSelect(select, notifDefaultSound, '(none configured)');
}

function fillNotifSaveStatus(el) {
  if (!notifSaveStatus) {
    el.textContent = '';
    el.className = 'commit-status';
    return;
  }
  el.textContent = notifSaveStatus.message;
  el.className = 'commit-status commit-status-' + notifSaveStatus.type;
}

function renderNotifRows() {
  const container = document.getElementById('notif-rows');
  container.innerHTML = '';

  if (notifRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'placeholder';
    empty.textContent = 'No path/state sound bindings yet — click "Add path/state binding" below.';
    container.appendChild(empty);
    return;
  }

  // Sorted for display only -- a {row, originalIndex} pair per entry, not
  // a sorted copy of the rows themselves, so every input's mutation below
  // (which indexes into notifRows[idx]) still hits the correct underlying
  // entry regardless of where it landed on screen. The stored array order
  // itself is never touched.
  const sortedRows = notifRows
    .map((row, originalIndex) => ({ row: row, originalIndex: originalIndex }))
    .sort((a, b) => {
      if (a.row.path !== b.row.path) return a.row.path < b.row.path ? -1 : 1;
      return notifStateSortOrder(a.row.state) - notifStateSortOrder(b.row.state);
    });

  sortedRows.forEach(({ row, originalIndex }) => {
    const idx = originalIndex;
    const rowEl = document.createElement('div');
    rowEl.className = 'notif-row';

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'notif-path-input';
    pathInput.placeholder = 'notifications.* path (e.g. notifications.navigation.anchor)';
    pathInput.value = row.path;
    pathInput.addEventListener('input', () => {
      notifRows[idx].path = pathInput.value;
    });
    // Auto-prefix on blur, not on every keystroke -- fixing it up mid-type
    // would fight anyone actively typing the correct "notifications."
    // prefix themselves (each keystroke would re-trigger the check against
    // a still-partial string). Root-cause fix for the exact dead-config bug
    // found during discovery: a real notification delta's path always
    // carries the full prefix, so a bare path typed here could never match
    // one and would silently do nothing at alarm time.
    pathInput.addEventListener('blur', () => {
      const trimmed = pathInput.value.trim();
      if (trimmed && !trimmed.startsWith('notifications.')) {
        const fixed = 'notifications.' + trimmed;
        pathInput.value = fixed;
        notifRows[idx].path = fixed;
      }
    });

    const stateSelect = document.createElement('select');
    // No normal/nominal here -- those never trigger sound (see index.js's
    // handleNotificationState), so they're not a valid binding target.
    NOTIF_STATES.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === row.state) opt.selected = true;
      stateSelect.appendChild(opt);
    });
    stateSelect.addEventListener('change', () => {
      notifRows[idx].state = stateSelect.value;
    });

    const soundSelect = document.createElement('select');
    soundSelect.className = 'notif-sound-select';
    populateSoundSelect(soundSelect, row.sound, '(choose sound)');
    soundSelect.addEventListener('change', () => {
      notifRows[idx].sound = soundSelect.value;
    });

    const modeSelect = document.createElement('select');
    NOTIF_MODES.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === row.mode) opt.selected = true;
      modeSelect.appendChild(opt);
    });

    const intervalInput = document.createElement('input');
    intervalInput.type = 'number';
    intervalInput.min = '1';
    intervalInput.className = 'notif-interval-input';
    intervalInput.placeholder = 'Interval (s)';
    intervalInput.value = row.intervalSeconds;
    intervalInput.style.display = row.mode === 'repeat' ? '' : 'none';
    intervalInput.addEventListener('input', () => {
      notifRows[idx].intervalSeconds = intervalInput.value;
    });

    modeSelect.addEventListener('change', () => {
      notifRows[idx].mode = modeSelect.value;
      intervalInput.style.display = modeSelect.value === 'repeat' ? '' : 'none';
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-zone-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      notifRows.splice(idx, 1);
      renderNotifRows();
    });

    rowEl.appendChild(pathInput);
    rowEl.appendChild(stateSelect);
    rowEl.appendChild(soundSelect);
    rowEl.appendChild(modeSelect);
    rowEl.appendChild(intervalInput);
    rowEl.appendChild(removeBtn);
    container.appendChild(rowEl);
  });
}

function loadNotificationsTab() {
  Promise.all([fetch('/plugins/signalk-alarms/config').then((r) => r.json()), fetchSounds()])
    .then(([config, sounds]) => {
      // Same envelope shape as the Zones tab's GET /config read above --
      // our data lives under .configuration, not at the top level.
      // notifications/defaultSound now live under profiles[activeProfile],
      // not flat top-level keys (see index.js's profiles migration).
      const ourData = (config && config.configuration) || {};
      activeProfile = ourData.activeProfile || 'Default';
      profileNames = Object.keys(ourData.profiles || {});
      const profile = (ourData.profiles && ourData.profiles[activeProfile]) || {};
      notifRows = configToNotifRows(profile.notifications);
      notifDefaultSound = profile.defaultSound || '';
      availableSounds = sounds;
      renderDefaultSoundSelect();
      renderNotifRows();
      renderProfileBar();
    })
    .catch((err) => {
      const container = document.getElementById('notif-rows');
      container.innerHTML = '';
      const errMsg = document.createElement('p');
      errMsg.className = 'placeholder';
      errMsg.textContent = 'Failed to load notification config: ' + err.message;
      container.appendChild(errMsg);
    });
}

document.getElementById('notif-add-row-btn').addEventListener('click', () => {
  notifRows.push(emptyNotifRow());
  renderNotifRows();
});

// Sounds are added by hand on disk while this page may already be open --
// this re-fetches the listing without a full page reload.
document.getElementById('notif-refresh-sounds-btn').addEventListener('click', () => {
  fetchSounds().then((sounds) => {
    availableSounds = sounds;
    renderDefaultSoundSelect();
    renderNotifRows();
  });
});

document.getElementById('notif-default-sound').addEventListener('change', (e) => {
  notifDefaultSound = e.target.value;
});

document.getElementById('notif-save-btn').addEventListener('click', () => {
  const payload = {
    notifications: notifRowsToConfig(notifRows),
    defaultSound: notifDefaultSound || null
  };
  const statusEl = document.getElementById('notif-save-status');
  notifSaveStatus = { type: 'pending', message: 'Saving...' };
  fillNotifSaveStatus(statusEl);
  postNotificationConfig(payload)
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Save failed');
      // Re-sync from the server's own cleaned/validated copy (it may have
      // dropped an empty state map, etc.) rather than trusting the payload
      // we sent -- same reasoning Commit's success handler applies to
      // defaultProfileZones above.
      notifRows = configToNotifRows(data.notifications);
      notifDefaultSound = data.defaultSound || '';
      notifSaveStatus = { type: 'success', message: 'Saved.' };
      fillNotifSaveStatus(statusEl);
      renderNotifRows();
    })
    .catch((err) => {
      notifSaveStatus = { type: 'error', message: err.message };
      fillNotifSaveStatus(statusEl);
    });
});

loadNotificationsTab();

// --- Profile bar: Save / Save as... / Load ------------------------------
//
// Wires up the previously non-functional stub (index.html's
// #profile-select + #save-btn/#save-as-btn -- the old top comment in this
// file said as much: "no click handlers, no profile logic yet"). A profile
// now covers BOTH tabs' staged state (zones + notifications +
// defaultSound), per index.js's profiles migration. Loading a profile only
// ever changes STAGED state -- the same store autosave/notification-Save
// already write into -- never SignalK directly, same as every other
// Profile-side action in this app; only Commit/Send-to-server (unchanged)
// ever pushes to the live server.

function fetchProfileContent(name) {
  return fetch('/plugins/signalk-alarms/profiles/' + encodeURIComponent(name)).then((r) => r.json());
}

function saveProfileContent(name, content) {
  return fetch('/plugins/signalk-alarms/profiles/' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content)
  }).then((r) => r.json().then((data) => ({ ok: r.ok, data: data })));
}

function setActiveProfile(name) {
  return fetch('/plugins/signalk-alarms/active-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name })
  }).then((r) => r.json().then((data) => ({ ok: r.ok, data: data })));
}

// Replaces the in-memory staged state for BOTH tabs from `content` and
// re-renders both -- the one place that knows how to apply a profile's
// content to the UI, used by Load (Replace/Merge) below. Also resets the
// Zones tab's Server-comparison state (mismatchedPaths/refreshStatus/
// sendStatus) -- a freshly loaded/switched profile hasn't been Refreshed
// against Server yet, so any previous Refresh's badges would be stale
// (they describe the OLD staged state's relationship to Server, not the
// new one's), and collapses whichever row was expanded (its editableZones
// belong to the profile that's about to stop being active).
function applyProfileContentToTabs(content) {
  defaultProfileZones = content.zones || {};
  mismatchedPaths = null;
  refreshStatus = null;
  sendStatus = null;
  expandedPath = null;
  closeLiveValueSocket();
  renderZonesList();
  renderGlobalActions();

  notifRows = configToNotifRows(content.notifications);
  notifDefaultSound = content.defaultSound || '';
  renderDefaultSoundSelect();
  renderNotifRows();
}

// profileLoadPrompt: null (idle) | {name} -- the 3-way Replace/Merge/
// Cancel prompt showing for a profile just picked in the dropdown, before
// any of Replace/Merge/Cancel has actually been chosen yet.
let profileLoadPrompt = null;
let profileBarStatus = null; // {type:'pending'|'success'|'error', message}

function fillProfileBarStatus() {
  const el = document.getElementById('profile-bar-status');
  if (!profileBarStatus) {
    el.textContent = '';
    el.className = 'profile-bar-status';
    return;
  }
  el.textContent = profileBarStatus.message;
  el.className = 'profile-bar-status profile-bar-status-' + profileBarStatus.type;
}

function renderProfileBar() {
  const select = document.getElementById('profile-select');
  select.innerHTML = '';
  // While a Load prompt is pending, the dropdown should keep showing the
  // just-picked (non-active) target name, not snap back to activeProfile --
  // this rebuild runs on every renderProfileBar() call (including the one
  // that opens the prompt itself), so without this the dropdown could never
  // actually hold a non-active value long enough for the delete button
  // (which reads select.value) to ever see one. Found via actually
  // exercising this in a browser, not by inspection -- the delete button
  // was silently targeting activeProfile instead of the intended pending
  // profile until this fix.
  const selectedName = profileLoadPrompt ? profileLoadPrompt.name : activeProfile;
  profileNames.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === selectedName) opt.selected = true;
    select.appendChild(opt);
  });

  const promptEl = document.getElementById('profile-load-prompt');
  promptEl.innerHTML = '';
  if (profileLoadPrompt) {
    const text = document.createElement('span');
    text.className = 'profile-load-prompt-text';
    text.textContent = 'Load "' + profileLoadPrompt.name + '" — ';
    promptEl.appendChild(text);

    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.textContent = 'Replace everything';
    replaceBtn.addEventListener('click', () => loadProfile(profileLoadPrompt.name, 'replace'));
    promptEl.appendChild(replaceBtn);

    const mergeBtn = document.createElement('button');
    mergeBtn.type = 'button';
    mergeBtn.textContent = 'Merge — only touch paths in this profile';
    mergeBtn.addEventListener('click', () => loadProfile(profileLoadPrompt.name, 'merge'));
    promptEl.appendChild(mergeBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      profileLoadPrompt = null;
      select.value = activeProfile;
      renderProfileBar();
    });
    promptEl.appendChild(cancelBtn);
  }

  fillProfileBarStatus();
}

// mode: 'replace' overwrites the staged zones/notifications/defaultSound
// entirely with the loaded profile's own content -- nothing needs
// persisting first, since that content already IS what's stored under
// `name`, unchanged. mode: 'merge' overwrites only the keys present in the
// loaded profile (plain object spread, loaded profile's keys win),
// leaving every other currently-staged path untouched -- this produces a
// genuinely new combination that doesn't equal either source, so it's
// POSTed back to profiles/<name> to actually become that profile's new
// stored content (matching "this only updates staged state" -- staged
// state, in this app's existing model, IS whatever's in
// profiles[activeProfile]). Either way, activeProfile becomes `name`
// afterward -- never touches SignalK.
function loadProfile(name, mode) {
  profileLoadPrompt = null;
  profileBarStatus = { type: 'pending', message: 'Loading "' + name + '"...' };
  renderProfileBar();

  fetchProfileContent(name)
    .then((loaded) => {
      const content =
        mode === 'replace'
          ? { zones: loaded.zones || {}, notifications: loaded.notifications || {}, defaultSound: loaded.defaultSound || null }
          : {
              zones: Object.assign({}, defaultProfileZones, loaded.zones || {}),
              notifications: Object.assign({}, notifRowsToConfig(notifRows), loaded.notifications || {}),
              defaultSound:
                loaded.defaultSound !== null && loaded.defaultSound !== undefined ? loaded.defaultSound : notifDefaultSound || null
            };

      const persisted = mode === 'merge' ? saveProfileContent(name, content) : Promise.resolve({ ok: true, data: content });
      return persisted.then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'Failed to save merged profile');
        return content;
      });
    })
    .then((content) => {
      applyProfileContentToTabs(content);
      return setActiveProfile(name);
    })
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Failed to set active profile');
      activeProfile = name;
      profileBarStatus = { type: 'success', message: 'Loaded "' + name + '".' };
      renderProfileBar();
    })
    .catch((err) => {
      profileBarStatus = { type: 'error', message: err.message };
      renderProfileBar();
    });
}

document.getElementById('profile-select').addEventListener('change', (e) => {
  const name = e.target.value;
  if (name === activeProfile) return;
  // Avoid conflicting inline prompts open at once -- picking a different
  // profile while Save As or a delete-confirm happens to be open closes
  // them rather than leaving several visible in the same bar.
  saveAsPrompt = null;
  renderSaveAsPrompt();
  deleteConfirm = null;
  renderDeleteConfirm();
  profileLoadPrompt = { name: name };
  renderProfileBar();
});

document.getElementById('save-btn').addEventListener('click', () => {
  profileBarStatus = { type: 'pending', message: 'Saving "' + activeProfile + '"...' };
  renderProfileBar();
  saveProfileContent(activeProfile, currentStagedProfileContent())
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Save failed');
      profileBarStatus = { type: 'success', message: 'Saved "' + activeProfile + '".' };
      renderProfileBar();
    })
    .catch((err) => {
      profileBarStatus = { type: 'error', message: err.message };
      renderProfileBar();
    });
});

// saveAsPrompt: null (idle) | {} (input showing) -- the typed name itself
// lives in the input element, not mirrored into this state, same as how
// e.g. the Notifications tab's row inputs read their own .value directly
// rather than tracking every keystroke in a parallel variable (nothing
// here needs to survive a re-render the way editableZones does).
let saveAsPrompt = null;

// Renders independently of renderProfileBar() -- deliberately never called
// from it. renderProfileBar() can fire from unrelated async completions
// (Load succeeding, Save's own status, etc.); if it also rebuilt this
// container every time, any one of those firing while the user is mid-type
// here would blow the input away and drop focus, the same class of bug
// CLAUDE.md's gotchas already call out elsewhere in this app (the WS-tick
// full-re-render issue). Keeping this container's lifecycle solely in the
// hands of the buttons/keys that actually open, submit, or cancel it avoids
// that entirely.
function renderSaveAsPrompt() {
  const container = document.getElementById('profile-save-as-prompt');
  container.innerHTML = '';
  if (!saveAsPrompt) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'profile-save-as-input';
  input.placeholder = 'New profile name';

  const warning = document.createElement('span');
  warning.className = 'profile-save-as-warning';

  // Live, in-place update on every keystroke -- same pattern as the Zones
  // tab's unit-conversion hints next to lower/upper inputs -- rather than a
  // full renderSaveAsPrompt() per keystroke, which would just be rebuilding
  // the very input the user is typing into.
  function updateWarning() {
    const trimmed = input.value.trim();
    warning.textContent = trimmed && profileNames.includes(trimmed) ? 'This will overwrite an existing profile.' : '';
  }

  input.addEventListener('input', updateWarning);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSaveAs(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      saveAsPrompt = null;
      renderSaveAsPrompt();
    }
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => submitSaveAs(input.value));

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    saveAsPrompt = null;
    renderSaveAsPrompt();
  });

  container.appendChild(input);
  container.appendChild(warning);
  container.appendChild(saveBtn);
  container.appendChild(cancelBtn);

  input.focus(); // pre-focused, per spec
}

// Empty/whitespace-only names are rejected silently (no error message --
// there's nothing meaningful to say beyond "you didn't type anything"),
// same not-yet-used treatment blank rows already get elsewhere in this
// app. The overwrite warning above is advisory only, not a second
// confirmation gate -- typing a name that collides with an existing
// profile and hitting Save still overwrites it, same as the old
// window.prompt flow always did; this only makes that visible beforehand
// instead of silent.
function submitSaveAs(rawName) {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return;

  saveAsPrompt = null;
  renderSaveAsPrompt();

  profileBarStatus = { type: 'pending', message: 'Saving as "' + trimmed + '"...' };
  renderProfileBar();
  saveProfileContent(trimmed, currentStagedProfileContent())
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Save failed');
      return setActiveProfile(trimmed);
    })
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Failed to set active profile');
      activeProfile = trimmed;
      if (!profileNames.includes(trimmed)) profileNames.push(trimmed);
      profileBarStatus = { type: 'success', message: 'Saved as "' + trimmed + '" and switched to it.' };
      renderProfileBar();
    })
    .catch((err) => {
      profileBarStatus = { type: 'error', message: err.message };
      renderProfileBar();
    });
}

document.getElementById('save-as-btn').addEventListener('click', () => {
  deleteConfirm = null;
  renderDeleteConfirm();
  saveAsPrompt = {};
  renderSaveAsPrompt();
});

// --- Delete profile ------------------------------------------------------
//
// The delete button always targets document.getElementById('profile-
// select').value -- i.e. whatever the dropdown is CURRENTLY showing, not a
// separately-tracked "selected for deletion" name. In practice that's
// always activeProfile, except for the brief window where the user has
// just picked a different profile in the dropdown and the Replace/Merge/
// Cancel prompt is showing but not yet resolved -- clicking Delete there
// targets that pending, not-yet-loaded, non-active name, which is the only
// way this UI lets a non-active profile actually reach the dropdown's
// current value (Cancel reverts it back to activeProfile otherwise).

function deleteProfileRequest(name) {
  return fetch('/plugins/signalk-alarms/profiles/' + encodeURIComponent(name), { method: 'DELETE' }).then((r) =>
    r.json().then((data) => ({ ok: r.ok, data: data }))
  );
}

// deleteConfirm: null (idle) | {name} -- the inline "delete this?" prompt
// for a non-active profile. Rendered independently of renderProfileBar(),
// same reasoning as renderSaveAsPrompt above (nothing here has a text
// input to protect mid-type, but keeping the pattern consistent rather
// than making this one case special).
let deleteConfirm = null;

function renderDeleteConfirm() {
  const container = document.getElementById('profile-delete-prompt');
  container.innerHTML = '';
  if (!deleteConfirm) return;

  const text = document.createElement('span');
  text.className = 'profile-delete-prompt-text';
  text.textContent = 'Delete profile "' + deleteConfirm.name + '"? This cannot be undone.';
  container.appendChild(text);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = 'Delete';
  confirmBtn.addEventListener('click', () => {
    const name = deleteConfirm.name;
    deleteConfirm = null;
    renderDeleteConfirm();
    profileBarStatus = { type: 'pending', message: 'Deleting "' + name + '"...' };
    renderProfileBar();
    deleteProfileRequest(name)
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'Delete failed');
        profileNames = profileNames.filter((n) => n !== name);
        // The dropdown may still be showing the just-deleted name (it was
        // the pending, not-yet-loaded Load target -- see the comment
        // above) -- fall back to activeProfile, which always still exists.
        document.getElementById('profile-select').value = activeProfile;
        profileLoadPrompt = null;
        profileBarStatus = { type: 'success', message: 'Deleted "' + name + '".' };
        renderProfileBar();
      })
      .catch((err) => {
        profileBarStatus = { type: 'error', message: err.message };
        renderProfileBar();
      });
  });
  container.appendChild(confirmBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    deleteConfirm = null;
    renderDeleteConfirm();
  });
  container.appendChild(cancelBtn);
}

document.getElementById('delete-profile-btn').addEventListener('click', () => {
  const name = document.getElementById('profile-select').value;

  // Both checks mirror the backend's own two rejections (index.js's DELETE
  // /profiles/:name) -- checked client-side first so the reason shows up
  // immediately rather than after a round trip, but the backend still
  // enforces both regardless (e.g. if activeProfile changed from another
  // tab/session between page load and this click).
  if (name === activeProfile) {
    profileBarStatus = { type: 'error', message: 'Can\'t delete "' + name + '" -- it\'s the active profile. Switch to a different profile first.' };
    renderProfileBar();
    return;
  }
  if (profileNames.length <= 1) {
    profileBarStatus = { type: 'error', message: 'Can\'t delete the last remaining profile.' };
    renderProfileBar();
    return;
  }

  saveAsPrompt = null;
  renderSaveAsPrompt();
  deleteConfirm = { name: name };
  renderDeleteConfirm();
});
