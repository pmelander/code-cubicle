# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A detailed companion document, [AGENTS.md](AGENTS.md), covers sprite-sheet measurements, parser calibration markers, and conventions in depth. Read it before touching `webview/sprites.ts` or `src/parser.ts`.

## What this is

A VS Code extension (`code-cubicle`) that visualizes coding-agent activity as pixel-art office workers in an animated Webview. Two agent systems are supported side by side — **GitHub Copilot** and the **Claude Code** extension — and activity is inferred by parsing their VS Code **output channels**. Neither tool exposes a public activity API, so all parsing is heuristic and version-fragile.

## Commands

```bash
npm run compile           # esbuild bundle (extension + webview)
npm run watch             # esbuild watch mode
npm run lint              # eslint over src/ and webview/
npm test                  # vitest unit tests (parser + officeState)
npm run test:watch        # vitest watch
npm run test:integration  # @vscode/test-electron integration tests
npm run package           # vsce package → .vsix
```

Run a single unit test: `npx vitest run src/parser.test.ts` (or `-t "<test name>"` to filter).

## Versioning

Claude Code is responsible for bumping `version` in [package.json](package.json) (semver `MAJOR.MINOR.PATCH`) as part of any build/package that changes shipped behavior, sized to the work performed — do this proactively, without being asked:

- **MAJOR** — breaking changes: an incompatible change to the cross-context message protocol (`src/types.ts`), or removing/redefining a command or established behavior.
- **MINOR** — new backward-compatible capability: a new parser source, command, animation, or worker mapping.
- **PATCH** — backward-compatible fixes: bug fixes, parser recalibration, timing/constant tweaks.

Pure doc/test/tooling changes need no bump. When a change spans levels, take the highest. When unsure, prefer the smaller bump and say so. Bump once per coherent unit of work, not per file edit.

## Running it

Press **F5** in VS Code to launch the Extension Development Host. Command Palette commands:

- **CodeCubicle: Open Office** (`codeCubicle.open`) — open the Webview panel (the main entry point).
- **CodeCubicle: Reset Office** (`codeCubicle.reset`) — clear all workers and pending timers.
- **CodeCubicle: Run Simulation** (`codeCubicle.simulate`) — drive scripted synthetic events (`SIMULATION_SCRIPT` in `extension.ts`) through the real pipeline without live agent output.
- **CodeCubicle: Toggle Output Capture** (`codeCubicle.toggleCapture`) — echo raw output-channel lines into the "CodeCubicle" channel for recalibrating the parser.

**Operational gotcha:** the extension reads other extensions' output by watching `output`-scheme documents, and `onDidChangeTextDocument` only fires for a channel **while it is open/visible in the Output panel**. If nothing animates with a live agent, the source channel (e.g. "GitHub Copilot Chat", "Claude Code") isn't open. Use the simulation command to test the pipeline independently of this.

## Architecture

Two separate JS contexts, bundled separately by `esbuild.mjs` and communicating only via `postMessage` / `onDidReceiveMessage`:

- **Extension** (`src/`, CJS, Node host, `vscode` marked external/not bundled) → `dist/extension.js`
- **Webview** (`webview/`, IIFE, browser context) → `dist/webview/renderer.js`

The shared message protocol and event/state types live in [src/types.ts](src/types.ts). The webview **cannot import from `src/`** — it duplicates these types locally.

### Event pipeline

```
output channel text ───────────┐
                                ├→ parser.ts (parseChunk / parseHookChunk → AgentEvent[])
~/.codecubicle/sessions/        │       → officeState.ts (OfficeState: event→worker state machine)
  <sessionKey(cwd)>.jsonl  ─────┘       → panel.syncState() → webview state-sync → renderer.ts
```

There are two ingestion paths into the parser: VS Code **output channels** (`subscribeToOutputChannels`) and a polled **hook-capture file** (`subscribeToHookCapture`). Both feed the same `OfficeState`. The hook file is **per-workspace**: a window only tails `~/.codecubicle/sessions/<sessionKey(folder)>.jsonl` for its own folders, so multiple VS Code windows each show only their own activity ([src/sessionKey.ts](src/sessionKey.ts) is the shared key, duplicated in `capture.cjs`).

- **[src/parser.ts](src/parser.ts)** — channel-agnostic line parsing. Subscribes (via `extension.ts`) to `output`-scheme documents matching `WATCHED_CHANNEL_NAMES`. Two agent systems are supported and their markers coexist (non-matching lines return null): **GitHub Copilot** (the "GitHub Copilot Chat" + "Terminal" channels) and the **Claude Code** extension (its "Claude Code" channel — `Spawning Claude…` → Agent spawn; `Hook SubagentStart:<name>` → a subagent spawn keyed by `<name>`; `[API REQUEST] … source=sdk|agent:custom:<name>` → the main Agent or that subagent `working`; `[Stall] tool_dispatch_start/end tool=<T>` → shell→Terminal, all other tools→Agent, via `claudeWorkerForTool`; `Interrupted/Closing Claude` → done). The Claude mapping keeps the main agent + named subagents as first-class workers rather than spreading tools across desks, so subagents stay visible within the 4-desk office. **Isolate all parsing here** — `parseLine` is a pure function of a single line; it's the part that breaks when either tool changes log format. Patterns are calibrated against real captured logs at the repo root (`GitHub Copilot Chat.log`, `Terminal.log`, `Claude VSCode.log`).

  A third Claude source covers the **terminal-mode `claude` CLI**, which writes to no output channel: `parseHookPayload` / `parseHookChunk` map Claude Code **hook** payloads onto the same workers. A subagent's hook payload carries `agent_id`/`agent_type` (`agent_type` present ⟹ subagent, absent ⟹ main Agent) — closing the attribution gap noted in AGENTS.md. Mapping (`hookActivityForTool`): a **subagent** stays one coherent worker at its own desk (keyed by `agent_type`) for every tool; the **main agent's** work is *spread across role-desks by tool category* so a solo session fills the office — edits → Agent (typing), reads/searches → Reader (thinking), shell → Terminal (thinking), everything else → Agent. `Stop` is intentionally ignored (it fires every turn; mapping it to `done` made the agent walk out between turns) — idle-removal handles departure and `SessionEnd` is the real farewell. Capture is configured **globally** in `~/.claude/settings.json` to run `~/.codecubicle/capture.cjs` (source of truth: [.codecubicle/capture.cjs](.codecubicle/capture.cjs)), which routes each payload to `~/.codecubicle/sessions/<sessionKey(cwd)>.jsonl` so `claude` lights up the office in *any* project while staying scoped to the window whose workspace matches that `cwd`. `extension.ts` polls the matching file(s). Verified against a real capture (Claude Code 2.1.x) — see `parser.test.ts`.
- **[src/officeState.ts](src/officeState.ts)** — `vscode`-free and unit-tested. Owns four stable workers (Agent/Helper/Progress/Terminal = `MAX_STATIONS` 4), assigns/frees `station` indices, and removes a worker after a `done` celebration (`CELEBRATE_MS`) or prolonged inactivity (`REMOVE_AFTER_IDLE_MS`, 60s). Timing constants are exported from here. Keep it `vscode`-free so it stays testable.
- **[src/panel.ts](src/panel.ts)** — Webview panel lifecycle, HTML generation, CSP, and resource URIs. `localResourceRoots` must include both `dist/webview` (JS) and `webview/sprites` (images).
- **[webview/renderer.ts](webview/renderer.ts)** — canvas render loop (~8 FPS), owns **all** office coordinates. `WorkerState` carries a `station` index (geometry) plus `animation` (body pose) and an optional `activity` kind (`edit`/`read`/`search`/`shell`/`web`/`think`); the renderer maps station → `(x, y)`, handles walk-in/walk-out against each `state-sync`, and `drawActivityBubble` picks the bubble glyph from `activity` (falling back to the animation icon for walk-in/celebrate/idle). The extension never computes pixel positions. `activity` is derived once in the parser (`toolActivity`) — keep that the single source of truth rather than re-deriving from tool names in the webview.

### Layout/ownership invariant

The extension assigns abstract `station` numbers; the renderer owns geometry. Station N is always the same desk + character (0=Adam, 1=Alex, 2=Amelia, 3=Bob). Don't push pixel coordinates across the message boundary.

## Conventions

- Named exports only — no default exports.
- Barrel `index.ts` files only at package boundaries.
- Cross-context messages are discriminated unions (`{ type; payload }`) defined in `src/types.ts`.
- Pixel art is 16×16 base, grid-aligned; canvas displays at 2× with `image-rendering: pixelated`. Sprite frame layouts are encoded by manual measurement in `webview/sprites.ts` (no JSON metadata) — re-verify dimensions if sprite packs change.
