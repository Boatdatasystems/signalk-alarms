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

    if (changed) {
      app.savePluginOptions(data, () => {
        app.debug('signalk-alarms: initialized pathSettings/profiles store');
      });
    }

    app.debug('signalk-alarms started');
  };

  plugin.stop = function () {
    app.debug('signalk-alarms stopping');
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
    // Real, working Commit: writes meta.zones directly via app.handleMessage.
    // SignalK server core unconditionally instantiates its own native Zones
    // watcher at startup (dist/zones.js: `new Zones(app.streambundle, ...)`)
    // that watches every path's meta.zones and fires real
    // notifications.<path> deltas on crossing -- confirmed empirically
    // against both signalk-server 2.32.0 and the Pi's actual installed
    // 2.31.1. No @signalk/zones ("zones-edit") plugin involvement needed or
    // wanted -- see CLAUDE.md "Architecture"/"Data model" for the
    // double-notification bug that combination caused. Also updates the
    // active profile's stored zones[path] to match, so it survives a
    // restart and "Get live" continues to agree with what's stored.
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

      // Writes meta.zones directly -- server core's own native zone watcher
      // does the actual enforcement (see CLAUDE.md "Architecture"/"Data
      // model"). An empty array here clears any previous zones for this
      // path (core treats an empty tests list as "everything falls in the
      // implicit normal gap" -- confirmed against its source, functionally
      // equivalent to no alarm).
      app.handleMessage(plugin.id, {
        context: 'vessels.' + app.selfId,
        updates: [
          {
            source: { label: plugin.id },
            meta: [{ path: path, value: { zones: cleanZones } }]
          }
        ]
      });

      persistZonesForPath(path, cleanZones, (err) => {
        if (err) {
          console.error(err);
          res.status(500).json({ error: 'meta written but failed to save profile: ' + err.message });
          return;
        }
        res.json({ ok: true, zones: cleanZones });
      });
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
  };

  return plugin;
};
