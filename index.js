const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function (app) {
  const plugin = {};

  plugin.id = 'signalk-alarms';
  plugin.name = 'Signal K Alarms';
  plugin.description = 'Savable, switchable alarm profiles for zones and notification sounds';

  // Configuration happens through this plugin's own webapp UI, not SignalK's
  // auto-generated admin form.
  plugin.schema = {
    type: 'object',
    properties: {}
  };

  // --- Notifications tab: sound playback state -------------------------
  // Module-scope (shared by plugin.start/stop and the router below), not
  // function-local -- plugin.start/stop can each run more than once against
  // the same plugin instance (enable/disable from the admin UI, a config
  // save that re-registers, etc.) without a full process restart, so this
  // must be reset on every start() and fully torn down on every stop() --
  // see the "Clean up properly" requirement.
  let notificationUnsubscribes = [];
  // path -> intervalId for a currently-repeating alarm. Keyed per PATH, not
  // per path+state: a path can only be in one state at a time, so a state
  // transition (e.g. warn -> alarm) must replace whatever repeat was
  // running for that path, never run two at once for the same path.
  let activeRepeats = new Map();
  // path -> last known non-derived state string ('alert'/'warn'/'alarm'/
  // 'emergency'/'normal'/'nominal'). Lets a genuine state transition be told
  // apart from a duplicate delta at the same state (e.g. a message/value-only
  // republish with no real change) -- the latter must not restart playback
  // or reset an in-progress repeat interval. Absent from this map (the
  // bootstrap replay of an alarm already active when the plugin started)
  // is deliberately treated as a fresh transition, so a restart doesn't go
  // silent on an alarm that was already sounding.
  let lastKnownState = new Map();

  // Single serial playback queue shared across every path/state -- mirrors
  // pi-deck-tools' apps/alerts/audio.py (mcd's own critical-alert player,
  // confirmed by reading its source on the Pi): several alarms firing at
  // once used to spawn overlapping players there too, turning into
  // unintelligible noise, fixed with exactly this one-queue/one-worker
  // pattern. Reused here instead of re-deriving it independently.
  let playQueue = [];
  let playing = false;
  const PLAYBACK_TIMEOUT_MS = 30000; // matches audio.py's play_wav_once timeout

  function soundsDir() {
    return path.join(app.getDataDirPath(), 'sounds');
  }

  // Confirmed by reading /etc/systemd/system/mcd.service on the Pi: mcd.py's
  // own working paplay invocation runs as a systemd service (User=pi, no
  // interactive login session) with Environment=XDG_RUNTIME_DIR=/run/user/1000
  // set explicitly -- without it, paplay/PipeWire can't find the user's audio
  // session from a bare systemd unit. signalk.service (also User=pi) does
  // NOT set this env var, so it must be supplied here rather than assumed
  // present. Computed from the running process's own uid rather than
  // hardcoding 1000, so this stays correct if this plugin is ever deployed
  // under a different account -- falls through to leaving it unset (paplay
  // will then fail the same way it would without this fix) on a platform
  // with no process.getuid (Windows dev/test boxes), rather than throwing.
  function xdgRuntimeDir() {
    if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
    if (typeof process.getuid === 'function') return '/run/user/' + process.getuid();
    return undefined;
  }

  // Plays sound files one at a time via `paplay --volume=65536` -- NOT
  // aplay. Checked the codebase/Pi for an established playback mechanism
  // first, per the task's own instruction to reuse rather than pick
  // independently: pi-deck-tools/apps/alerts/audio.py (mcd's critical-alert
  // player) already uses this exact invocation, with a comment noting it's
  // "already proven to work reliably on this hardware (PipeWire/HiFiBerry)"
  // -- stronger, hardware-specific evidence than CLAUDE.md's earlier,
  // never-implemented "use aplay" guess. A 30s kill-timeout mirrors that same
  // file's play_wav_once() (subprocess.run(..., timeout=30)) -- a hung
  // paplay process would otherwise jam this queue for every future alarm,
  // not just the one that hung, which is its own failure-path hazard per
  // CLAUDE.md's gotchas about backoff on the failure path, not just the
  // success path.
  function pumpPlayQueue() {
    if (playing || playQueue.length === 0) return;
    playing = true;
    const filename = playQueue.shift();
    const soundPath = path.join(soundsDir(), filename);
    const env = Object.assign({}, process.env);
    const rt = xdgRuntimeDir();
    if (rt) env.XDG_RUNTIME_DIR = rt;

    let child;
    try {
      child = spawn('paplay', ['--volume=65536', soundPath], { env: env });
    } catch (err) {
      app.debug('signalk-alarms: failed to spawn paplay for ' + filename + ': ' + err.message);
      playing = false;
      pumpPlayQueue();
      return;
    }

    const timeoutTimer = setTimeout(() => {
      app.debug('signalk-alarms: paplay timed out playing ' + filename + ', killing');
      child.kill();
    }, PLAYBACK_TIMEOUT_MS);

    child.on('error', (err) => {
      // e.g. ENOENT if paplay isn't installed -- log and move on, same as
      // audio.py's play_wav_once does (returns False, doesn't raise).
      app.debug('signalk-alarms: paplay error playing ' + filename + ': ' + err.message);
    });

    child.on('close', () => {
      clearTimeout(timeoutTimer);
      playing = false;
      pumpPlayQueue();
    });
  }

  function queuePlay(filename) {
    if (!filename) return;
    playQueue.push(filename);
    pumpPlayQueue();
  }

  function stopRepeatFor(path) {
    const timer = activeRepeats.get(path);
    if (timer) {
      clearInterval(timer);
      activeRepeats.delete(path);
    }
  }

  function getNotificationsConfig() {
    const options = app.readPluginOptions() || {};
    const configuration = options.configuration || {};
    return {
      notifications: configuration.notifications || {},
      defaultSound: configuration.defaultSound || null
    };
  }

  // Looks up config.notifications[path][state] and plays/repeats
  // accordingly; falls back to config.defaultSound (played once, never
  // repeated) when the path isn't configured at all, or is configured but
  // this specific state has no mapping -- per the task's explicit "don't
  // silently do nothing" requirement.
  function handleNotificationState(notifPath, state) {
    const previous = lastKnownState.get(notifPath);
    lastKnownState.set(notifPath, state);

    if (state === 'normal' || state === 'nominal') {
      stopRepeatFor(notifPath);
      return;
    }

    // Duplicate delta at the same already-alarming state (e.g. a
    // message/value-only republish with no real state change) -- must not
    // restart playback or reset an in-progress repeat interval. A missing
    // `previous` (nothing seen yet for this path -- including the bootstrap
    // replay of an alarm already active when the plugin started) is NOT
    // treated as a duplicate, so a plugin restart doesn't go silent on an
    // alarm that's already sounding.
    if (previous === state) return;

    stopRepeatFor(notifPath);

    const { notifications, defaultSound } = getNotificationsConfig();
    const stateConfig = notifications[notifPath] && notifications[notifPath][state];

    if (stateConfig && stateConfig.sound) {
      queuePlay(stateConfig.sound);
      if (stateConfig.mode === 'repeat') {
        const intervalMs = Math.max(1, Number(stateConfig.intervalSeconds) || 30) * 1000;
        activeRepeats.set(
          notifPath,
          setInterval(() => queuePlay(stateConfig.sound), intervalMs)
        );
      }
    } else if (defaultSound) {
      queuePlay(defaultSound);
    }
  }

  // Deltas from app.subscriptionmanager arrive in the standard delta shape
  // ({context, updates: [{values: [{path, value}]}]}) -- confirmed against
  // signalk-server's own streambundle.js (toDelta()) and subscriptionmanager.js
  // on the Pi, not assumed. A notification's value is an object with a
  // `state` field; meta-type updates (no `values`) and any value without a
  // `state` are not notifications and are ignored.
  function handleNotificationDelta(delta) {
    (delta.updates || []).forEach((update) => {
      (update.values || []).forEach((pathValue) => {
        const value = pathValue.value;
        if (!pathValue.path || !value || typeof value !== 'object' || !value.state) return;
        handleNotificationState(pathValue.path, value.state);
      });
    });
  }

  plugin.start = function (options) {
    app.debug('signalk-alarms starting');

    // `options` here (and app.readPluginOptions().configuration) is our
    // plugin's own persisted config blob. app.savePluginOptions() does NOT
    // overwrite the plugin's config file with what you pass it — it wraps
    // whatever you pass under a "configuration" key merged onto the file's
    // existing top-level contents (enabled, etc). Passing the full envelope
    // back in, as an earlier version of this file did, nests one level
    // deeper every restart. Confirmed against signalk-server's own source
    // (appCopy.savePluginOptions in src/interfaces/plugins.ts).
    const data = options || {};
    let changed = false;

    if (!data.pathSettings) {
      data.pathSettings = {};
      changed = true;
    }

    if (!data.profiles || Object.keys(data.profiles).length === 0) {
      data.profiles = { Default: { zones: {}, sounds: {} } };
      changed = true;
    }

    // Notifications tab config: plugin-owned JSON, top-level (not nested
    // under a profile) per this session's explicit design -- a path's sound
    // bindings apply the same way regardless of which zones profile is
    // active. `data.defaultSound === undefined` (not falsy) is the seed
    // check, since '' or null are both legitimate "not configured yet"
    // values once the user has actually saved the Notifications tab once
    // (e.g. cleared it back out) -- only truly absent (never saved) should
    // be seeded.
    if (!data.notifications) {
      data.notifications = {};
      changed = true;
    }
    if (data.defaultSound === undefined) {
      data.defaultSound = null;
      changed = true;
    }

    if (changed) {
      app.savePluginOptions(data, () => {
        app.debug('signalk-alarms: initialized pathSettings/profiles/notifications store');
      });
    }

    // Reset per-start state -- plugin.start()/stop() can each run more than
    // once against this same instance (e.g. disabling/re-enabling from the
    // admin UI) without a full process restart, so a leftover repeat timer
    // or stale last-known-state from a previous start() must not survive
    // into this one.
    notificationUnsubscribes = [];
    activeRepeats = new Map();
    lastKnownState = new Map();
    playQueue = [];
    playing = false;

    // Subscribes broadly to notifications.* via app.subscriptionmanager (not
    // a raw app.handleMessage listener, not polling) -- confirmed against
    // subscriptionmanager.js on the Pi that this also bootstraps from the
    // delta cache on subscribe, replaying the last known delta for every
    // notification path that already has one. That's desirable here, not
    // just incidental: it means an alarm already active when the plugin
    // starts (e.g. a restart while notifications.navigation.anchor is mid-
    // alarm) is picked up and sounded immediately, not silently missed
    // until its next state change.
    app.subscriptionmanager.subscribe(
      { context: 'vessels.self', subscribe: [{ path: 'notifications.*' }] },
      notificationUnsubscribes,
      (err) => {
        app.debug('signalk-alarms: notification subscription error: ' + err);
      },
      handleNotificationDelta
    );

    app.debug('signalk-alarms started');
  };

  plugin.stop = function () {
    app.debug('signalk-alarms stopping');
    // Clean up properly: unsubscribe from notifications.*, clear every
    // active repeat timer, and drop any queued-but-not-yet-played sound --
    // otherwise a restart leaves orphaned timers running (each still holding
    // a reference to this closure, so they'd keep firing against a plugin
    // instance that's supposedly stopped) or doubles up playback once
    // plugin.start() subscribes again.
    notificationUnsubscribes.forEach((unsubscribe) => unsubscribe());
    notificationUnsubscribes = [];
    activeRepeats.forEach((timer) => clearInterval(timer));
    activeRepeats.clear();
    lastKnownState.clear();
    playQueue = [];
  };

  // Mounted by the server at /plugins/signalk-alarms/* — see
  // doRegisterPlugin() in signalk-server's src/interfaces/plugins.ts.
  plugin.registerWithRouter = function (router) {
    const validStates = ['nominal', 'alert', 'warn', 'alarm', 'emergency'];

    // Shared by /commit-zone's persist step and /persist-zone -- the one
    // place that writes profiles.Default.zones[path] in the persisted
    // plugin config. An empty zones array is a legitimate "no alarm on
    // this path" end state, not an error: it deletes the path's entry
    // entirely rather than leaving a stale empty array behind, so GET
    // /config's stored profile genuinely shows no trace of a path that's
    // been fully cleared.
    function persistZonesForPath(path, zones, cb) {
      const options = app.readPluginOptions() || {};
      const configuration = options.configuration || {};
      if (!configuration.profiles) configuration.profiles = {};
      if (!configuration.profiles.Default) configuration.profiles.Default = { zones: {}, sounds: {} };
      if (!configuration.profiles.Default.zones) configuration.profiles.Default.zones = {};
      if (zones.length === 0) {
        delete configuration.profiles.Default.zones[path];
      } else {
        configuration.profiles.Default.zones[path] = zones;
      }
      app.savePluginOptions(configuration, cb);
    }

    // Shape normalization only (message/lower/upper trimmed to defined
    // values, per the meta.zones shape) -- not the "does this zone make
    // sense" validation, which only /commit-zone does (see below): a path
    // whose live meta already has some odd-shaped zone entry from another
    // tool shouldn't make "Get live" itself fail, since it's just honestly
    // reflecting what's actually live, not enforcing our own UI's rules on
    // someone else's data.
    function normalizeZones(zones) {
      return zones.map((zone) => {
        const entry = { state: zone.state };
        if (typeof zone.lower === 'number' && Number.isFinite(zone.lower)) entry.lower = zone.lower;
        if (typeof zone.upper === 'number' && Number.isFinite(zone.upper)) entry.upper = zone.upper;
        if (zone.message) entry.message = zone.message;
        return entry;
      });
    }

    router.get('/paths', (req, res) => {
      res.json(app.streambundle.getAvailablePaths());
    });

    // Live meta.zones for a path, straight from the running data model — NOT
    // the REST /meta endpoint. That endpoint (src/interfaces/rest.js) checks
    // @signalk/path-metadata's static getMetadata() first, and only falls
    // through to the live tree for paths that package has no built-in entry
    // for. Many common paths (e.g. most navigation.*/environment.* paths)
    // DO have a static entry (units/description), so that endpoint would
    // return only that and silently omit any real live zones — a false
    // "no zones" for exactly the paths most likely to have real zones set.
    // app.getSelfPath() is the documented plugin API for reading anything
    // from vessels.self in the live model (server_plugin_api docs), so
    // composing path + '.meta' reads the actual live meta, zones included.
    router.get('/live-meta', (req, res) => {
      const path = req.query.path;
      if (!path) {
        res.status(400).json({ error: 'path query parameter required' });
        return;
      }
      const meta = app.getSelfPath(path + '.meta');
      res.json({ zones: (meta && meta.zones) || null });
    });

    // One-shot snapshot of every known path's current value, for the Zones
    // tab's type filtering (exclude confirmed string/object paths) — not a
    // per-row subscription. app.getPath(path) is the same mechanism the REST
    // /vessels/self endpoint itself uses server-side (src/interfaces/rest.js:
    // app.signalk.retrieve(), walked down to the requested path — getPath()
    // does the identical _.get() internally) — one bulk read of the live
    // tree, not N per-path calls. NOTE: 'vessels.self' does NOT work here —
    // unlike the REST route (which special-cases the literal string 'self'
    // and substitutes app.selfId before its own tree walk), getPath() does a
    // raw lodash _.get() with no such substitution, so plain 'self' silently
    // resolves to nothing. Confirmed by testing against a running server:
    // 'vessels.self' returned an empty tree, 'vessels.' + app.selfId (the
    // real vessel UUID, also confirmed real via app.selfId) returned the
    // populated one. Node shape confirmed too: {value, $source, timestamp,
    // meta}; value can be a number, string, object, or absent entirely for a
    // path that's never reported data.
    // Real, working Commit: writes meta.zones via app.putSelfPath(), NOT
    // app.handleMessage(). handleMessage() only publishes a delta into the
    // live data model -- it updates what the Data Browser shows and feeds
    // signalk-server core's own native Zones watcher (dist/zones.js: `new
    // Zones(app.streambundle, ...)`, which fires real notifications.<path>
    // deltas on crossing, confirmed against both 2.32.0 and the Pi's
    // 2.31.1) -- but it never writes to disk. A zone committed this way
    // looked saved and evaluated live, but silently vanished on the next
    // signalk-server restart. app.putSelfPath(path, value, cb, source), for
    // a path ending in `.meta`/`.meta.<field>`, instead routes through the
    // server's actual PUT pipeline (putMetaHandler) -- the same code path
    // the admin UI's own "Edit Metadata -> Save" button uses -- which
    // updates live state AND calls writeBaseDeltasFile(app), persisting
    // into ~/.signalk/baseDeltas.json. Targeting `.meta.zones` specifically
    // (not `.meta` as a whole) merges into the existing meta object
    // server-side, so units/description/displayUnits already set on this
    // path survive untouched. No @signalk/zones ("zones-edit") plugin
    // involvement needed or wanted -- see CLAUDE.md "Architecture"/"Data
    // model" for the double-notification bug that combination caused. Also
    // updates the active profile's stored zones[path] to match, so "Get
    // live" continues to agree with what's stored.
    router.post('/commit-zone', (req, res) => {
      const body = req.body || {};
      const path = body.path;
      const zones = body.zones;

      if (!path || typeof path !== 'string') {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      // An empty array is a legitimate "clear every zone from this path"
      // request (no alarm wanted here), not an error -- only require the
      // array to exist. Validation below only runs over whatever zones ARE
      // present in it, so it can't block a genuinely empty submission.
      if (!Array.isArray(zones)) {
        res.status(400).json({ error: 'zones must be an array' });
        return;
      }
      for (const zone of zones) {
        if (!validStates.includes(zone.state)) {
          res.status(400).json({ error: 'invalid state: ' + zone.state });
          return;
        }
        const hasLower = typeof zone.lower === 'number' && Number.isFinite(zone.lower);
        const hasUpper = typeof zone.upper === 'number' && Number.isFinite(zone.upper);
        if (!hasLower && !hasUpper) {
          res.status(400).json({ error: 'each zone needs at least a lower or upper bound' });
          return;
        }
      }

      const cleanZones = normalizeZones(zones);
      let responded = false;

      // Real PUT through the server's actual pipeline (see the comment
      // above this route) so the write survives a restart. An empty array
      // here clears any previous zones for this path -- the server itself
      // converts an empty zones array to null before saving, and core's
      // native watcher treats a null/empty test list as "everything falls
      // in the implicit normal gap", functionally equivalent to no alarm.
      // putSelfPath's callback can fire more than once for a single PUT
      // (PENDING, then a terminal state) -- only PENDING is real "no error
      // thrown yet", not success, so it's explicitly ignored here rather
      // than treated as a response. Only a terminal COMPLETED with a
      // non-error statusCode counts as success; anything else (a
      // permission/validation FAILED, or a non-2xx statusCode) is surfaced
      // to the caller as a real failure instead of silently looking saved.
      app.putSelfPath(
        path + '.meta.zones',
        cleanZones,
        (result) => {
          if (responded) return;
          if (!result || result.state === 'PENDING') return;
          if (result.state !== 'COMPLETED' || result.statusCode >= 300) {
            responded = true;
            res.status(502).json({
              error:
                'failed to write zones to server: ' +
                (result.message || result.state || ('status ' + result.statusCode))
            });
            return;
          }
          responded = true;
          persistZonesForPath(path, cleanZones, (err) => {
            if (err) {
              console.error(err);
              res.status(500).json({ error: 'meta written but failed to save profile: ' + err.message });
              return;
            }
            res.json({ ok: true, zones: cleanZones });
          });
        },
        plugin.id
      );
    });

    // Get Live's persistence step (see CLAUDE.md "Stored state vs. live:
    // sync philosophy" and the revised "Get live" decision under "Tab 1 —
    // Zones"): writes a zones array (read by the caller from GET
    // /live-meta) straight into the stored profile via the same
    // persistZonesForPath() helper /commit-zone uses -- deliberately does
    // NOT touch meta or call app.handleMessage at all. Get Live reads live,
    // writes stored + draft, nothing else; Commit remains the only thing
    // that writes to the live server.
    router.post('/persist-zone', (req, res) => {
      const body = req.body || {};
      const path = body.path;
      const zones = body.zones;

      if (!path || typeof path !== 'string') {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      if (!Array.isArray(zones)) {
        res.status(400).json({ error: 'zones must be an array' });
        return;
      }

      const cleanZones = normalizeZones(zones);

      persistZonesForPath(path, cleanZones, (err) => {
        if (err) {
          console.error(err);
          res.status(500).json({ error: 'failed to save profile: ' + err.message });
          return;
        }
        res.json({ ok: true, zones: cleanZones });
      });
    });

    // Bulk live meta.zones for every known path in one request -- backs the
    // global Refresh/Send-to-server actions (see CLAUDE.md "Two-state
    // model: Server vs. Profile"), which need to compare Server against
    // Profile for the whole list at once rather than one GET /live-meta
    // call per path. Reuses the exact same bulk-tree-walk approach as
    // /values below (confirmed in an earlier session: the tree node shape
    // is {value, $source, timestamp, meta}, so .meta.zones is already
    // sitting right there in the same tree /values already walks) instead
    // of calling app.getSelfPath() once per path.
    router.get('/live-zones', (req, res) => {
      const tree = app.getPath('vessels.' + app.selfId) || {};
      const paths = app.streambundle.getAvailablePaths();
      const zonesByPath = {};
      paths.forEach((path) => {
        if (!path) return;
        const node = path
          .split('.')
          .reduce((obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined), tree);
        zonesByPath[path] = node && node.meta && Array.isArray(node.meta.zones) ? node.meta.zones : null;
      });
      res.json(zonesByPath);
    });

    router.get('/values', (req, res) => {
      const tree = app.getPath('vessels.' + app.selfId) || {};
      const paths = app.streambundle.getAvailablePaths();
      const values = {};
      paths.forEach((path) => {
        if (!path) return;
        const node = path
          .split('.')
          .reduce((obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined), tree);
        values[path] = node && Object.prototype.hasOwnProperty.call(node, 'value') ? node.value : undefined;
      });
      res.json(values);
    });

    // Lists the actual .wav files present in the sounds directory on disk --
    // the Notifications tab's dropdown is populated from this, never a
    // hardcoded list, per the same "typo'd path here is a real failure mode"
    // reasoning CLAUDE.md already applies to the Zones tab's sound picker.
    // The directory itself is created by hand on the Pi, not by this plugin
    // (see CLAUDE.md/task instructions) -- ENOENT here just means "no sounds
    // added yet", an empty list, not an error.
    router.get('/sounds', (req, res) => {
      fs.readdir(soundsDir(), (err, files) => {
        if (err) {
          if (err.code === 'ENOENT') {
            res.json({ sounds: [] });
            return;
          }
          console.error(err);
          res.status(500).json({ error: 'failed to list sounds: ' + err.message });
          return;
        }
        const sounds = files.filter((f) => f.toLowerCase().endsWith('.wav')).sort();
        res.json({ sounds: sounds });
      });
    });

    const validNotificationStates = ['alert', 'warn', 'alarm', 'emergency'];
    const validPlaybackModes = ['once', 'repeat'];

    // Saves the whole Notifications tab config in one shot -- notifications
    // (path -> state -> {sound, mode, intervalSeconds}) and defaultSound.
    // Unlike the Zones tab's zones (which reconcile against a live "Server"
    // copy via Get Live/Commit/Refresh/Send-to-server), this is plugin-owned
    // config with nothing else to reconcile against, so there's no per-path
    // merge step here the way persistZonesForPath has for zones -- the
    // submitted notifications object simply replaces the stored one
    // wholesale, same as any plain settings form. Deliberately does NOT
    // reuse the server's generic POST /plugins/<id>/config (which restarts
    // the plugin on every save, per CLAUDE.md's gotcha about that route) --
    // a restart on every Notifications-tab save would tear down the live
    // notification subscription and any in-progress repeat timers/queued
    // sounds for no reason, since app.savePluginOptions() (used here, same
    // as every other route in this file) already persists without one.
    router.post('/notification-config', (req, res) => {
      const body = req.body || {};
      const notifications = body.notifications;
      const defaultSound = body.defaultSound;

      if (!notifications || typeof notifications !== 'object' || Array.isArray(notifications)) {
        res.status(400).json({ error: 'notifications must be an object' });
        return;
      }

      let availableSounds;
      try {
        availableSounds = new Set(
          fs
            .readdirSync(soundsDir())
            .filter((f) => f.toLowerCase().endsWith('.wav'))
        );
      } catch (err) {
        availableSounds = new Set();
      }

      // Defense in depth, not the only check -- the frontend dropdown is
      // already populated from GET /sounds so a normal save can't submit an
      // unknown filename, but a typo'd/stale sound reference here is exactly
      // the "looks configured, silently does nothing at alarm time" failure
      // mode this whole picker-not-freehand-textbox approach exists to rule
      // out (same reasoning CLAUDE.md already applies to the Zones tab).
      function soundError(sound, context) {
        if (!sound || typeof sound !== 'string') return 'missing sound file for ' + context;
        if (!availableSounds.has(sound)) {
          return "sound file '" + sound + "' not found in sounds directory (" + context + ')';
        }
        return null;
      }

      if (defaultSound !== null && defaultSound !== undefined && defaultSound !== '') {
        const err = soundError(defaultSound, 'defaultSound');
        if (err) {
          res.status(400).json({ error: err });
          return;
        }
      }

      const cleanNotifications = {};
      for (const notifPath of Object.keys(notifications)) {
        const stateMap = notifications[notifPath];
        if (!stateMap || typeof stateMap !== 'object' || Array.isArray(stateMap)) {
          res.status(400).json({ error: 'invalid state map for path ' + notifPath });
          return;
        }
        const cleanStates = {};
        for (const state of Object.keys(stateMap)) {
          if (!validNotificationStates.includes(state)) {
            res.status(400).json({ error: 'invalid state "' + state + '" for path ' + notifPath });
            return;
          }
          const entry = stateMap[state] || {};
          const err = soundError(entry.sound, notifPath + '/' + state);
          if (err) {
            res.status(400).json({ error: err });
            return;
          }
          if (!validPlaybackModes.includes(entry.mode)) {
            res.status(400).json({ error: 'invalid mode for ' + notifPath + '/' + state });
            return;
          }
          const clean = { sound: entry.sound, mode: entry.mode };
          if (entry.mode === 'repeat') {
            const interval = Number(entry.intervalSeconds);
            // >= 1s minimum: an unbounded-small interval here is the same
            // family of bug as signalk-notification-player's retry-storm
            // gotcha in CLAUDE.md (a failure/repeat path with no floor on
            // its own cadence pegged the Pi) -- our repeat is timer-driven
            // rather than retry-on-failure, but a 0 or fractional-second
            // interval would recreate the same shape of problem.
            if (!Number.isFinite(interval) || interval < 1) {
              res.status(400).json({ error: 'intervalSeconds must be a number >= 1 for ' + notifPath + '/' + state });
              return;
            }
            clean.intervalSeconds = interval;
          }
          cleanStates[state] = clean;
        }
        if (Object.keys(cleanStates).length > 0) {
          cleanNotifications[notifPath] = cleanStates;
        }
      }

      const options = app.readPluginOptions() || {};
      const configuration = options.configuration || {};
      configuration.notifications = cleanNotifications;
      configuration.defaultSound = defaultSound || null;

      app.savePluginOptions(configuration, (err) => {
        if (err) {
          console.error(err);
          res.status(500).json({ error: 'failed to save notification config: ' + err.message });
          return;
        }
        res.json({ ok: true, notifications: cleanNotifications, defaultSound: configuration.defaultSound });
      });
    });
  };

  return plugin;
};
