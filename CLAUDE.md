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

## SUPERSEDED — see "Two-state model: Server vs. Profile" below

<!-- old sync-philosophy section retired here; kept as a marker only, content removed to
     avoid contradicting the two-state model -->

## Two-state model: Server vs. Profile — decided (supersedes the earlier draft-based design)

Two states only, not three — the earlier "draft" layer (unsaved, in-browser-only edits) is
retired entirely. **Implemented and verified — see "Current status".**
- **Server** — live `meta.zones`, the real boat, evaluated by SignalK core.
- **Profile** — our own persisted config (`profiles.Default.zones`). Auto-saves continuously
  as you edit (add/remove/change a zone in a row) — debounced (600ms) for the lower/upper text
  inputs, immediate for discrete actions (state dropdown, Remove) — not a write per keystroke.
  No separate unsaved-draft state to lose or discard — the existing Save/Save-as
  profile-snapshot mechanism (see "App structure") is meant to be the only "undo point", not a
  per-row cancel.

Four actions, each a one-directional move between exactly two of {Server, Profile, the
on-screen row}:
- **Editing a row** → auto-saves into Profile. Immediate (debounced), no explicit save step.
- **Get live** (per-row) → Server → Profile, one path. Reads live `meta.zones`, writes it
  straight into Profile (and the visible row) — never touches Server.
- **Commit** (per-row) → Profile → Server, one path. Profile already auto-saves, so Commit's
  job is just "push Profile's current value for this path to Server" — it does still also
  re-persist Profile as a side effect of reusing `/commit-zone`, but that's a harmless no-op
  re-save of data that's already there, not something the UI needs to think about separately.
- **Refresh** (global) → reads Server for every path in one bulk request, compares each
  against Profile, marks any row where they differ (`≠ server` badge, amber) on its
  thumbnail — including collapsed rows, since the point is a whole-list-at-a-glance scan. Pure
  read — writes nothing anywhere.
- **Send to server** (global) → Profile → Server, for every path Refresh identified as
  differing. Confirms first with a count only ("Send N changed paths to the server" — no full
  path list needed, a custom in-page confirm/cancel rather than a native `confirm()` dialog).
  Re-checks the diff at send time rather than trusting a possibly-stale earlier Refresh click.

Get Live/Send-to-server are the same direction (Server→Profile) at row-scope vs. all-scope;
Commit/Send-to-server are the same direction (Profile→Server) at row-scope vs. all-scope.
Refresh is the only pure-read action, safe to run anytime.

**Per-row sync-status display — decided, implemented and verified (see "Current status").** The
expanded row's main bar always shows Profile data — no more toggling between "live preview" and
"stored" at that widget, since Get Live now writes into Profile rather than just previewing it.
The expanded row shows a clear, always-visible sync-status indicator instead (matches server /
differs from server / not yet checked), reusing the same `mismatchedPaths` state Refresh already
computes — shown on BOTH the collapsed thumbnail and the expanded row, not just collapsed. If
Refresh has never been run, that's its own distinct "not yet checked" state, not a false
"matches". Same underlying bug fix as the expanded-row-bar-staleness issue below: both traced to
the same now-removed `liveZones`-preferring render branch.

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
- **"Get live" button, per row:** see "Two-state model: Server vs. Profile" above for the
  current, authoritative description (Server → Profile, one path, no confirmation needed).
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

## Copy/paste zones between paths — decided, implemented and verified (see "Current status")

Replaces the wildcard-expansion idea below for the common case (several similar paths that
want identical zones, e.g. `electrical.batteries.lifepo4.cellVoltage.1/.2/.3/.4`): a **Copy**
button on the expanded row's editor copies that row's current Profile zones (whatever
`editableZones` currently holds) into a single shared, in-memory clipboard slot — not the OS
clipboard, just an in-page JS variable, since there's no need for this to survive a reload or
be pasted anywhere outside this app. A **Paste** button (disabled/hidden until something's
been copied this session) on any other expanded row applies that copied array into ITS
`editableZones`, replacing whatever was there, then goes through the exact same auto-save path
as any other edit — no new persistence mechanism needed. Paste doesn't auto-Commit — pasting
only changes Profile, same as typing; Commit/Send-to-server still push it live same as any
other edit.

## Zone boundary value labels on the bar — decided, implemented and verified (see "Current status")

The colored zone bar should show the actual numeric lower/upper value at each zone boundary,
positioned at the same proportional x-location the color segments already use for their
auto-fit scale — not just color, so the set values are visible without opening the editor.
Whether this fits legibly on the collapsed thumbnail as well as the expanded main bar, or only
the latter given the thumbnail's small size, is left to implementation judgment — flag if the
thumbnail turns out too cramped rather than forcing it. **Resolved: main bar only** — see
"Current status" for the reasoning.

## Wildcard path groups — decided, but DEPRIORITIZED in favor of copy/paste (see above)

Never built. A simpler, lower-effort alternative was chosen instead for the actual recurring
need (e.g. several identical battery cell zones) — manual copy/paste of a row's zones to
another row, see "Copy/paste zones between paths" above — without pattern-matching machinery.
Kept below for reference in case genuinely dynamic path sets become a real need later, but not
scheduled.

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
- **Remove-all-zones validation bug fixed; Get live now persists to stored profile.** Two
  independent fixes, not entangled at the feature level — kept separate in the writeup below —
  but see the shared-helper note at the end, which genuinely does touch both.
  - **Remove-all-zones:** `/commit-zone` used to reject `zones: []` outright ("must be a
    non-empty array"). Fixed by only requiring `zones` to be an array — the per-zone
    bound/state validation loop still runs, but over whatever's actually in the (possibly
    empty) list, so it can't block a genuinely empty submission. An empty commit now writes
    `meta.zones: []` (core's native watcher treats an empty test list as "everything falls in
    the implicit normal gap" — confirmed against its source last session, functionally no
    alarm) and, in the stored profile, **deletes** the path's key entirely rather than storing
    a stale `[]` — confirmed by checking `GET /config` afterward and seeing no trace of the
    path, not just that the commit didn't error.
  - **Get live persists to stored profile:** per the revised "Get live" decision above. New
    backend route `POST /persist-zone` (body `{path, zones}`) writes straight into
    `profiles.Default.zones[path]`, never touches `meta` or calls `app.handleMessage`. The
    frontend's Get Live handler now does two sequential calls: existing `GET /live-meta` (read,
    unchanged), then this new route with the result (persist). Kept as two small
    single-responsibility endpoints rather than one combined route, since `GET /live-meta` was
    already independently verified across three prior sessions and combining would have
    duplicated that logic for no real benefit.
  - **Shared-helper question, answered directly (asked to flag this explicitly):** no shared
    persist helper existed before this session — the profile-merge-and-save logic was inline
    inside `/commit-zone` only. Extracted it into `persistZonesForPath(path, zones, cb)`, now
    called by both `/commit-zone`'s persist step and the new `/persist-zone`. Also extracted
    `normalizeZones()` (shape cleanup only, no rejection) for the same reason. This is also
    **where the two fixes turned out more entangled than the prompt's framing suggested**: Fix
    1's core behavior change — an empty array means "delete the key," not "store `[]`" — lives
    in `persistZonesForPath`, which Fix 2's new route depends on unconditionally. When Get Live
    finds a path with genuinely no live zones (`meta.zones: null`), it persists `[]`, which
    hits the exact same delete-key branch. Didn't design it that way on purpose going in; it
    fell out of extracting the shared helper and turned out to be the correct behavior for both
    callers, not a coincidence worth re-litigating, but flagging as asked rather than presenting
    the two fixes as fully independent when one now quietly depends on the other's semantics.
  - Verified against the actual deployed Pi (not the scratch server): Fix 1 confirmed twice —
    directly via API (commit a zone, commit `[]`, confirm `meta.zones: []` and no stored key)
    and through the real UI (Remove button down to zero rows, Commit, same result). Fix 2
    confirmed via manual live-meta injection (same WS technique as prior sessions): "Get live"
    on a path with an injected live-only zone updated the stored profile (checked `GET /config`
    directly, not just the browser), collapsing and re-expanding the row afterward showed the
    synced data without touching Commit, and clicking "Get live" again with an unsaved draft
    edit sitting in the inputs correctly discarded that draft in favor of newly-injected live
    data — while a second, unrelated path's stored data and draft were unaffected throughout.
  - One real testing hiccup, not a product bug: mid-session, a stale element reference from the
    `find` browser tool (reused across two re-renders) caused a click meant for `test.test`'s
    Commit button to land on `test.test2`'s instead — caught immediately by checking server
    state directly rather than trusting the UI, and worth remembering for future sessions:
    re-screenshot and re-locate elements after every render that could have changed the DOM,
    don't reuse refs across renders.
  - Zero browser console messages, zero new `signalk.service` log errors; `signalk.service`
    required one restart (backend `index.js` changed this session, unlike the previous
    session's frontend-only fixes) and came back healthy immediately, same as every prior
    restart in this project.
- **Two-state model implemented: draft layer retired, Profile auto-saves, global Refresh and
  Send-to-server added.** Two independent pieces of work, kept genuinely separate except where
  noted below.
  - **Part 1 — auto-saving Profile.** `draftZones`/`zonesToDraft`/`emptyDraftZone` renamed to
    `editableZones`/`zonesToRows`/`emptyZoneRow` and all "draft" framing removed from
    comments — there's no draft concept left, `editableZones` is just the on-screen editable
    view of Profile for whichever row is expanded. Editing (lower/upper text inputs) debounces
    600ms before calling `POST /persist-zone` (the exact route built last session for "Get
    live"'s persist step, reused as-is — no new backend route needed for this part); the state
    dropdown and Remove save immediately, no debounce, since they're discrete actions with no
    "pause in typing" to wait for. **Debounce choice, stated explicitly as asked:** 600ms —
    long enough that a normal typing burst (e.g. "123") collapses into one save, short enough
    that switching rows or hitting Commit right after typing doesn't leave an edit stranded for
    long. The debounce closure captures `path` and the specific `editableZones` array instance
    at schedule time rather than reading the mutable module-level variable at fire time — matters
    because switching rows before a pending timer fires reassigns that variable, and reading it
    live from inside the timeout would silently apply a stale row's edits to whatever path
    happens to be expanded when the timer goes off.
  - Get Live: confirmed still Server → Profile via the same `/persist-zone` call from last
    session, only variable names/comments changed. Commit: confirmed Profile → Server only,
    reusing `/commit-zone` unchanged — it does still also re-persist Profile as a side effect
    of that route, which is a harmless no-op re-save under the auto-save model, not a "save"
    Commit itself needs to perform.
  - **Part 2/3 — global Refresh (read-only) and Send-to-server (write, confirmed).** New
    backend route `GET /live-zones` bulk-fetches every known path's live `meta.zones` in one
    request, reusing the exact same tree-walk `/values` already does (not `getSelfPath()` once
    per path) — extended the existing bulk-endpoint *pattern*, not the `/values` route itself,
    to avoid touching an endpoint other code already depends on for path-type filtering.
    **Comparison approach, stated explicitly as asked:** order-independent deep equality — each
    zone reduces to a `state|lower|upper|message` key, two arrays match if they contain the
    same multiset of keys regardless of order. Handles duplicate identical zone entries
    correctly (both sides need the same count of that key), though that's an unlikely real
    case, not something hit in testing.
  - **Real edge case the comparison surfaced, not obvious going in:** `zoneKey` treats
    `message` as part of a zone's identity, but the editable-rows conversion functions had
    never round-tripped `message` at all (there's no UI for it, never asked for one). Under the
    old draft-based design that only mattered if someone clicked Commit; under auto-save, *any*
    edit — typing in a different zone's bound, changing a state dropdown — now re-saves the
    whole row on every change, so a message set by something other than this UI would vanish on
    the very next keystroke, and Refresh would then show that path as permanently "differs from
    server" with no way to clear it through the UI. Fixed by carrying `message` through
    `zonesToRows`/`editableRowsToZones` untouched even with no input for it — flagged here since
    it's exactly the kind of "didn't cleanly reuse existing helpers" divergence the prompt asked
    about, though the divergence was in the frontend's row-conversion functions, not in
    `persistZonesForPath()`/`normalizeZones()` themselves (both reused unchanged).
  - Send-to-server's confirmation is a custom in-page Confirm/Cancel pair, not a native
    `confirm()` — chosen partly for UI consistency (nothing else in this app uses native
    dialogs) and partly because a real native dialog would have blocked the browser-automation
    tools used to verify it. Zero mismatches: shows "No changes to send." instead of the
    confirm step, rather than disabling the button pre-emptively off a possibly-stale count.
  - **Entanglement between the two parts, flagged as asked rather than silently merged:** none
    at the route/helper level — Part 1 only touches `/persist-zone` (already existing), Part
    2/3 only add `/live-zones` and frontend comparison logic, `persistZonesForPath()`/
    `normalizeZones()` untouched by both. The one real link is conceptual: Send-to-server and
    Commit both remove a path from `mismatchedPaths` on success (so a just-resolved row's badge
    disappears immediately rather than waiting for the next Refresh), which means Part 2/3's
    badge state is quietly informed by Part 1/Commit's actions — mentioned since it wasn't
    asked for outright, it was a small UX addition built on top of already having the
    information from a single-path operation's own result.
  - Verified end-to-end, scratch server first then the Pi: typed a lower-bound edit, watched
    "Saved" appear, confirmed via `GET /config` (not just the browser) that it persisted, then
    did a full page reload and confirmed the row showed the edited value on re-expand without
    touching Commit. Manually created a live/Profile mismatch (WS meta injection on a path
    Profile had nothing for), clicked Refresh, confirmed only that path got the `≠ server`
    badge (collapsed and expanded) while others didn't. Clicked Send to server, confirmed the
    count matched, confirmed, then re-ran Refresh and confirmed zero differences remained.
    Confirmed the zero-mismatch case shows "No changes to send." without a confirm step.
  - **On the Pi specifically:** found `electrical.batteries.lifepo4.cellVoltage.1` (Paddy's own
    real, in-progress battery zone editing) and two other real paths
    (`electrical.other.esp32.vcc`, `propulsion.head.temperature`) genuinely mismatched against
    Server when Refresh first ran — real pre-existing drift, not something this session
    introduced. Deliberately did NOT include them in any Send-to-server push, since that would
    mean deciding on Paddy's behalf that his current Profile values should overwrite whatever's
    actually alarming on his boat right now. Used Get Live on each instead (pure read from
    Server, writes nothing to it) to bring Profile back in sync with reality first, then ran
    the actual Send-to-server test against an isolated `test.test` mismatch only. Cleaned up
    `test.test` back to empty afterward; left Paddy's three real paths exactly as their own
    live Server state already had them.
  - Zero browser console messages, zero new `signalk.service` log errors on either server;
    `signalk.service` required one restart on the Pi (backend `index.js` changed) and came back
    healthy immediately, same PID throughout the rest of testing.
- **Fixed: expanded row's main bar staleness after Commit; added the per-row sync-status
  indicator.** Two fixes asked for, but reproduction traced them to the same root cause —
  stated explicitly since the prompt asked directly whether they were related.
  - **Reproduced Fix 1 before touching code, as asked.** Committing on a row that had never had
    "Get live" clicked already refreshed the main bar correctly — no bug in that path. The bug
    only appeared after "Get live" had been clicked at least once on that row: it left `liveZones`
    (a per-row snapshot the bar preferred over Profile whenever set) non-undefined, and Commit's
    success handler never reset it, so the bar stayed frozen on the old "Get live" snapshot —
    confirmed by watching the thumbnail turn correctly while the main bar stayed stuck red, then
    watching a second "Get live" click "fix" it by re-populating that same stale variable.
  - **Fix 2 (per-row sync-status indicator) retires that entire `liveZones` branch** — the bar
    now unconditionally renders `defaultProfileZones[path]`, so Fix 1 falls out of Fix 2
    automatically rather than needing its own separate patch. `buildSyncStatusBadge(path)` /
    `fillSyncStatusBadge()` / `updateSyncStatusBadges()` reuse `mismatchedPaths` (the exact Set
    Refresh already computes) for a 3-state badge (matches/differs/not yet checked) shown via one
    shared `data-sync-path` attribute on both the thumbnail and the expanded row, updated in
    place (not a full re-render) so autosave firing mid-typing can't steal focus.
  - **Leftover old labeling found and removed, as asked to check for:** the toolbar's
    "LIVE (FROM SERVER)" / "Profile (Default)" text label (a holdover from the pre-two-state-model
    live-preview design) was still present and still driven by the same stale `liveZones` check —
    removed entirely, replaced by the sync-status badge in the same toolbar slot.
  - **Real bug found while wiring the indicator up, not something introduced here:**
    `saveProfileNow` (autosave) was deleting the just-edited path from `mismatchedPaths` on
    success — copied from Get Live/Commit's own success handlers, where that's correct (they
    genuinely sync Profile to Server), but backwards for autosave, which only ever writes
    Profile and never touches Server. Left uncaught, it would have silently shown a
    just-edited, never-pushed path as "matches" instead of "differs". Fixed by adding to
    `mismatchedPaths` instead of deleting from it (only when a Set already exists, i.e. Refresh
    has run at least once).
  - Verified end-to-end, scratch server first then the Pi: reproduced the exact stale-bar
    behavior against the pre-fix code (both the working "never touched Get Live" case and the
    broken "Get Live then Commit" case) before changing anything. Post-fix: committed on an
    expanded row and watched the main bar update immediately; loaded the page fresh and
    confirmed "Not yet checked" on every row, not a false "matches"; ran Refresh and watched a
    matching and a WS-injected mismatched row badge correctly on both thumbnail and expanded
    view, live, mid-typing, without a full re-render; resolved the mismatch via Send-to-server
    and watched the badge flip to "matches" automatically, no second manual Refresh needed.
  - No backend changes this session (frontend/CSS only) — no `signalk.service` restart needed
    on either server, just a page reload. Zero browser console messages, zero new log errors on
    both.
- **Copy/paste zones between paths; numeric boundary labels on the zone bar.** Two independent
  additions, no backend changes — both pure frontend, reusing existing routes/mechanisms.
  - **Copy/paste:** `copiedZones` is a single shared, in-memory JS variable (not the OS
    clipboard, not persisted — explicitly scoped to the current page load). Copy stores the
    expanded row's current `editableZones`; Paste (disabled until something's been copied)
    replaces the target row's `editableZones` with a clone of the copied array, then runs
    through the exact same `flushPendingAutosave()` + `saveProfileNow()` path any other
    discrete edit uses — no special-casing needed for Paste to correctly mark the pasted path
    as "differs from server," since that's already `saveProfileNow`'s job for every caller.
    Paste deliberately does not Commit — Profile-only, same as typing.
  - **Boundary labels: main/full bar only, not the thumbnail** — implementation judgment, as
    the prompt explicitly allowed. The thumbnail is 140×10px, not enough room for legible
    numeric text even for a single zone's two labels, let alone a multi-zone path; the main bar
    (28px tall, full row width) has room. A `.zone-bar-labels` row sits under the bar, one
    label per real (explicitly-set) zone edge — not per the `zLower`/`zUpper` fallback values
    used for unbounded-edge rendering — positioned at the same x% the color segment uses.
    Verified live with both a 1-zone path (single "100"/"200" pair) and a 2-zone contiguous
    path (warn 0–20, alarm 20–30): the shared boundary at 20 renders as one clean, non-
    overlapping "20", confirming no de-duplication logic was needed.
  - **Real bug found and fixed, NOT specific to copy/paste despite being caught while testing
    it:** `saveProfileNow` is async; Paste's (and Remove's, and the state-dropdown's) click
    handler called `renderZonesList()` synchronously right after triggering the save, which ran
    before the save's promise resolved and updated `defaultProfileZones[path]` — so the
    resulting render showed the bar stuck on stale data (e.g. "No zones defined for this path
    yet." right after a successful paste) even though the input fields (driven by local
    `editableZones`, mutated synchronously) were already correct, and even though the save
    itself had genuinely succeeded server-side (confirmed via a direct `GET /config` check
    during debugging — a rendering/timing bug, not a data-loss bug). **Fixed** by tagging bar
    wrapper elements with `data-bar-path` and adding an `updateZoneBars(path)` in-place
    refresher (mirroring the existing `updateSyncStatusBadges`/`updateAutosaveIndicator`
    pattern), called from inside `saveProfileNow`'s success handler — this fixes the bug for
    every caller of `saveProfileNow`, not just Paste, since it's the same async-render race any
    discrete non-debounced edit action was exposed to.
  - Verified end-to-end, scratch server first then the Pi (`test.test` → copy →
    `test.test2` → paste, both times using paths with no real consumer): pasted zones appeared
    correctly in the target row's inputs, bar, and thumbnail immediately, confirmed persisted
    via a direct `GET /config` call (not just the browser) both times, and Refresh correctly
    showed both the copy-source and paste-target paths as "≠ server" (neither had been
    Committed). On the Pi specifically, used `test.test`/`test.test2` — pre-existing,
    unconsumed scaffold paths, not any of Paddy's real battery/other in-progress zones — and
    reset both back to empty via `/persist-zone` afterward; neither was ever Committed during
    this session, so no live `meta.zones` write touched the Pi at all, nothing to clean up
    there. No backend changes this session, so no `signalk.service` restart needed on either
    server — confirmed same PID throughout. Zero browser console messages (checked on a fresh
    page load, not just after the test interactions) and zero new server-log errors on both
    scratch and the Pi.

## Not yet decided / next session

- Anchor alarm is no longer special-cased for profile auto-switching — it's just one
  notification path among all the others on Tab 2, same as everything else. Profile
  switching is manual only for now unless we revisit an auto-switch trigger later.
- **Live alarm-state "instant glance" dots on thumbnails** — a separate idea from the
  "Two-state model"'s Refresh/Send-to-server (notification *state*, e.g. reading
  `notifications.<path>` live, rather than zone *bounds* matching/mismatching). The two-state
  model itself is now built (see "Current status"), so this is ripe to revisit, but still not
  decided whether it's wanted alongside or instead of the `≠ server` badge — deliberately not
  decided this session either, per its own explicit constraints.
