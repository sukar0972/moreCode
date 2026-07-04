# Upstream catch-up Phase 3 skip/defer audit

Phase 3 is the safe catch-up lane before Phase 4. The goal is to port changes
that fit the web app without accidentally importing desktop-only, native-only,
or browser-simulation behavior from upstream `pingdotgg/t3code`.

## Phase 3 PRs

- Phase 3F: safe web runtime fixes — PR #16.
- Phase 3G: chat UI polish — PR #17.
- Phase 3H: chat scroll anchoring — PR #18.
- Phase 3I: provider/account updates — PR #19.
- Phase 3J: this skip/defer audit.

Phase 3J is audit-only. It records the boundary before Phase 4 rather than
porting another feature slice.

## Safe-to-port heuristic for Phase 3

Phase 3 PRs should be limited to changes that satisfy all of the following:

1. They run in the web app without Electron, local browser control, or native
   mobile APIs.
2. They reuse existing moreCode provider/session/cloud boundaries instead of
   importing upstream desktop-only surfaces.
3. They do not bundle lockfile/tooling churn unless the PR is dedicated to that
   dependency/tooling update.
4. They include focused verification, plus a Grok Composer 2.5 second opinion.

## Explicitly deferred before Phase 4

### Desktop, Electron, and WSL-only runtime

These should not be ported directly into the web app. Revisit only if Phase 4
adds a web-compatible abstraction or a server-side equivalent.

- `a9b1190a1`
- `51ea084c8`
- `6d35a87c5`
- `31dfe3596`

Reason: these changes depend on desktop process/runtime assumptions that are
not available in the hosted web UI.

### Browser simulation and preview automation

These are intentionally held for Phase 4+ design work. Upstream's desktop app
can drive local browser surfaces in ways our web app cannot safely assume.

- `44fb34ad5`
- `ffae5410e`
- `e9ed70c5b`
- `a4964b3b3`
- Most preview automation, browser recording, and desktop preview structured
  error commits unless they are adapted behind a web-safe provider boundary.

Reason: the user explicitly called out upstream browser simulation as
incompatible with our web app. Porting this directly risks broken UI, false
capabilities, or unsafe assumptions about local browser control.

Reviewer rule: if an upstream commit touches browser drivers, preview recorder
flows, local browser surface control, desktop preview structured errors, or
Electron-mediated browser automation, treat it as deferred unless the PR also
introduces a web-specific design that does not claim local browser control.

Suggested grep/check terms for catch-up reviews:

- `browser simulation`
- `preview recorder`
- `desktopBridge`
- `Electron`
- `getCurrentWindow`
- `playwright`
- `recording`
- `browser surface`

### Mobile/native-only work

Do not include these in web catch-up PRs unless a later mobile phase is opened.

- `4ac094fef`
- `5cda81562`
- `32d17d3db`
- `6245c547c`
- `37ac970e2`
- Mobile/native portions of `22f021ed6`

Reason: these affect React Native/mobile shells, native navigation, or mobile
scroll infrastructure. Web PRs should not carry native changes just to satisfy
upstream parity.

Hybrid-commit rule: if a commit contains both web-safe and mobile/native hunks,
split it manually. Port only the web-safe hunks and mention the skipped native
paths in the PR body.

### Release-only or repository-maintenance-only work

- `244821236`

Reason: release bookkeeping does not change web product behavior and should not
be mixed into feature catch-up PRs.

Use the same rule for version-bump, changelog-only, and release-note-only
commits unless a release process PR is explicitly opened.

### Dependency/tooling churn deferred from Phase 3I

- `6672a1d21` — Clerk package and lockfile bump.
- `a7e43b228` — Vite Plus bundled dev opt-in.

Reason: Phase 3I was limited to product-facing account/provider changes. These
tooling/dependency updates should be evaluated in a dedicated dependency PR so
test failures or lockfile churn are easier to isolate.

## Reviewer checklist for remaining catch-up PRs

Before merging a catch-up PR that claims Phase 3 or Phase 4 readiness:

1. Compare the PR's upstream source commits against the deferred SHA list above.
2. Check for equivalent cherry-picked diffs even if the SHA changed because of a
   rebase or manual port.
3. Grep changed files for Electron, React Native, browser-driver, and preview
   automation terms.
4. Confirm shared-package changes do not smuggle in desktop/browser-simulation
   assumptions through `packages/*`.
5. Confirm lockfile-only or toolchain-only changes are isolated in a dependency
   PR unless explicitly required by the feature.
6. Require the PR body to list any partially ported upstream commits and the
   paths intentionally skipped.

## Phase 4 entry criteria

Phase 4 can start once:

1. Phase 3F, 3G, 3H, and 3I are reviewed and either merged or accepted as the
   queued catch-up series.
2. Any Phase 4 browser/preview work starts from a web-specific design instead
   of directly assuming upstream desktop browser simulation.
3. Mobile/native commits are handled in a separate mobile phase or explicitly
   left out of web parity.
4. Deferred dependency/tooling commits are either handled in their own PR or
   intentionally kept out of the Phase 4 base.
