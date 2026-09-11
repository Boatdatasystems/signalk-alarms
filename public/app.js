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

// --- Zones tab: path list, filter bar, accordion shell (static display only) ---

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
// row hasn't fetched live data yet, still showing stored. null = fetched,
// server has no live zones for this path. array = fetched live zones.
let liveZones;
let liveFetchError = null;

// Live value marker: one WebSocket subscription for whichever row is
// expanded, opened on expand and closed on collapse/switch — see the header
// click handler. liveValue undefined = no reading yet; liveValueError set on
// socket failure.
let liveValueSocket = null;
let liveValue;
let liveValueError = null;

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
          renderZonesList();
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

function closeLiveValueSocket() {
  if (liveValueSocket) {
    liveValueSocket.close();
    liveValueSocket = null;
  }
  liveValue = undefined;
  liveValueError = null;
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
  const lowest = Math.min(...zones.map((z) => z.lower));
  const highest = Math.max(...zones.map((z) => z.upper));
  const span = highest - lowest || 1;

  zones.forEach((zone) => {
    const seg = document.createElement('div');
    seg.className = 'zone-bar-segment ' + (ZONE_STATE_CLASS[zone.state] || '');
    seg.style.left = ((zone.lower - lowest) / span) * 100 + '%';
    seg.style.width = ((zone.upper - zone.lower) / span) * 100 + '%';
    seg.title = zone.state + ': ' + zone.lower + ' - ' + zone.upper;
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
    header.appendChild(badge);
    // Mini preview always reflects stored profile data, regardless of
    // whether the expanded view below is currently showing a live fetch.
    header.appendChild(buildZoneBar(defaultProfileZones[path], 'mini'));

    header.addEventListener('click', () => {
      expandedPath = expandedPath === path ? null : path;
      liveZones = undefined;
      liveFetchError = null;
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
      label.textContent = liveZones !== undefined ? 'Live (from server)' : 'Stored (Default profile)';

      const liveBtn = document.createElement('button');
      liveBtn.type = 'button';
      liveBtn.className = 'get-live-btn';
      liveBtn.textContent = 'Get live';
      liveBtn.addEventListener('click', () => {
        liveBtn.disabled = true;
        liveBtn.textContent = 'Loading...';
        fetch('/plugins/signalk-alarms/live-meta?path=' + encodeURIComponent(path))
          .then((r) => r.json())
          .then((data) => {
            liveZones = data.zones;
            liveFetchError = null;
            renderZonesList();
          })
          .catch((err) => {
            liveFetchError = err.message;
            renderZonesList();
          });
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
      valueReadout.className = 'live-value-readout';
      if (liveValueError) {
        valueReadout.classList.add('zone-bar-error');
        valueReadout.textContent = liveValueError;
      } else {
        valueReadout.textContent =
          'Current value: ' + (liveValue === undefined ? 'no data yet' : formatLiveValue(liveValue));
      }
      body.appendChild(valueReadout);
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
      // Type filtering resolves the path-type question flagged in the last
      // two sessions: exclude a path only if its current value is CONFIRMED
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
