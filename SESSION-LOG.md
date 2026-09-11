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

**Live value awareness + resolve path-type filtering; settle getMetadata question**

Asked for: check `app.getMetadata`'s real implementation (does it read live data or wrap the
static package?); bulk one-shot value snapshot for all paths; exclude confirmed non-numeric
paths from the Zones tab (resolving a question flagged in the last two sessions); live value
readout on the expanded row via a per-path WS subscription, opened on expand and closed on
collapse/switch.

```
GET /plugins/signalk-alarms/values → {path: currentValueOrUndefined}
filter: keep if value is undefined (never reported) or a number; drop string/object/boolean
expand row → open WS subscribe for that one path → readout updates on delta
collapse/switch row → close that socket
```

Flagged & fixed against assumption (checked real signalk-server source, not memory):
- `app.getMetadata` checked directly in the compiled `dist/interfaces/plugins.js`: it's a
  literal re-export of `@signalk/path-metadata`'s own function
  (`getMetadata: path_metadata_1.getMetadata`), no live-tree fallback at all — confirms last
  session's `getSelfPath(path + '.meta')` was correct, not just the cautious-sounding guess.
- Built the `/values` endpoint around `app.getPath('vessels.self')` first, since that's the
  literal path segment the REST API accepts — it silently returned an empty tree. Turned out
  `'self'` is a REST-route-level alias (`rest.js` substitutes `app.selfId` before its own tree
  walk); `app.getPath()` itself does a raw `_.get()` with no such substitution. Fixed by using
  `app.getPath('vessels.' + app.selfId)` — confirmed `app.selfId` is a real accessible property
  by round-tripping it through a temporary debug response header before removing it.
- WS subscription shape/URL confirmed against `src/subscriptionmanager.js` and
  `src/interfaces/ws.js` directly: `/signalk/v1/stream?subscribe=none` on connect, then
  `{context: 'vessels.self', subscribe: [{path, period}]}`, deltas arrive as
  `{updates: [{values: [{path, value}]}]}`.

Flagged, not fixed (informational, not a decision to make):
- Tried to produce a real "path known to the server but with no current value" example to
  satisfy the verification step properly, and couldn't — by design, not by bad luck.
  `streambundle.js`'s `push()` only registers a path into `availableSelfPaths` (what
  `getAvailablePaths()` returns) on an actual value delta; a meta-only delta for a brand-new
  path is deliberately excluded (explicit source comment: avoids polluting the list with
  pre-registered schema templates). Confirmed by sending a meta-only delta for a fabricated
  path over WS — it appeared in neither `/paths` nor `/values`. So the code's `undefined`-value
  branch is currently unreachable through normal server operation; verified it's still correct
  via a direct synthetic test of the filter predicate instead (number/`0`/`undefined` → kept,
  string/object/boolean → excluded).

Verified: `navigation.position` (object-valued) and `navigation.attitude` (object-valued) both
confirmed gone from the Zones list after the fix; all-numeric paths remain. Expanded
`environment.wind.speedApparent` (continuously streaming from the demo generator) — the value
readout showed an initial reading, then visibly changed a few seconds later without touching
anything. Installed a runtime `WebSocket` constructor wrapper in the live page (not just visual
inspection) and confirmed directly: switching from one expanded row to another closes the first
socket before opening the second, collapsing closes the only open one — exactly one socket
alive at any time, never left dangling. Zero browser console messages, zero server-log errors
across the whole session.

---

**Verify @signalk/zones enforcement mechanism + minimal real Commit**

Asked for (three sequential parts, gated on each other): (1) confirm directly against a real
running server whether `@signalk/zones` enforces from its own persisted config or from `meta`,
and find the clean way to update another plugin's config if needed; (2) build a real, working
Commit — plain numeric inputs, not drag — using whatever Part 1 confirms, proven end-to-end
against a scratch server including a real notification firing on a real boundary crossing;
(3) deploy to the Pi carefully, only once Part 2 is fully proven locally.

Part 1 result — bigger and different than the prompt anticipated:
```
zones-edit (the actual installed plugin id for @signalk/zones) does read options.zones once at
start(), as assumed. But: signalk-server core itself unconditionally instantiates a native
Zones class at startup (dist/zones.js, `new Zones(app.streambundle, ...)` in dist/index.js)
that watches meta.zones on EVERY path and fires real notifications independent of any plugin.
Confirmed on both a fresh 2.32.0 install and a separately-installed 2.31.1 (the Pi's exact
version) -- not assumed to carry over between versions.
```
Consequence found, not asked for but couldn't ignore: running zones-edit's own config-based
path double-fires notifications (two distinct notification `id`s for one crossing) because
zones-edit's own meta side-effect gets picked up a second time by core's independent watcher.
Reported this back before writing any Commit code, since it invalidates the "reuse
@signalk/zones" architecture decision rather than just being an implementation detail. Given
the go-ahead to proceed on direct-meta-write instead, and to check the Pi's existing
`zones-edit` state first (read-only) -- came back disabled with empty config, not installed in
node_modules at all, so the double-fire risk is theoretical for this boat, not live.

Part 2 (this entry only covers up through here -- Part 3 continues below as it happens):
```
POST /plugins/signalk-alarms/commit-zone {path, zones:[{lower,upper,state}]}
  -> validate -> app.handleMessage() writes meta.zones -> profiles.Default.zones[path] updated
Zones tab row: lower/upper number inputs + state <select> + Commit button, plain inputs not drag
```
Verified end-to-end against the scratch server, via both direct API calls and the real browser
UI: committed a zone through the actual Commit button, confirmed a genuine
`notifications.<path>` delta existed server-side; separately drove WS deltas across a committed
boundary and watched a real `normal`→`alarm` transition with one stable notification id (no
double-fire, confirming Part 1's fix holds in practice).

Flagged & fixed against assumption, not just noted (checked real behavior, not memory):
- The live-value WebSocket handler called a full `renderZonesList()` on every delta. For a
  streaming path (i.e. the exact kind of path someone sets a real alarm on) that's ~1/sec,
  tearing down and rebuilding the Commit inputs on every tick and silently eating any
  in-progress typing. Found by trying to type a lower bound into a streaming row via browser
  automation and watching the field stay empty despite the type action reporting success --
  not a hypothetical, an actually-encountered failure. Fixed by updating the value readout's
  text in place instead of a full re-render; confirmed by typing into a live-streaming row's
  Lower field and watching it survive several ticks.

Verified: zero server-log errors and no browser console errors surfaced across the scratch
server work for this session so far.

Part 3 — deployed to the Pi, following the documented pattern exactly (scp, symlink, package.json
file: entry, systemctl restart). New environment difference from the scratch server: the Pi has
security enabled, so our own routes need auth like everything else -- used
`signalk-generate-token` over SSH (documented CLI, reads the username from security.json,
never touches the actual password) rather than asking for credentials.

Picked `test.test` (pre-existing Node-RED-sourced scaffold path, no zone/notification/consumer
attached) as the low-stakes test path. Same end-to-end proof as Part 2, this time against the
real boat: committed a zone via the real Commit mechanism, crossed it with a WS delta, got a
real `notifications.test.test` alarm delta back from the live server.

Found, not introduced by this session: `electrical.batteries.lifepo4.cellVoltage.1` (a real
LiFePO4 cell voltage path) already had a stray, mismatched zone -- stored config said
`{lower:3, upper:3.5}`, live meta said the degenerate `{lower:3, upper:3}` (can never match).
Evidence an earlier, apparently-interrupted session tested directly against a real battery path
rather than a synthetic one, before this session's continuation began (the plugin itself wasn't
even deployed yet when this session started -- confirmed no symlink, no package.json entry --
but its config file and a stray live meta write had already landed). Currently harmless (the
degenerate zone can't fire), but real orphaned state on real hardware, flagged rather than
quietly fixed. Cleaned up: cleared the stray meta (confirmed other meta fields --
units/alarmMethod -- untouched), removed it from the stored profile, backed up the config file
first.

Verified: `signalk.service` stayed `active (running)` on the same PID throughout, no new errors
in the journal beyond three already-known, pre-existing benign ones (missing festival package,
occasional mDNS ENETUNREACH, version-check fetch failure over no internet) -- all present
immediately after a clean restart too, unrelated to this plugin. Node-RED and other consumers
reconnected normally post-restart.

---

**Multi-zone editing per path; fix reported blank-input bug**

Asked for: fix two usability gaps Paddy found using the actual deployed Pi webapp, not the
scratch server -- reproduce both directly first, don't assume the cause from the description.

```
1. "Can only set 1 zone at a time"
2. "Live update doesn't seem to work, lower and upper text boxes remain blank"
```

Reproduced both against the Pi before touching code:
1. Committed a warn zone, then an alarm zone, on the same path via the old single-input flow --
   the warn zone vanished from both the stored profile and `meta.zones`. Confirmed: the old
   editor could only ever send a 1-element zones array, and the backend write is a full
   replace, not a merge. The backend route already accepted a full array; this was purely a
   frontend gap.
2. Expanded a row with an existing real committed zone
   (`electrical.batteries.lifepo4.cellVoltage.1`, Paddy's own `{alert, 3.3-3.55}`) and watched
   the lower/upper stay blank and the state dropdown show the hardcoded "alarm" default. The
   live *value* readout on the same row was working fine the whole time (watched it tick on two
   different real/test paths) -- the bug was specifically that the zone editor's inputs never
   read from stored (or live) data on expand, always reset blank. Stated this distinction
   explicitly before fixing, per what was asked.

Fixed:
```
draftZones: array, one {lower, upper, state} per row, not a single scalar triple
row expand -> zonesToDraft(defaultProfileZones[path]) seeds the list from stored data
Get live -> also overwrites draftZones with live meta.zones (closes a loop flagged 2 sessions ago)
Commit -> sends the whole draftZones array, blank rows skipped silently
```

Flagged, not silently worked around: testing the real deployed UI in a browser needed an
authenticated session (the Pi has security enabled, confirmed two sessions ago) -- rather than
touching Paddy's actual login, patched `window.fetch`/`WebSocket` inside the page's own JS
console to attach a `signalk-generate-token`-issued JWT (same token-generation approach as
before, just applied in-browser instead of via curl), then re-invoked the page's own
`loadZonesTab()`. Testing-only; the plugin itself still relies on the normal browser session
cookie, unchanged.

Verified end-to-end on the actual Pi: committed a warn band (0-50) and an alarm band (lower:50)
together on `test.test`, confirmed both persisted in the stored profile and `meta.zones`, then
drove WS deltas (25, then 75) and got the correct `warn` then `alarm` notification for each with
one stable notification id (no double-fire). Re-expanded the real battery-voltage row and
confirmed the inputs now show `3.3`/`3.55`/`alert` instead of blank. Injected a live-only zone
via a raw WS meta delta and confirmed "Get live" replaced the draft list with it. Cleaned up
`test.test`'s zone data afterward (it's disposable test scaffolding, per two sessions ago) --
left Paddy's real battery zone untouched throughout, only viewed it, never re-committed it.

Verified: zero browser console messages, zero new `signalk.service` log errors,
`signalk.service` stayed on the same PID (no restart needed -- only static frontend files
changed).

---
*Appended as sessions complete and results come back.*
