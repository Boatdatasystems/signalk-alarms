# Session log

Terse chronological trail of what was asked vs. what actually happened, for anyone following
the SignalK "AI agent guidelines" discussion. Design context and current decisions live in
CLAUDE.md — this is just the "what happened, in what order" record. No fabricated timestamps
below; real ones are in `git log` if you want exact times.

---

**Scaffold** — plugin + webapp shell, no zone/notification logic yet

Asked for: package.json, index.js, public/ shell, two tabs, nothing functional inside them.

Did it like:
```
plugin.start → readPluginOptions(); if empty, savePluginOptions({pathSettings:{}, profiles:{}})
public/index.html → tabs [Zones | Notifications] + profile bar (Save/Save as... stubs, no handlers)
```

Flagged & fixed against assumption (checked real signalk-server source, not memory):
- package.json keyword: `signalk-node-server-plugin`, not `signalk-plugin`
- config persists to one file `plugin-config-data/signalk-alarms.json`, not a directory

Verified: loaded clean on a scratch local signalk-server 2.32.0, config persisted, webapp
served and rendered, tabs switched.

---

**Path list + filter + accordion shell**

Asked for: seed a real `Default` profile on first run; endpoint exposing
`streambundle.getAvailablePaths()`; Zones tab search+source filter bar; accordion rows,
static (read-only) zone display per row from `profiles.Default.zones[path]`.

```
GET /plugins/signalk-alarms/paths → getAvailablePaths()
filter: text match on path + source = top-level namespace segment
row click → expand/collapse, one open at a time
```

Flagged & fixed against assumption (checked real signalk-server source, not memory):
- `plugin.registerWithRouter(router)` is the current custom-route mechanism; server mounts the
  router at `/plugins/<pluginId>/`, so `/paths` → `/plugins/signalk-alarms/paths`.
- Bigger one, caught mid-session, not something the prompt asked to check: `index.js` from the
  scaffold session was calling `app.savePluginOptions()` with the *full* `{enabled,
  configuration}` envelope it got back from `app.readPluginOptions()`. Turns out
  `savePluginOptions(x)` wraps whatever you pass under a fresh `configuration` key merged onto
  the file's existing contents — it doesn't overwrite flatly. Passing the whole envelope back in
  nested it one level deeper under `configuration` on every restart. Caught this by diffing the
  scratch config file across two restarts and seeing the nesting grow. Fixed by using `start()`'s
  own `options` argument (which already is the inner blob) instead of re-reading the full
  envelope; fixed the webapp's `config.pathSettings` read the same way (it's
  `config.configuration.pathSettings`).

Flagged, not fixed (left for a decision, not invented):
- No UI/data yet for `pathSettings[path].min/max`, so the static zone bar auto-fits to whatever
  the zone entries' own bounds are when zones exist — not the real editor scale.
- Zones tab excludes `notifications.*` paths (Tab 2's job) and the one empty-string path
  `getAvailablePaths()` returns, but does not filter by value type — string/object paths like
  `navigation.position` still show up. `getAvailablePaths()` gives no type info; didn't want to
  add per-path value lookups to a static list/filter shell.

Verified: against a scratch local signalk-server 2.32.0 (same one from the scaffold session,
reused) — `/paths` returns real demo-data paths, config persists in the correct flat shape
across two restarts (no re-nesting), search and source filter both narrow the real fetched list,
accordion confirmed single-open (expanding one row visibly collapsed the previously-open one),
zero browser console messages, zero server-log errors.

---

**"Get live" preview**

Asked for: verify the real mechanism for reading a path's live `meta.zones` against source
(not assumed); per-row "Get live" button, read-only, shows live zone data distinct from
stored profile data.

```
[Get live] click → fetch live meta.zones for path → render, labelled "live" not "stored"
no live zones → show that plainly, not blank/broken
```

Flagged & fixed against assumption (checked real signalk-server source, not memory):
- The REST meta endpoint (`/signalk/v1/api/vessels/self/<path>/meta`) looked plausible — it's
  a real, working route — but reading `src/interfaces/rest.js` in the actual installed 2.32.0
  package showed it checks `@signalk/path-metadata`'s static `getMetadata()` first and only
  falls through to live data for paths that static package has no entry for. Most common
  `navigation.*`/`environment.*` paths DO have a static units entry, so that endpoint would
  have silently returned only static metadata and omitted real live zones on exactly the paths
  most likely to have them — used `app.getSelfPath(path + '.meta')` instead (documented plugin
  API method, confirmed against both the installed source and the public ServerAPI docs).

Verified: manually injected a real zone onto `environment.wind.speedApparent` (sent a delta
with a `meta` array over the server's WebSocket input stream — no REST POST exists for setting
meta) — "Get live" retrieved and displayed it correctly (three colored segments matching what
was sent), outlined and labelled "LIVE (FROM SERVER)" in blue. A path with no live zones
(`navigation.attitude`) showed "No live zones for this path." cleanly, distinct from the
stored-data empty message. Zero browser console messages, zero server-log errors across the
whole session.

---
*Appended as sessions complete and results come back.*
