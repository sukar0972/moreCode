# AGENTS.md

# First Priorities

## Task Completion Requirements

- When code is modified, `vp check` and `vp run typecheck` must pass before considering the task completed.
  - If native mobile code is modified, `vp run lint:mobile` must also pass.
- Do not run these verification commands for review-only, analysis-only, or other tasks that do not modify code.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.
- When you change the production web bundle, server static serving, or startup auth flow, run the UI smoke test after building:
  - `vp run build`
  - `vp run test:browser:install` (first time, or when Playwright browsers are missing; root alias for `@t3tools/web`)
  - `vp run ui-smoke`
- The UI smoke test boots the built server via `apps/server/dist/bin.mjs serve` (production `dist/client/` bundle), authenticates with the startup pairing token from headless server output, opens the bundled UI in headless Chromium, and asserts the chat shell loads without the root error view, WebSocket failure text, or uncaught page errors.
- The smoke runner clears `VITE_DEV_SERVER_URL` and `VITE_WS_URL` in the server subprocess environment so the test exercises the production bundle. If either variable is set in your shell or `.env.local`, the server may proxy to the Vite dev app instead of `dist/client`, and the smoke test will hang or fail.
- Smoke helpers live in `scripts/lib/ui-smoke.ts`; the Playwright entrypoint is `apps/web/scripts/ui-smoke.ts`. CI runs this in the `UI Smoke` workflow job after `vp run build`.

## Project Snapshot

more Code is a minimal web GUI for using coding agents like Codex and Claude. It is intended to allow you to do work in a remote environment with agents and linux in mind.

# Secondary Priorities

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
