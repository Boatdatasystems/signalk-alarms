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
  alarm-time with `paplay --volume=65536` (see "Current status" — matches `pi-deck-tools`'
  own proven-working critical-alert player on this hardware; the original plan here was
  `aplay`, superseded once that precedent was found — deliberately avoiding
  mpg321/festival/cvlc either way, see gotchas below).
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

## Data model — decided, implemented

```
{
  activeProfile: "Default",
  pathSettings: { [path]: { min, max, contiguous: boolean } },
  profiles: {
    "Default": {
      zones:         { [path]: [{ state, lower, upper, message }, ...] },
      notifications: { ["notifications." + path]: { [state]: { sound, mode, intervalSeconds } } },
      defaultSound:  "default.wav" | null
    },
    "Coastal": { zones: {...}, notifications: {...}, defaultSound: "..." }
  }
}
```

- **`pathSettings`** — outside any profile, same regardless of which one is active. Per-path
  display/edit config (track scale, coupled-vs-decoupled), decided earlier to NOT vary by
  profile. Not actually populated by any UI yet — see "Not yet decided" below.
- **`profiles`** — named and switchable, each a full snapshot spanning both tabs. A path can
  be in `zones`, `notifications`, both, or neither (the anchor alarm is `notifications`-only,
  since it has no zone this plugin manages). `notifications` keys are always the FULL
  `notifications.*` path (e.g. `notifications.navigation.anchor`), matching what a real
  delta's path actually is — enforced on save both client- and server-side (see "Tab 2" below).
  `activeProfile` names whichever profile is currently staged/live in the UI; every
  autosave/Commit/notification-save reads and writes through it rather than a hardcoded name.
- **This supersedes an earlier, short-lived split** where `notifications`/`defaultSound` lived
  flat at the top level instead of per-profile, and `sounds: {}` sat as a dead, never-used
  stub inside each profile. A one-time, idempotent migration in `index.js` (`migrateConfig`,
  runs on every `plugin.start()`) moves any legacy top-level data into `profiles.Default`,
  drops the `sounds` stub, and fixes any `notifications` key that's missing its
  `notifications.` prefix (a real dead-config bug this surfaced — such a key can never match a
  live delta).
- Commit writes `meta.zones` directly via `app.putSelfPath()` (see the gotchas below for why
  not `app.handleMessage()`) from our own plugin backend — no cross-plugin config writes
  needed at all. Confirmed empirically (installed signalk-server 2.32.0 AND the Pi's exact
  2.31.1 separately, ran both live, forced a real boundary crossing over a WS delta): core's
  own native `Zones` class watches `meta.zones` on every path and fires real notifications on
  crossing, independent of `zones-edit`/`@signalk/zones` entirely. `zones-edit` is NOT used by
  this plugin at all. Zone entries still reuse `@signalk/zones`' own field names (`lower`,
  `upper`, `state`, `message`) purely because that's the shape core's native watcher expects in
  `meta.zones` — not because we're writing through that plugin.
- We do NOT use `@signalk/zones`' own `method` field for sound — our plugin subscribes to
  `notifications.*` broadly and looks up `notifications[path][state]` itself, so zones and
  sound bindings are linked only by path + state at runtime, not by any direct reference
  between the two stores.

## SUPERSEDED — see "Two-state model: Server vs. Profile" below

<!-- old sync-philosophy section retired here; kept as a marker only, content removed to
     avoid contradicting the two-state model -->

## Two-state model: Server vs. Profile — decided (supersedes the earlier draft-based design)

Two states only, not three — the earlier "draft" layer (unsaved, in-browser-only edits) is
retired entirely. **Implemented and verified — see "Current status".**
- **Server** — live `meta.zones`, the real boat, evaluated by SignalK core.
- **Profile** — our own persisted config (`profiles[activeProfile].zones`). Auto-saves
  continuously as you edit (add/remove/change a zone in a row) — debounced (600ms) for the
  lower/upper text inputs, immediate for discrete actions (state dropdown, Remove) — not a
  write per keystroke. No separate unsaved-draft state to lose or discard — the Save/Save-as
  profile-snapshot mechanism (see "Profiles" below) is meant to be the only "undo point", not a
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
  Before that count-confirm, an additional guard checks whether the currently-staged
  {zones, notifications, defaultSound} deep-equals ANY saved profile (not just the active
  one — a Merge, see "Profiles" below, can produce a combination matching neither source it
  came from). If it matches none, offers "Save and send" / "Send without saving" / Cancel
  first, so an unsaved edit can't get pushed to Server without at least being asked about.
  Doesn't change what gets pushed (still zones only, via the same `putSelfPath` commit path) —
  purely a confirmation step in front of the existing flow.

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
  path's edited zone bounds live — writes `meta.zones` directly via `app.putSelfPath()` (see
  "Current status" for why not `app.handleMessage()`); SignalK core's own native zone watcher
  does the actual evaluation, see "Data model" above — lets you drag both edges around and
  iterate freely before anything touches the real, currently-running alarm system.
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

Everything below is shipped, deployed to the Pi, and verified live (both via direct API/WS
testing and, for the frontend, actual browser interaction) unless marked otherwise. This
section is a snapshot of what's true now — see `SESSION-LOG.md` for the chronological
"what happened, in what order" trail and `git log` for exact history.

**Zones tab**
- Path list with text search + source filter (top-level SignalK namespace, derived from the
  path string). Excludes `notifications.*` (that's Tab 2) and any path whose current value is
  confirmed non-numeric; a path that's never reported a value stays included.
- Each row expands accordion-style (one open at a time) to a colored zone bar, a live current-
  value marker on that bar (a thin white/dark-outlined line, shown only when the current value
  falls within the bar's own range — omitted, not clamped, otherwise), numeric boundary labels
  under the bar, and an editable list of zones (lower/upper/state/Remove per zone, "Add zone").
  Both the bar's boundary labels and the editable list are sorted by lower bound ascending at
  render time only — storage order is untouched, so this has no effect on the Refresh/Send-to-
  server diff logic below.
- **Live unit-conversion display**, via one shared `formatWithUnit(rawValue, units)`: K→°C,
  rad→°, ratio→%, m/s→kt (e.g. `283 (10.0°C)`). Units come from the path's own `meta.units`
  (bulk-fetched once at tab load via `GET /units`, not re-fetched per row). Reused for the
  live-typing hint next to lower/upper inputs, the boundary labels, and the Current Value
  readout — the last of those additionally rounds the raw value to 2 decimals first (a live
  streaming value can carry long floating-point noise; boundary labels/typing hints show
  exactly what's typed/stored, unrounded). Units this doesn't recognize (V, A, m/s already
  handled, etc.) render unconverted.
- **Server vs. Profile, exactly as decided above** — auto-saving edits, per-row Get Live/
  Commit, global Refresh/Send-to-server with per-row sync-status badges (matches/differs/not
  yet checked), Copy/Paste zones between paths. All implemented and verified per the "Two-state
  model" section above.
- Commit writes `meta.zones` via `app.putSelfPath()` (not `app.handleMessage()` — see the
  gotchas below for why that distinction matters; an earlier version used the latter and the
  write silently never survived a restart, since `handleMessage()` only publishes into the
  live data model and never touches disk).

**Notifications tab**
- Flat, sortable list of path+state→sound bindings (path alphabetically, then state in
  severity order `alert < warn < alarm < emergency` — reads more sensibly than alphabetical for
  states specifically). Sound picker is populated from an actual directory listing
  (`GET /sounds`, backed by `~/.signalk/plugin-config-data/signalk-alarms/sounds/*.wav`), never
  freehand text, with a manual "Refresh list" affordance since sound files are added by hand.
  Mode is once/repeat, with an interval field only shown for repeat.
- Path input **auto-prefixes `notifications.`** on blur if the user doesn't type it, and both
  `POST /notification-config` and `POST /profiles/:name` reject a notifications key missing
  that prefix server-side too — closes a real dead-config bug found during a discovery pass (a
  saved key without the prefix can never match a live delta's actual path, so it silently never
  fires; the profiles migration below fixes any pre-existing instance of this on startup).
- Backend subscribes broadly to `notifications.*` via `app.subscriptionmanager` (bootstraps
  from the delta cache on subscribe, so an alarm already active when the plugin starts is
  picked up immediately, not missed until its next state change). Plays via
  `paplay --volume=65536` (matches `pi-deck-tools`' own critical-alert player, confirmed as the
  proven-working mechanism on this hardware — not `aplay`), through a single serial queue (so
  simultaneous alarms don't overlap) with a 30s per-play timeout so a hung `paplay` can't jam
  future alarms. An unconfigured path/state falls back to `defaultSound`, played once — nothing
  goes unnoticed by design. A duplicate delta at an already-alarming state (no real transition)
  does not restart playback or reset an in-progress repeat interval.

**Profiles**
- A profile is `{ zones, notifications, defaultSound }` — a full snapshot spanning both tabs.
  `activeProfile` names whichever one is currently staged/live; every read/write in both tabs
  goes through it, not a hardcoded name (see "Data model" above for the full shape and the
  migration that got existing installs here).
- Profile bar: dropdown + Save / Save as... / Delete, all wired (previously non-functional
  stubs). Save overwrites the active profile with current staged state; Save as... prompts
  inline (a text input + Save/Cancel appended to the bar, matching the same pattern as the
  Load prompt below — not `window.prompt`) with a live "this will overwrite an existing
  profile" warning if the typed name collides, Enter/Save submits, Escape/Cancel dismisses,
  empty/whitespace-only is silently ignored.
- **Load** (picking a different profile in the dropdown): a real 3-choice inline prompt —
  Replace everything / Merge (only overwrite paths present in the loaded profile, leave
  everything else untouched) / Cancel (reverts the dropdown, changes nothing). Either way this
  only updates staged state and switches `activeProfile` — never touches SignalK directly.
- **Delete**: rejects deleting the active profile or the last remaining one (backend-enforced,
  frontend shows the reason inline rather than silently doing nothing); deleting a non-active
  profile asks for an inline confirm first, same non-native-dialog pattern as everything else
  here.
- **Send to server unsaved-changes guard**: before the existing mismatch-count confirm, checks
  whether currently-staged state deep-equals ANY saved profile (not just the active one — a
  Merge can produce a combination matching neither source). If it matches none: "Save and
  send" / "Send without saving" / Cancel. Doesn't change what actually gets pushed.

**Known gotcha from building the delete/Load UI, worth remembering if this area gets touched
again:** the profile `<select>` gets fully rebuilt on every `renderProfileBar()` call,
including the one that opens the Load prompt itself — a first pass had that rebuild always
re-select `activeProfile`, which meant a delete button reading `select.value` could never
actually see a just-picked, not-yet-loaded (non-active) name. Fixed by having the rebuild
prefer the pending Load target when one exists. Found only by actually driving the UI in a
browser, not from code review.

**Deployment**: symlinked at `~/signalk-alarms/` on the Pi per the deploy pattern below,
`signalk.service` restarts cleanly on every backend change, zero browser console errors or new
server-log errors across all of the above. `zones-edit`/`@signalk/zones` confirmed installed
but disabled with empty config — the double-notification risk in the gotchas below is
theoretical for this boat, not live.

**Open, cosmetic, not blocking anything:**
- `pathSettings[path].min/max` (a path's editor display range) has no UI yet — the zone bar
  still auto-fits to the zones' own bounds, a display-only stopgap, not the real per-path scale
  from "Tab 1 — Zones" above.
- The zone-state color palette (`nominal`=green, `alert`=yellow, `warn`=orange, `alarm`=red,
  `emergency`=purple) is a placeholder, not verified against Kip's actual gauge-zone palette.

## Not yet decided / next session

- Profile switching is manual only (via the profile bar) — no auto-switch trigger (e.g. on
  entering/leaving an anchorage) exists or is planned yet.
- **Live alarm-state "instant glance" dots on thumbnails** — reading `notifications.<path>`
  live (notification *state*) rather than zone *bounds* matching/mismatching, as a Zones-tab
  thumbnail affordance. Not decided whether this is wanted alongside or instead of the
  `≠ server` sync-status badge.
- `pathSettings[path].min/max` UI (see above) — genuinely just not built yet, not a design
  question.
