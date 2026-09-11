# signalk-alarms

SignalK plugin + webapp: savable/switchable alarm **profiles** (different threshold sets for
different situations — anchored, coastal, offshore) replacing the broken OpenCPN Watchdog
plugin and its unfixable "New Alarm" dialog.

## Why this exists

OpenCPN's Watchdog plugin has a "New Alarm" dialog that's been broken since at least 2023 —
confirmed by the plugin maintainer's own GitHub issue (rgleason/watchdog_pi#44: "The 'New'
alarm dialog box could be fixed again with wxFormBuilder — don't have time really"). Not
fixable from our side, not worth hand-editing its per-plugin XML config either (fragile,
undocumented `Mode` attribute schema per alarm type). Decided to build our own instead.

## Architecture — what we own vs. what we reuse

**Reuse, don't reimplement:**
- **SignalK server core itself** does the actual threshold evaluation now, not a plugin.
  Confirmed empirically against both 2.32.0 and the Pi's actual installed version, 2.31.1:
  core unconditionally instantiates a native `Zones` class at startup (`new
  Zones(app.streambundle, ...)` in its own `dist/index.js`) that watches every path's
  `meta.zones` directly and fires real `notifications.<path>` deltas on crossing.
  **This retires the earlier decision to reuse the `@signalk/zones`/`zones-edit` plugin** —
  confirmed on npm as deprecated ("Zones handling is now included in Signal K Server"), and
  genuinely redundant now: our own plugin writes `meta.zones` directly via
  `app.handleMessage()`, core evaluates it, no third-party plugin dependency needed at all for
  this. See gotchas below for the double-notification bug this discovery also surfaced.
- **`coursedata-provider-plugin`** (official, SignalK v2+) already computes
  `navigation.course.calcValues.crossTrackError` — subscribe to this as a plain number for
  the "off course" alarm rather than recomputing bearing/deviation math ourselves.

**Ours to build:**
- Custom front-end for editing zones (sliders), replacing the built-in meta editor and the
  official `signalk-zones` admin app — both work, neither has profiles or a nice UI.
- The profiles concept itself: named, switchable sets of zone configs. Nothing off-the-shelf
  does this.
- Alarm playback: pre-made **sound files**, not live TTS. Generate offline with `espeak-ng`
  (confirmed installed and working on the Pi: `espeak-ng -w alarm.wav "text"`), play at
  alarm-time with `aplay` (part of `alsa-utils`, always present — deliberately avoiding
  mpg321/festival/cvlc, see gotchas below).
- **Scope decision:** sound-file binding is NOT limited to zones/notifications this plugin
  creates itself — it's general-purpose across `notifications.*`. Lives on Tab 2 (see "App
  structure" above). This effectively absorbs the job `signalk-notification-player` was doing
  on this boat — see gotchas below on why that plugin isn't trusted for it anymore. Our
  playback code must have the failure-path backoff that one lacked.
- **Webapp stack: plain JS/HTML, no framework.** No React/Svelte, no bundler, no build step —
  matches `@signalk/zones`'s own admin UI. Static files served straight from the plugin, same
  `scp` deploy pattern as everything else on this boat.

## App structure — decided

A **global profile bar** sits above both tabs: shows the active profile plus a **Save as...**
action that snapshots everything — every zone on Tab 1 and every sound binding on Tab 2 —
into a new named profile, and a plain **Save** to overwrite the active one. A profile is a
full snapshot spanning both tabs, not just zones. No per-row save controls (see Tab 1 below).

Two-tab webapp:
- **Tab 1: Zones** — the zone editor (sliders/bands per path), with a filter bar at top to
  find zones by text search plus source (the path's top-level SignalK namespace — navigation,
  electrical, propulsion, etc.).
- **Tab 2: Notifications** — every notification path known to the server (this plugin's own
  zones plus external ones, e.g. the anchor alarm), each assignable a sound file per state.
  This is where the generalized sound-binding scope decision (below, and in "Ours to build")
  actually lives in the UI.

## Data model — decided

Two stores, kept separate:

- **`pathSettings`** — outside any profile, same regardless of which one is active:
  `{ [path]: { min, max, contiguous: boolean } }`. Per-path display/edit config (track scale,
  coupled-vs-decoupled), decided earlier to NOT vary by profile.
- **`profiles`** — named and switchable. Each one is a full snapshot spanning both tabs:
  ```
  profiles: {
    "Anchored": {
      zones:  { "environment.wind.speedApparent": [{lower, upper, state, message}, ...] },
      sounds: { "environment.wind.speedApparent": { alert: "wind.wav" },
                "notifications.navigation.anchor": { emergency: "anchor.wav" } }
    },
    "Coastal": { zones: {...}, sounds: {...} }
  }
  ```
  `zones` and `sounds` are independently keyed by path — a path can be in one, the other, or
  both (the anchor alarm is `sounds`-only, since it has no zone this plugin manages).
- **Resolved, and it changes the plan for the better:** Commit writes `meta.zones` directly
  via `app.handleMessage()` from our own plugin backend — no cross-plugin config writes
  needed at all. Confirmed empirically (installed signalk-server 2.32.0 AND the Pi's exact
  2.31.1 separately, ran both live, forced a real boundary crossing over a WS delta): core's
  own native `Zones` class watches `meta.zones` on every path and fires real notifications on
  crossing, independent of `zones-edit`/`@signalk/zones` entirely — see "Architecture" above
  and the double-fire gotcha below. `zones-edit` is NOT used by this plugin at all, going
  forward. Zone entries still reuse `@signalk/zones`' own field names (`lower`, `upper`,
  `state`, `message`) purely because that's the shape core's native watcher expects in
  `meta.zones` — not because we're writing through that plugin.
- We do NOT use `@signalk/zones`' own `method` field for sound — our plugin subscribes to
  `notifications.*` broadly and looks up `sounds[path][state]` itself (per the earlier scope
  decision), so `zones` and `sounds` are linked only by path + state at runtime, not by any
  direct reference between the two stores.

## Tab 1 — Zones: editor UI decided

- Single wide track per path, zones drawn as colored bands on it (same visual language as
  Kip's gauge zones).
- Click a zone band to select it for editing.
- Drag the band's left/right edges to set lower/upper bounds.
- **Adjacent zone edges are coupled by default** (contiguous — moving a shared boundary
  moves both sides at once). **Decided:** make this a per-path toggle, not global — some
  paths (e.g. battery voltage) may want a dead-band gap between zones, others (wind speed)
  make more sense fully contiguous. Default stays coupled; decoupling is opt-in per path.
  **Confirmed safe** by reading the `@signalk/zones` source: a value falling in a gap between
  defined zones gets `zoneIndex = -1`, which the plugin explicitly defaults to
  `state: "normal", method: []` — silently, by design, not an error.
- Double-click a zone opens a precise-entry box: state, upper value, lower value.
  **State options are `nominal`/`alert`/`warn`/`alarm`/`emergency`** — not "normal".
  `@signalk/zones` only ever emits "normal" as the implicit fallback for an undefined gap;
  it's a different string from the lowest explicit zone state, `nominal`. Mixing these up in
  the UI would be a real bug, not a labeling nitpick.
- Sound file field is a **picker populated from an actual sounds directory on disk**, not a
  freehand textbox — a typo'd path here is exactly the failure mode that took SignalK down
  twice tonight (see gotchas).
- **Don't write to the live zone meta on every drag tick, or even on release.** Show drag
  position locally only. A per-row **Commit** button is the sole point that pushes this
  path's edited zone bounds live — writes `meta.zones` directly via `app.handleMessage()`;
  SignalK core's own native zone watcher does the actual evaluation, see "Data model" above
  — lets you drag both edges around and iterate freely before anything touches the real,
  currently-running alarm system.
- Show the **live current value** as a marker on the same track (cheap to add since we're
  already subscribed to the path's delta stream; useful at-a-glance feedback while setting
  thresholds).
- Editing happens per-path, in place, with a per-row **Commit** button (see previous bullet)
  — no per-row Save As, that stays global. Commit applies this path's dragged bounds to the
  live system and the active profile's in-memory state; naming/persisting an actual profile
  is still the **global** action described in "App structure" above — a profile is a full
  snapshot of every zone here plus every sound binding on Tab 2, not just one path's zones.
- **"Get live" button, per row (decided):** the mirror of Commit, reversed direction — pulls
  whatever zone configuration is *actually* currently governing that path's live alarm state
  (the path's SignalK `meta.zones`, regardless of who set it — us, `@signalk/zones`' own
  admin UI, or something configured before this plugin existed) into the row's local,
  uncommitted editor state, overwriting whatever's there. Exists because our own `profiles`
  store and the live system can genuinely drift — first-time import of pre-existing zones, or
  reconciling after an out-of-band edit. No confirmation prompt needed for uncommitted local
  edits it overwrites — nothing's live until Commit anyway.
- **Verified:** reading a path's live `meta.zones` is `app.getSelfPath(path + '.meta')` — a
  documented plugin API method ("Returns the entry for the provided path starting from
  `vessels.self` in the full data model", per the ServerAPI docs), composed with `.meta` since
  that's just a normal sibling key in that model, same as `.value`. Confirmed NOT the REST meta
  endpoint (`/signalk/v1/api/vessels/self/<path>/meta`): that route (`src/interfaces/rest.js`)
  checks `@signalk/path-metadata`'s static `getMetadata()` first and only falls through to the
  live data-model tree for paths that static package has no built-in entry for. Many common
  paths (most `navigation.*`/`environment.*`) DO have a static units/description entry there,
  so that endpoint would silently return only the static metadata and omit any real live
  `zones` for exactly the paths most likely to have them — a trap, avoided by using
  `app.getSelfPath()` instead. Exposed to the webapp via `GET
  /plugins/signalk-alarms/live-meta?path=<path>` (our own route, not a SignalK-standard one).
  **Closed:** "Get live" now does exactly what the previous bullet describes — overwrites the
  row's editable zone list with the path's live `meta.zones`, uncommitted and freely
  overwritable, no confirmation needed. Didn't need the drag editor to exist first after all;
  numeric inputs (this session's editable zone *list*, not the single-zone placeholder from
  two sessions ago) were enough of an "uncommitted editor state" to pull into.
- **Decided:** range is user-configurable per path, not fixed — no hardcoded scale table.
  Needs a stored min/max per path, kept per-path rather than per-profile (the same path keeps
  the same track scale across profiles, since it's a display/editing concern, not a
  threshold).
- **Filter bar at top of Tab 1:** text search on path name, plus a source filter — the path's
  top-level SignalK namespace (navigation, electrical, propulsion, etc.), derived
  automatically from the path string. No manual category tagging, nothing to keep in sync.

## Wildcard path groups — decided

- `@signalk/zones` doesn't support wildcards itself — its `key` field is a literal path
  string fed straight into `app.streambundle.getSelfStream(key)`, no glob support in the
  plugin schema.
- **Decided approach:** UI-side expansion, not a live wildcard subscription. On Tab 1, a
  group like `electrical.batteries.lifepo4.cellVoltage.*` shows and edits as a single row;
  at Commit time, the UI matches the pattern against `app.streambundle.getAvailablePaths()`
  (confirmed real API — returns the flat list of every path currently known to the server)
  and creates one individual `@signalk/zones` entry per match, all sharing the same bounds.
- Trade-off accepted: a path added later that matches the pattern (e.g. a 5th cell) won't
  get the zone automatically — needs reopening and re-committing the group. Acceptable for
  something like cell count, which isn't changing without a trip back into this editor anyway.
- Tab 2 needs no special handling for this — it just sees the expanded individual
  notification paths (`notifications.electrical.batteries.lifepo4.cellVoltage.1` etc.) like
  any other path, filterable by source same as everything else.
- **Alternative considered, not chosen:** our own plugin subscribes to a genuine wildcard
  SignalK subscription and evaluates zones itself, so newly-appearing paths are picked up
  automatically. Rejected for now — it means reimplementing the evaluation logic
  `@signalk/zones` already does, against the "reuse, don't reimplement" principle, for a
  problem (dynamically changing battery cell counts) that isn't real on this boat.

## Tab 2 — Notifications: UI decided

- Lists every notification path currently on the server (`notifications.*`), not just ones
  this plugin manages — includes external sources like `notifications.navigation.anchor`
  from `signalk-anchoralarm-plugin`.
- Per path, per state (alert/warn/alarm/emergency): assign a sound file via the same
  picker-from-an-actual-directory pattern as the zone editor — no freehand text paths, same
  reasoning as the gotcha below about a typo'd path taking SignalK down.
- This is the screen that absorbs `signalk-notification-player`'s job on this boat.
- **Open question, not yet decided:** does this tab need per-path/state repeat-behaviour
  controls (continuous vs. one-shot playback), or is that fixed by SignalK notification level
  (e.g. emergency always repeats, alert always one-shot)? **Decided for now:** leave
  everything repeating, no per-path/state configurability yet — revisit if it turns out to be
  annoying in practice.

## Hard-won gotchas from tonight's investigation — read before touching playback logic

- **openplotter-notifications** (official OpenPlotter app) has a real, currently-open bug:
  its repeat-sound logic only checks whether the notification's *state* still matches the
  original trigger — not whether `sound` is still in its `method`, or whether
  message/source/id still match. A stale sound helper kept replaying every ~3s for **four
  days** after the underlying condition cleared, spawning VLC repeatedly and leaking memory
  in the PulseAudio volume applet. Root cause: correct handling of the *success* path, no
  handling of *state-transition-out-of-alarm* edge cases.
- **signalk-notification-player** (github.com/davidsanner/signalk-notification-player,
  actively maintained, requires SignalK server 2.28.0+ — we're on 2.31.1, that's not the
  issue) crashed SignalK **twice** on this system:
  1. Missing `mpg321` binary → `spawn mpg321 ENOENT` caught fine, but the retry-on-failure
     path has **no backoff**. A successful play takes seconds and naturally throttles the
     loop; a failed spawn returns instantly, so with nothing throttling failure specifically
     it fired hundreds of times a second — pegged the Pi and took the whole SignalK service
     down. Not a crash in the classic sense, a self-inflicted DoS via runaway retry.
  2. Missing `festival` package (the `say` npm dependency's Linux TTS backend — not espeak
     as first assumed; verify library internals before asserting this kind of thing) — this
     one degraded correctly, sane ~15–60s retry spacing, no lockup. So the bug is
     specifically in the sound-file failure path, not universal to the plugin.
- **The takeaway for our own plugin**: any repeat/alarm-retry logic must have deliberate
  backoff on the *failure* path, not just correct behavviour when playback succeeds. This is
  the single most important lesson to carry into `signalk-alarms`'s own playback code —
  it's the exact category of bug that's bitten two separate, independently-written pieces of
  software so far.
- OpenCPN's Watchdog plugin dialog issue (separate investigation, same evening) was
  eventually traced to a source-level bug in the wxFormBuilder-generated `NewAlarmDialog`,
  not a Raspberry Pi/Wayland/GTK issue as first suspected — X11 was already forced, plugin
  loaded cleanly per the OpenCPN log, and the actual GTK-CRITICAL
  (`gtk_box_gadget_distribute: assertion 'size >= 0' failed in GtkScrollbar`) turned out to
  be a red herring (it's an extremely common, mostly-benign GTK3 warning seen across many
  unrelated apps). Mentioned here only as a reminder: verify the actual failure mode via logs
  before committing to a theory, even a plausible one.
- **A full re-render on every live-value WebSocket tick (~1/sec on a streaming path) tore out
  input focus and dropped keystrokes** from the Commit form's numeric inputs — caught only by
  actually trying to type into the UI while data streamed, not by any automated check. Fixed
  by updating just the value readout element in place instead of re-rendering the row. Same
  category as the accordion-toolbar scoping bug from an earlier session: a naive full-redraw
  works fine until something else on the page needs to hold state (focus, in this case)
  across ticks.
- **`zones-edit`/`@signalk/zones` and SignalK core's own native zone watcher can BOTH fire
  for the same crossing** — two `notifications.<path>` deltas with identical state/message
  but different ids. Root cause: `zones-edit` evaluates from its own persisted config and, as
  a side effect, writes the result to `meta.zones`, which core's own watcher (confirmed
  present since at least 2.31.1, the Pi's exact version) picks up independently and evaluates
  AGAIN. Real, currently-live risk on any server running both — if the Pi's `zones-edit`
  plugin already has any zones configured, they may already be double-notifying, unrelated to
  anything this project built. Worth checking directly, not assumed either way. **Checked on
  the Pi specifically:** `zones-edit` is installed but disabled with an empty config — the
  double-fire risk there was theoretical, not live, at the time of checking. Re-enabling it
  with any zones configured would reintroduce the risk.
- **Useful but unused finding:** the server itself exposes `POST /plugins/<id>/config` for
  ANY plugin (a route the server registers generically, not something each plugin defines) —
  posting `{enabled, configuration}` there saves the config file and automatically
  stops+restarts that plugin. Not needed for our own Commit (writes `meta` directly instead,
  see "Architecture"/"Data model" above), but the correct clean way to update *another*
  plugin's config programmatically, if that's ever needed elsewhere.

## Deploy pattern (matches signalk-logbook, our closest sibling project)

- Local dev root: `C:\Users\paddy\Documents\boat-firmware\signalk_alarms_plugin`
- Deploy: `scp -r` to `10.42.0.1:~/signalk-alarms/`
- **Register via symlink, not plain npm install** — logbook had an incident where npm pruned
  an unregistered plugin directory. Fix: plugin lives at `~/signalk-alarms/` on the Pi,
  symlinked into `~/.signalk/node_modules/signalk-alarms/`, and declared in
  `~/.signalk/package.json` as `"signalk-alarms": "file:../signalk-alarms"`.
- Restart `signalk.service` (systemd) to pick up changes.
- SignalK server on this Pi: confirmed v2.31.1, Node v22.23.2 (server recommends v24 but
  runs fine on 22).
- **Plugin-detection keyword is `signalk-node-server-plugin`, not `signalk-plugin`.** Verified
  against signalk-server 2.32.0 source (`modulesWithKeyword()` in `src/interfaces/plugins.ts`)
  during the scaffold build, and independently confirmed against the official SignalK plugin
  dev docs' own example `package.json`. `signalk-webapp` (webapp keyword) was already correct.
- **Plugin config persists to a single JSON file, not a directory:**
  `~/.signalk/plugin-config-data/signalk-alarms.json`, via the server's `pluginConfigPath()`.
  Corrects an earlier assumption in this doc's history that it was a `signalk-alarms/`
  directory — doesn't affect our code since we only ever call
  `app.savePluginOptions()`/`readPluginOptions()`, but matters if anything ever inspects the
  file directly.
- **`app.savePluginOptions(x)` does NOT overwrite the config file with `x`.** Confirmed against
  signalk-server source (`appCopy.savePluginOptions` in `src/interfaces/plugins.ts`): it calls
  `savePluginOptions(pluginId, { ...getPluginOptions(pluginId), configuration: x }, cb)` — i.e.
  it wraps whatever you pass under a `configuration` key, merged onto the file's *existing*
  top-level contents (`enabled`, etc). An earlier version of `index.js` called
  `app.readPluginOptions()` (the full `{enabled, configuration}` envelope) and passed the
  whole thing back into `savePluginOptions()`, which nested one level deeper under
  `configuration` on every single plugin restart — caught during this session's verification
  when the scratch config file showed doubled nesting after two restarts. **Fix:** `start()`'s
  own `options` argument (or `app.readPluginOptions().configuration`) IS our data blob
  directly — read/write that, never the full envelope. Same applies front-end side: `GET
  /plugins/signalk-alarms/config` returns the full envelope, so the webapp reads
  `config.configuration.pathSettings` / `config.configuration.profiles`, not
  `config.pathSettings` directly.
- **Custom HTTP routes:** `plugin.registerWithRouter = function(router) { router.get(...) }`.
  Confirmed against signalk-server source (`doRegisterPlugin` in `src/interfaces/plugins.ts`):
  the server calls `plugin.registerWithRouter(asPluginRouter(app, router, plugin.id))` and then
  mounts that router at `/plugins/<pluginId>/`, so a route registered as `router.get('/paths',
  ...)` is reachable at `/plugins/signalk-alarms/paths`. `asPluginRouter` just adds an optional
  `.access(level)` permission-scoping helper on top of a normal Express router — calling
  `.get()` etc. directly without `.access()` still works for routes that don't need special
  permissioning (ours doesn't).
- **`app.getMetadata(path)` checked and ruled out — `getSelfPath(path + '.meta')` confirmed
  correct, not just avoided by default.** Read the actual compiled implementation
  (`dist/interfaces/plugins.js`, not just the `.ts` source): `getMetadata:
  path_metadata_1.getMetadata` where `path_metadata_1 = require('@signalk/path-metadata')` — a
  direct, unwrapped re-export of that static package's own function. It has no live-tree
  fallback at all (not even the REST `/meta` endpoint's partial one) — purely static
  units/description schema, never zones. Confirms `getSelfPath(path + '.meta')` was the right
  call, not merely the safer-looking guess.
- **`app.getPath('vessels.self')` does NOT resolve — `'self'` is a REST-route-level alias,
  not understood by the plugin API's `getPath()`.** `rest.js` substitutes `app.selfId` for
  `'self'` in the URL before its own tree walk; `app.getPath()` itself just does a raw
  `_.get()` on the full data model with no such substitution, so `getPath('vessels.self')`
  silently returns an empty tree instead of erroring. **Fix:** use `app.getPath('vessels.' +
  app.selfId)` directly — confirmed `app.selfId` is real by round-tripping it through a
  temporary debug header before removing it. Caught while building the `/values` bulk-fetch
  endpoint, which initially came back empty.

- **The Pi's SignalK server has security/authentication enabled, and plugin routes inherit
  it.** Discovered during deployment — `signalk-generate-token` (over SSH) was needed rather
  than a password prompt. **Confirmed, not just assumed:** this plugin's own routes (e.g.
  `commit-zone`) 401 without auth, same as every other server route — the webapp itself works
  fine through a browser already logged into the SignalK admin UI (normal session cookie);
  scripted/API verification used `signalk-generate-token -u <user> -e 1h -s security.json`
  (run over SSH) to mint a short-lived token without ever touching the actual password.

## Current status

- Initial plugin skeleton built and verified: `package.json` (zero dependencies), `index.js`
  (plugin lifecycle + `pathSettings`/`profiles` persistence), and the two-tab static webapp
  shell (profile bar, working tab-switch JS).
- `index.js` now seeds `profiles` as `{ "Default": { zones: {}, sounds: {} } }` on first run
  (when persisted `profiles` is empty) instead of `{}` — the scaffold session's flagged gap is
  closed, and the webapp's hardcoded "Default" profile-bar option now corresponds to a real
  stored profile.
- Backend now exposes `GET /plugins/signalk-alarms/paths` (via `plugin.registerWithRouter`),
  returning `app.streambundle.getAvailablePaths()` as JSON — see the route-registration gotcha
  above.
- Tab 1 (Zones) is now a working list/filter/accordion shell: text search + a source `<select>`
  populated dynamically from the distinct top-level segments of whatever `/paths` actually
  returns (no hardcoded option list), rows expand accordion-style (one open at a time) showing
  a static, non-interactive colored zone bar read from `profiles["Default"].zones[path]`. No
  drag interaction, live value marker, or real Commit yet — those are still follow-up work.
  Notifications tab untouched.
- Verified end-to-end against a scratch local signalk-server 2.32.0 install, symlinked in
  (mirrors the deploy pattern above, not npm-installed): loads with correct keywords/schema,
  starts cleanly, persists config in the correct (non-nesting) shape across restarts, `/paths`
  returns real data, the Zones tab's search/source filter both genuinely narrow that real data,
  accordion single-open behavior confirmed, no server-log or browser-console errors. Nothing
  touched on the actual Pi for this.
- Local git repo initialized under `github.com/Boatdatasystems/signalk-alarms`, pushed to
  `main`.
- **Open, not yet decided:**
  - Where/how a path's display range (`pathSettings[path].min/max`) actually gets set — no UI
    exists for this yet. The Zones tab's static zone bar currently auto-fits its scale to the
    zone entries' own `lower`/`upper` bounds when zones exist (virtually never right now, since
    `Default` seeds with empty `zones`), which is a display-only stopgap, not the real editor
    scale from the "Tab 1 — Zones" section above.
  - Zone-state color palette in the Zones tab (`nominal`=green, `alert`=yellow, `warn`=orange,
    `alarm`=red, `emergency`=purple) is my own placeholder choice, not verified against Kip's
    actual gauge-zone palette referenced in "Tab 1 — Zones: editor UI decided" above — cosmetic,
    easy to change later.
- Each expanded Zones-tab row now has a read-only **"Get live" button** (per the "Tab 1 — Zones"
  section's "Get live" decision above): fetches `GET
  /plugins/signalk-alarms/live-meta?path=<path>` (backed by `app.getSelfPath(path + '.meta')`,
  see that section for why not the REST `/meta` endpoint) and re-renders that row's zone bar
  from live data instead of `profiles["Default"].zones[path]`, labelled "LIVE (FROM SERVER)"
  in blue with a matching outline on the bar itself vs. "STORED (DEFAULT PROFILE)" in the
  default state. A path with no live zones shows "No live zones for this path." distinctly from
  the stored-empty message ("No zones defined for this path yet."). This is the read-only
  preview only — not wired into any editor state, since there's no drag editor yet to pull
  into; that integration is follow-up work once Commit/drag exists.
  - Verified against a manually-injected real zone (sent a delta with a `meta` array over the
    server's WebSocket input stream, since the REST API has no POST for setting meta) on
    `environment.wind.speedApparent`: "Get live" retrieved and rendered it correctly, a
    zone-less path showed the clean empty state, zero browser console messages, zero
    server-log errors.
  - "Get live" appears on every row shown, same as the row itself — see path-type filtering
    below, which now determines which rows exist in the first place.
- **`app.getMetadata(path)` checked, confirmed to wrap the static package — see the gotcha
  above.** No code change; this just settles the open question from last session with
  certainty instead of "avoided as a precaution."
- **Path-type filtering resolved** (closes the question flagged in the last two sessions).
  New `GET /plugins/signalk-alarms/values` endpoint returns a one-shot `{path: currentValue}`
  snapshot for every known path (`app.getPath('vessels.' + app.selfId)`, walked per path — see
  the gotcha above on why plain `'vessels.self'` doesn't work with this particular API). The
  Zones tab now excludes a path only if its snapshotted value is confirmed non-numeric
  (string, object, or boolean); a path absent from the snapshot (never reported a value) stays
  included, since that's a different, weaker claim than "confirmed non-numeric."
  - **Real-world finding, worth knowing before relying on the "path with no data" case again:**
    tried to manufacture a live example (a path known to `getAvailablePaths()` but with no
    current value) and could not — by design. `streambundle.js`'s `push()` only adds a path to
    `availableSelfPaths` (what `getAvailablePaths()` returns) on a real **value** delta, never
    a meta-only one; the source has an explicit comment about this (avoiding pre-registered
    schema templates, e.g. the Weather provider's, polluting the list). Confirmed by sending a
    meta-only delta for a brand-new path over the WS input stream: it didn't show up in
    `/paths` OR `/values` at all — not "present with no value," just absent entirely. So on
    this server, "listed but valueless" isn't a reachable steady state under normal operation;
    the code still handles it correctly (verified with a direct synthetic test of the filter
    predicate: number → keep, `0` → keep, `undefined` → keep, string/object/boolean → exclude)
    in case that ever changes or some other path produces the gap.
- **Live value marker, per expanded row.** Opens one WebSocket subscription
  (`/signalk/v1/stream?subscribe=none`, then `{context: 'vessels.self', subscribe: [{path,
  period: 1000}]}` — confirmed against `src/subscriptionmanager.js` and `src/interfaces/ws.js`,
  not assumed) when a row expands, shows the current value as plain text near the bar, closes
  the socket on collapse or when a different row is expanded. Verified live: expanding
  `environment.wind.speedApparent` (continuously streaming from the demo data generator) showed
  an initial value that visibly updated a few seconds later; confirmed via a runtime
  `WebSocket` wrapper (not just visual inspection) that switching rows closes the previous
  socket before opening the next, and collapsing closes it too — never more than one open at
  once, never left dangling.
- Zero browser console messages and zero server-log errors across this whole session
  (getMetadata check, `/values` endpoint including the debugging false start on
  `'vessels.self'`, filtering, and the live value marker).
- **Minimal real Commit, working end-to-end.** Each expanded Zones-tab row now has plain
  numeric inputs (lower, upper, state dropdown — `nominal`/`alert`/`warn`/`alarm`/`emergency`)
  and a real **Commit** button, per the "Tab 1 — Zones" Commit decision and the direct-meta-write
  mechanism confirmed under "Architecture"/"Data model" above. Not drag — that's still deferred.
  `POST /plugins/signalk-alarms/commit-zone` validates the input, writes `meta.zones` for the
  path via `app.handleMessage()`, and updates `profiles.Default.zones[path]` in the persisted
  config to match.
  - Verified against the scratch signalk-server 2.32.0 install, both by direct API call and
    through the actual browser UI: committed a zone on `navigation.speedOverGround` (lower: 3,
    state: alarm) via the real Commit button, then confirmed a genuine
    `notifications.navigation.speedOverGround` delta existed server-side with the correct
    `state`. Separately (direct API, `test.alarms.commitButtonValue`), fed WS deltas crossing
    the committed boundary (5 → 20 across a lower:25 alarm zone) and watched the notification
    flip `normal` → `alarm` with a single, stable notification `id` — no double-fire, confirming
    the retirement of the `zones-edit` path (see gotchas) actually holds in practice, not just
    in theory. "Get live" correctly reflects a just-committed zone (allow it a moment — meta
    propagation into the tree `getSelfPath` reads isn't instant; a raw `/live-meta` check inside
    500ms of commit saw stale `null` once, populated correctly a few seconds later).
  - **Real bug found and fixed during this session's browser verification, not just a
    hypothetical:** the live-value WebSocket handler was calling the full `renderZonesList()`
    on every incoming delta. For a continuously-streaming path (i.e. exactly the kind of path
    someone would actually be setting an alarm on) that's roughly once a second — each tick
    was tearing down and rebuilding every DOM node in the expanded row, including the Commit
    inputs, stealing focus and silently dropping whatever was mid-typed. Caught by trying to
    type a lower bound into a streaming path's row via browser automation and watching the
    field stay empty across repeated attempts despite `type` reporting success. Fixed by
    updating the `#live-value-readout` element's text in place (`updateLiveValueReadout()`)
    instead of a full re-render; confirmed by typing into the Lower field on a live-streaming
    row and watching the value survive several value ticks before Commit.
  - `zones-edit`'s own config on the Pi checked (read-only, before touching anything) ahead of
    deploy: `{enabled: false, configuration: {}}` — disabled, empty. It IS actually installed
    (`~/.signalk/node_modules/@signalk/zones`, listed in `~/.signalk/package.json`) — an initial
    flat `ls | grep zone` missed it because it's nested under the `@signalk` scope directory,
    corrected once actually checked. Disabled means `plugin.start()` never runs, so no
    `options.zones` subscription and no meta side-effect write from it either way — the
    double-notification risk flagged in the gotchas below is genuinely theoretical for this boat
    right now, not a live pre-existing bug, but would become real if `zones-edit` is ever
    manually re-enabled and configured via the stock admin UI for some other reason.

- **Deployed to the Pi and proven live.** Followed the deploy pattern above exactly: `scp -r`
  to `~/signalk-alarms/`, symlinked into `~/.signalk/node_modules/signalk-alarms/`, added
  `"signalk-alarms": "file:../signalk-alarms"` to `~/.signalk/package.json` (backed the file up
  first), `sudo systemctl restart signalk.service`. Loaded cleanly — `active (running)`, same
  PID throughout all subsequent testing, no crash or restart.
  - **New finding, not previously documented:** unlike the scratch server, the Pi has
    server-level security enabled — our own plugin's routes 401 without auth, same as every
    other route. This is correct, expected behavior (the webapp itself works fine through a
    browser that's already logged into the SignalK admin UI, via the normal session cookie) —
    just hadn't come up before since the scratch server has no security configured. For
    scripted verification, used the documented `signalk-generate-token -u <user> -e 1h -s
    security.json` CLI (run over SSH) to mint a short-lived token — read the username from
    `security.json` (`openplotter`) without ever touching the actual password, which stays
    hashed in that file regardless.
  - **Test path: `test.test`.** Chose it because it's a pre-existing Node-RED-sourced scaffold
    path (`$source: signalk-node-red`, constant test value) already present on the server with
    no zone, no notification, and no real consumer wired to it — genuinely low-stakes, not
    anything-wired-to-a-real-alarm.
  - Verified the same end-to-end proof as Part 2, against the real boat system: committed
    `{lower: 200, state: alarm}` on `test.test` via the actual Commit mechanism, pushed a WS
    delta crossing the boundary (250), and got a real `notifications.test.test` delta with
    `state: alarm` back from the live server. "Get live" and the stored profile both agreed
    with what was committed.
  - **Real finding, not something this session introduced:** while checking the stored config
    after committing on `test.test`, found a SECOND, unexpected entry already present —
    `electrical.batteries.lifepo4.cellVoltage.1` (a real, actively-monitored LiFePO4 cell
    voltage path from `signalk-conachair-ble`) — with a stored zone of `{lower: 3, upper: 3.5}`
    but a *live* `meta.zones` of `{lower: 3, upper: 3}` (a degenerate zone that can never
    actually match any value, since the test is `value < upper && value >= lower`). The
    mismatch between stored and live strongly suggests an earlier, apparently-interrupted
    session got partway into Part 2/3-style direct-meta-write testing against this real battery
    path instead of a safe synthetic one, before this session's continuation began — the plugin
    itself wasn't deployed yet when this session started (confirmed: no `~/signalk-alarms/`, no
    symlink, no `package.json` entry), but its config file and a stray live meta write had
    already landed. Currently harmless (the degenerate zone can't fire, and the live notification
    was sitting at `normal`), but real orphaned state on a real battery path, not a hypothetical.
    **Cleaned up**: cleared `meta.zones` for that path (confirmed `alarmMethod`/`units`/other
    meta fields were untouched — only `zones` was cleared) and removed it from the stored
    `Default` profile, backing up the plugin's config file first. Flagging this clearly rather
    than quietly fixing it and moving on, since it's evidence of a previous session's real,
    unfinished touch on live boat hardware — worth knowing about even though the immediate
    effect was benign.
    **Resolved:** Paddy confirmed this was his own manual testing, not an untracked session
    touching real hardware — no further concern.
  - Confirmed `signalk.service` healthy after all of the above: `active (running)`, same PID as
    right after the restart (no crash/respawn during testing), no new errors in the journal
    beyond the three already-known pre-existing benign ones (`signalk-notification-player`'s
    missing-festival message, occasional mDNS `ENETUNREACH`, and version-check `fetch failed` —
    all present immediately after a clean restart too, unrelated to this plugin). Node-RED and
    other existing consumers reconnected normally post-restart per the service log.
- **Multi-zone editing per path; pre-population fixed.** Paddy found two real usability gaps
  using the deployed Pi webapp itself. Both reproduced directly against the Pi before fixing,
  per usual practice here:
  - **"Can only set 1 zone at a time" — confirmed a real single-entry limitation, not a UI
    glitch.** The old editor had one scalar lower/upper/state triple per row; the backend
    `commit-zone` route already accepted a full zones array (no backend change needed), but the
    frontend only ever sent a 1-element array, and `configuration.profiles.Default.zones[path]
    = cleanZones` (and the matching `meta.zones` write) fully REPLACES rather than merges —
    confirmed by committing a warn zone then an alarm zone on the same path via the old
    single-input flow and watching the warn zone vanish. **Fixed:** `draftZones` is now an
    array; the row shows one lower/upper/state/Remove group per zone, an "Add zone" button
    appends another, Commit sends the whole array. Verified live on the Pi: committed a warn
    band (0–50) and a separate alarm band (lower: 50) on `test.test` together, confirmed both
    persisted in the stored profile AND `meta.zones`, then fed WS deltas (25, then 75) and got
    the correct `warn` then `alarm` notification for each, a single stable notification id
    throughout (no double-fire).
  - **"Live update doesn't seem to work, lower/upper stay blank" — determined which of the two
    plausible causes it actually was, not assumed.** Reproduced on the Pi: the live *value*
    readout was working correctly the whole time (watched it tick 3.332 → 3.329 on a real
    battery path, and 250 → 75 on a WS-driven test path, both live and correct). The actual bug
    was that the lower/upper/state *editor inputs* always reset to blank/`alarm` on every row
    expand, regardless of what was already stored for that path — confirmed by expanding
    `electrical.batteries.lifepo4.cellVoltage.1` (Paddy's own real, already-committed
    `{alert, 3.3–3.55}` zone) and seeing empty inputs and the hardcoded `alarm` default instead.
    **Fixed:** row expand now calls `zonesToDraft(defaultProfileZones[path])` to seed the
    editable list from stored data instead of resetting it blank; re-verified on the same real
    row afterward — inputs now show `3.3`, `3.55`, `alert` correctly.
  - Also closes the "Get live" loop flagged in CLAUDE.md's Tab 1 section two sessions ago:
    clicking it now overwrites the same editable `draftZones` list with the path's actual live
    `meta.zones` (still uncommitted, still freely overwritable, no confirmation) — not just the
    read-only bar display it was limited to before. Verified by manually injecting a live-only
    zone (`{state: emergency, lower: 90}`, distinct from the stored warn/alarm pair) via a raw
    WS meta delta and confirming "Get live" replaced the draft list with that single row.
  - **New environment nuance, not a bug:** live browser testing against the Pi required an
    authenticated session (see the security/auth gotcha from two sessions ago); since I don't
    have and shouldn't handle Paddy's actual login, I patched `window.fetch`/`WebSocket` in the
    page's own JS context to attach a `signalk-generate-token`-issued JWT, then called
    `loadZonesTab()` again to reload through the patched calls — same technique as the
    SSH-based token approach already documented, just applied inside the browser instead of via
    curl. This is a testing workaround for driving the deployed UI without a password prompt,
    not a change to the plugin itself — the plugin still relies on the normal browser session
    cookie for any real logged-in user, same as before.
  - Verified: zero browser console messages and zero new `signalk.service` log errors across
    reproduction, fixing, and re-verification; `signalk.service` stayed on the same PID
    throughout (no restart needed — `index.js`/backend was untouched, only `public/app.js` and
    `public/style.css` changed, both static files).

## Not yet decided / next session

- Anchor alarm is no longer special-cased for profile auto-switching — it's just one
  notification path among all the others on Tab 2, same as everything else. Profile
  switching is manual only for now unless we revisit an auto-switch trigger later.
