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
- **`@signalk/zones`** does the actual threshold evaluation (watches a path's zone meta,
  emits `notifications.<path>` deltas at alert/warn/alarm/emergency). Confirmed this is a
  real running plugin, not just a config editor — it does the watching itself.
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
- **Zone entries deliberately reuse `@signalk/zones`' own field names** (`lower`, `upper`,
  `state`, `message`) so a Commit can hand them straight to `@signalk/zones`' meta format with
  no translation step. We do NOT use `@signalk/zones`' own `method` field for sound — our
  plugin subscribes to `notifications.*` broadly and looks up `sounds[path][state]` itself
  (per the earlier scope decision), so `zones` and `sounds` are linked only by path + state at
  runtime, not by any direct reference between the two stores.

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
  path's edited zone bounds into the live `@signalk/zones` meta (and the active profile's
  in-memory state) — lets you drag both edges around and iterate freely before anything
  touches the real, currently-running alarm system.
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
- **Not yet verified:** the exact server-side mechanism for reading a path's current live
  `meta.zones` — candidates are a plugin-API method (`app.getMetadata()` or similar) versus
  the REST meta endpoint (`/signalk/v1/api/vessels/self/<path>/meta`). Verify against the
  actual signalk-server source before implementing, same discipline as the keyword/config-path
  checks from the scaffold session — don't assume from training data.
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
  - The Zones tab's path list excludes `notifications.*` paths entirely (those belong to Tab 2)
    and excludes the single empty-string path `getAvailablePaths()` returns (appears to be a
    root/context artifact, not a real leaf path) — but does NOT otherwise filter by value type,
    so string- or object-valued paths (e.g. `navigation.position`) currently show up in the
    Zones list even though they can't plausibly host a numeric zone. `getAvailablePaths()`
    returns path strings only, no type info, and adding per-path value lookups to determine
    type felt out of scope for a static list/filter shell — revisit when Commit/real zone
    writing exists and a bad-path-type error actually matters.
  - Zone-state color palette in the Zones tab (`nominal`=green, `alert`=yellow, `warn`=orange,
    `alarm`=red, `emergency`=purple) is my own placeholder choice, not verified against Kip's
    actual gauge-zone palette referenced in "Tab 1 — Zones: editor UI decided" above — cosmetic,
    easy to change later.
- Anchor alarm is no longer special-cased for profile auto-switching — it's just one
  notification path among all the others on Tab 2, same as everything else. Profile
  switching is manual only for now unless we revisit an auto-switch trigger later.
