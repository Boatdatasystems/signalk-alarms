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

    const data = app.readPluginOptions() || {};
    if (!data.pathSettings || !data.profiles) {
      data.pathSettings = data.pathSettings || {};
      data.profiles = data.profiles || {};
      app.savePluginOptions(data, () => {
        app.debug('signalk-alarms: initialized pathSettings/profiles store');
      });
    }

    app.debug('signalk-alarms started');
  };

  plugin.stop = function () {
    app.debug('signalk-alarms stopping');
  };

  return plugin;
};
