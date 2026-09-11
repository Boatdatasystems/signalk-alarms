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
  };

  return plugin;
};
