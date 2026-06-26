# AGENTS.md — CodeCubicle

## What this is

A VS Code extension that visualizes GitHub Copilot agent and subagent activity as pixel art office workers in a tiny animated office. Activity is detected by parsing VS Code's Copilot output channels.

## Tech stack

- **Language:** TypeScript (strict)
- **Platform:** VS Code Extension API (`vscode` module)
- **Rendering:** HTML Canvas in a Webview panel (pixel art sprites, no external rendering libs)
- **Build:** esbuild (bundle extension + webview separately)
- **Package manager:** npm

## Project structure

```
src/
  extension.ts        — activation, command registration, output channel listener
  panel.ts            — webview panel lifecycle, message passing, HTML generation
  parser.ts           — parses Copilot output channel text into activity events
  officeState.ts      — event→worker state machine (station pool, idle/done timers); vscode-free, unit-tested
  types.ts            — shared types (AgentEvent, WorkerState, etc.)
webview/
  renderer.ts         — pixel art canvas loop, sprite-based drawing
  sprites.ts          — sprite sheet config (frame layouts, animation maps, tile defs)
  sprites/            — PNG sprite sheets (copied from source packs)
```

## Key commands

```bash
npm install                  # install deps
npm run compile              # esbuild bundle (extension + webview)
npm run watch                # esbuild watch mode
npm run lint                 # eslint
npm test                     # vitest unit tests (parser + officeState)
npm run package              # vsce package to .vsix
```

Press **F5** in VS Code to launch the Extension Development Host for manual testing.
Run **CodeCubicle: Run Simulation** from the Command Palette to drive scripted agent activity through the full pipeline without live Copilot.

## Architecture notes

- The extension and webview are **separate JS contexts**. Communicate via `postMessage` / `onDidReceiveMessage`. Keep the message protocol typed in `src/types.ts`.
- **Layout ownership:** the renderer owns all office coordinates. `WorkerState` carries a `station` index (0–3); the extension never computes pixel positions. The renderer maps `station` → `(x, y)` via `stationToPos()`. Station N is always the same desk + character (0=Adam, 1=Alex, 2=Amelia, 3=Bob). The name pill shows the character's personal name (not the parser's role name); the role (main/subagent) is conveyed by the badge color only.
- **Walk in/out:** the renderer keeps its own animated view model (`renderWorkers`, keyed by station) reconciled against each `state-sync`. New workers enter from an off-screen door and walk to their desk (`entering` → `present`); workers dropped from the synced list walk back out (`leaving`) before being removed. Stations 0–1 use the left entrance (`DOOR_LEFT_X`), stations 2–3 the right (`DOOR_RIGHT_X`), via `doorXFor()`; facing follows travel direction. Side-facing walk uses `walkLeft`/`walkRight` animations (run sheet cols 12–17 / 0–5). When no workers are present the office is empty (no demo characters) and shows the "Waiting for agent activity…" banner.
- **Event pipeline:** `parser.ts` (raw text → `AgentEvent`) → `officeState.ts` (`OfficeState`, the event→worker state machine) → `panel.syncState()` → webview. `OfficeState` is `vscode`-free and unit-tested (`src/officeState.test.ts`). It assigns/frees stations and removes a worker after a `done` celebration (`CELEBRATE_MS`) or prolonged inactivity (`REMOVE_AFTER_IDLE_MS`, 30s). Workers are NOT flipped to an "asleep/idle" animation between log lines: they retain their last activity animation (typing/thinking + bubble) until a new event or removal, since the agent is usually still working during the gap. Timing constants are exported from `officeState.ts`.
- **Testing the pipeline without live Copilot:** run the `CodeCubicle: Run Simulation` command (`codeCubicle.simulate`). It drives a scripted sequence of synthetic events through the real `OfficeState` pipeline. All handled events (sim and real) are logged to the **"CodeCubicle" output channel** for debugging.
- Output channel parsing (`src/parser.ts`) subscribes to document changes on `output://` scheme URIs matching known Copilot channel names (real channel: **"GitHub Copilot Chat"**). The exact channel names/format can change across Copilot versions, and `onDidChangeTextDocument` only fires while that channel is open in the Output panel (use the "CodeCubicle" log / capture mode to re-capture if Copilot changes format).
- **Parser calibration:** patterns are calibrated against a real `GitHub Copilot Chat.log` (Copilot Chat 0.53.1, VS Code 1.125.1). Lines are `TIMESTAMP [level] [Component] message`. Markers mapped to events: `ccreq:… | markdown` → `spawn` (Agent, turn start); `ccreq:… | success | <model> | <ms>ms | [<endpoint>]` → activity attributed by endpoint (`[panel/editAgent]`→Agent `working`, `[copilotLanguageModelWrapper]`→Helper `tool_call`, `[progressMessages]`→Progress `working`); `[messagesAPI] message N returned` → Agent `working`; `[ToolCallingLoop] Stop hook result: shouldContinue=false` → Agent `done` (turn end). Workers are identified by stable names (Agent/Helper/Progress), each owning one desk.
- **Terminal channel (second source):** the parser also subscribes to the VS Code **"Terminal"** output channel, where every `RunInTerminalTool` line is the Copilot agent running a shell command (calibrated against a real `Terminal.log`). Markers → a dedicated **Terminal** worker (subagent, 4th desk): `ToolTerminalCreator#createTerminal: Waiting <n>ms for shell integration` → `spawn` (only this createTerminal line; the `PromptInputModel` one is ignored to avoid double spawns); `RunInTerminalTool: Using \`<strategy>\` execute strategy for command \`<CMD>\`` → `tool_call` with the command text as `detail` (multi-line commands truncate to the first line); `RunInTerminalTool: Finished … exitCode \`N\`, … error \`<err>\`` → `working` with `detail` `✓ exit 0` (exit 0 + `undefined` error) or `✗ exit N`. `parseLine` is channel-agnostic (chat + terminal patterns coexist; non-matching lines return null). The four stable workers are now Agent/Helper/Progress/Terminal (= MAX_STATIONS 4).
- **Claude Code channel (third source):** the parser also recognizes the **Claude Code** extension's own output channel (`WATCHED_CHANNEL_NAMES` includes "Claude Code" and "Claude VSCode"; calibrated against a real `Claude VSCode.log`, Claude Code 2.1.x). It is a different agent system than Copilot but reuses the same four desks. It supports **multi-agent orchestration**: the main agent and each delegated subagent are first-class workers, so the worker mapping deliberately keeps tool dispatches off their own desks (spreading them Copilot-style would keep desks permanently warm and starve the subagents). Markers:
  - `Spawning Claude with SDK query function …` → Agent `spawn` (the bare `Loading config cache by launching Claude (no channel)…` line is ignored).
  - `Hook SubagentStart:<name> (SubagentStart)` → a subagent `spawn`, **keyed by `<name>`** (e.g. `tdd-backend-csharp`) so each distinct subagent claims its own desk/character. (`SubagentStop` carries no name, so subagents leave via the normal idle-removal timer, not an explicit `done`.)
  - `[API REQUEST] /v1/messages … source=<src>` → `working`, attributed by `classifyClaudeSource`: `source=sdk` → the main Agent; `source=agent:custom:<name>` → that subagent. Other sources (`growthbook`, `generate_session_title`, …) are intentionally unmatched. This is what animates a subagent between its tool calls.
  - `[Stall] tool_dispatch_start/end tool=<T>` → `claudeWorkerForTool`: shell (`Bash`/`PowerShell`) → the **Terminal** desk (`tool_call`); **every other tool** → the main **Agent** as `working`. End lines add `detail` `✓ <T>` / `✗ <T>`. ⚠️ The `[Stall]` line has **no agent attribution**, so a subagent's `Read`/`Edit` shows on the Agent desk, not the subagent's — attributing it correctly would need stateful parsing (tracking the last `source=`), which would break the pure, line-by-line `parseLine` contract.
  - `Interrupted Claude for requestId:` / `Closing Claude on channel:` → Agent `done`.

  Because these patterns are disjoint from the Copilot/Terminal ones, all three sources coexist in `parseLine`. With only `MAX_STATIONS` 4 desks, main + Terminal + 3 concurrent subagents can't all be shown at once; OfficeState drops the overflow and idle-removal recycles desks as subagents (which run largely sequentially) finish.
- **Claude Code hooks (fourth source — terminal-mode CLI):** the output-channel sources above only see the Claude Code *extension*. When the standalone `claude` CLI runs in the integrated terminal it writes to no output channel, so a separate path handles it: hooks configured in `.claude/settings.json` run `.codecubicle/capture.cjs`, which appends each hook payload (one JSON line) to `.codecubicle/activity.jsonl` (gitignored). `extension.ts` `subscribeToHookCapture` tails that file via a `FileSystemWatcher`, tracking a per-file byte offset, skipping the existing backlog on first sight, consuming only up to the last newline (so a mid-append partial line waits), and resetting on truncation. Appended text goes through `parseHookChunk` → `parseHookPayload` (in `parser.ts`, **not** `parseLine` — these are JSON objects, not log lines). Mapping (calibrated against a real `.codecubicle/activity.jsonl`, Claude Code 2.1.x):
  - `SessionStart` → Agent `spawn`. `SessionEnd` → Agent `done` (the celebrate-and-leave farewell).
  - ⚠️ **`Stop` is intentionally ignored (returns null).** `Stop` fires at the **end of every turn**, not session end — mapping it to `done` made the main Agent celebrate and walk out after *each* response, leaving the office empty between turns (observed: 13 Stops in one ~150-event session). Idle-removal (`REMOVE_AFTER_IDLE_MS`) handles real departure; `SessionEnd` is the explicit farewell. (The capture `.claude/settings.json` therefore hooks `SessionEnd`, not `Stop`.)
  - `SubagentStart` / `SubagentStop` → a subagent `spawn` / `done`, **keyed by `agent_type`** (e.g. `Explore`); `agent_id` disambiguates instances. ⚠️ The real field is `agent_type`, **not** `subagent_name`/`subagent_type` as some docs claim.
  - `PreToolUse` / `PostToolUse` → routed by `hookActivityForTool` (`PostToolUse` adds `✓ <tool>` / `✗ <tool>`; failure only flagged on an unambiguous `is_error`/`error` marker, else assumed success):
    - **Subagent** (`agent_type` present) → stays *one coherent worker* at its own desk for every tool (reads/shell → `tool_call`/thinking, edits → `working`/typing). It is **not** spread across desks — a subagent is conceptually one "person."
    - **Main agent** (no `agent_type`) → *spread across role-desks by tool category* so a solo terminal session lights up the office instead of collapsing onto one desk: shell (`Bash`/`PowerShell`) → **Terminal** (`tool_call`); reads/searches (`Read`/`Grep`/`Glob`/`LS`/`NotebookRead`) → **Reader** (`tool_call`); edits and everything else → **Agent** (`working`). Verified on real capture: all four desks (Agent/Terminal/Reader/subagent) light up, vs. only Agent+Terminal before.
  - **Attribution win:** a *subagent's* `PreToolUse`/`PostToolUse` payload carries `agent_id` + `agent_type`; the *main agent's* does not. That discriminator is what lets the main agent be spread by category while each subagent stays a single coherent worker — the very attribution the `[Stall]` channel lines lacked (see the ⚠️ in the third source).
  - Each line in the file is a `{ receivedAt, payload }` envelope from `capture.cjs`; `parseHookChunk` unwraps it (a bare payload is also accepted) and skips blank/partial/non-JSON lines. Events we don't visualize (`Notification`, `PreCompact`, …) return null.
- **Activity bubbles:** `WorkerState` carries an optional `activity` kind (`edit`/`read`/`search`/`shell`/`web`/`think`) alongside `animation`. `animation` is the body pose; `activity` picks the speech-bubble glyph (`drawActivityBubble`). Lifecycle poses (walking/celebrating/idle) override it with their own icon. `activity` is derived **once** in `parser.ts` (`toolActivity(tool)`, distinct from desk routing so read≠search) and flows through `AgentEvent` → `OfficeState` (preserved across events that lack one, e.g. spawns) → `WorkerState`. Don't re-derive it from tool names in the webview.
- Canvas rendering runs at ~8 FPS via `requestAnimationFrame` with frame throttling.
- Webview CSP allows `img-src` from the webview's own `cspSource` plus `blob:` and `data:`.
- The panel sets `data-sprite-uri` on `<body>` so the renderer can resolve sprite sheet paths via VS Code's webview resource URI scheme.

## Sprite assets

Two source packs live at the repo root (not bundled in .vsix):

| Pack | License | Used for |
|------|---------|----------|
| `Modern tiles_Free/` | Non-commercial only | Office interiors + 4 characters |
| `SuperRetroWorld_CharacterPack_Full/` | Commercial OK with credit | Extra characters (not yet integrated) |

**Working sprites** are copied into `webview/sprites/` for the webview to load:

- **Characters** (16x16 frames): `{adam,alex,amelia,bob}_{idle,run,sit,phone}.png`
  - idle/run/sit sheets: 384×32 px = 24 frames/row × 2 rows
  - phone sheets: 144×32 px = 9 frames/row × 2 rows
  - Row layout: 4 directions × 6 frames. Verified by frame extraction: **front (camera-facing) = cols 18-23**, back = cols 6-11, sides = cols 0-5 / 12-17. The `phone` sheet is entirely front-facing (use col 0).
- **Interiors** (`interiors.png`): 256×1424 px, 16-col × 89-row tile atlas
- **Room builder** (`room_builder.png`): 272×368 px, walls/floors/ceilings

Sprite config is defined in `webview/sprites.ts` — frame positions, animation mappings, and tile references. If new sprites are added, update that file.

## Conventions

- No default exports. Use named exports everywhere.
- Barrel files (`index.ts`) only at package boundaries, not per-folder.
- Pixel art assets: 16×16 base tile size. All sprites aligned to grid.
- Message types between extension and webview: discriminated union (`{ type: string; payload: ... }`) in `src/types.ts`. Webview duplicates the types locally (cannot import cross-context).
- Canvas CSS scales 2× for display (`width: 512px` on a 256px canvas) with `image-rendering: pixelated`.

## Testing

- Unit tests: Vitest. Run `npm test`.
- Extension integration tests: `@vscode/test-electron`. Run `npm run test:integration`.

## Gotchas

- `vscode` module is **not bundled** — marked external in `esbuild.mjs`.
- Webview scripts cannot import from `src/` directly; they are bundled separately with their own entrypoint (`webview/renderer.ts`).
- `localResourceRoots` in `panel.ts` must include both `dist/webview` (JS) and `webview/sprites` (images).
- The Copilot extension has no public API for activity events. Parsing output channels is brittle; isolate all parsing logic in `src/parser.ts` so it can be updated when Copilot changes format.
- Sprite sheets have no JSON metadata — frame layout is encoded in `webview/sprites.ts` by manual measurement. If sprite packs are updated, re-verify dimensions with `file *.png`.
