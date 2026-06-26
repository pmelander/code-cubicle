import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CubiclePanel } from "./panel";
import { WATCHED_CHANNEL_NAMES, parseChunk, parseHookChunk } from "./parser";
import { OfficeState } from "./officeState";
import { sessionKey } from "./sessionKey";
import type { AgentEvent } from "./types";

let panel: CubiclePanel | undefined;
let office: OfficeState;
let log: vscode.OutputChannel;
let simTimers: ReturnType<typeof setTimeout>[] = [];
let captureMode = false;
const seenChannels = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("CodeCubicle");
  context.subscriptions.push(log);

  office = new OfficeState((workers) => panel?.syncState(workers));
  context.subscriptions.push({ dispose: () => office.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("codeCubicle.open", () => {
      panel = CubiclePanel.createOrShow(context.extensionUri);
      panel.syncState(office.list());
    }),
    vscode.commands.registerCommand("codeCubicle.reset", () => {
      clearSimulation();
      office.reset();
    }),
    vscode.commands.registerCommand("codeCubicle.simulate", () => {
      panel = CubiclePanel.createOrShow(context.extensionUri);
      runSimulation();
    }),
    vscode.commands.registerCommand("codeCubicle.toggleCapture", () => {
      toggleCapture();
    })
  );

  subscribeToOutputChannels(context);
  subscribeToHookCapture(context);
  log.appendLine(
    "[CodeCubicle] Activated. Watching output channels: " +
      WATCHED_CHANNEL_NAMES.join(", ") +
      "; hook capture: .codecubicle/activity.jsonl"
  );
}

export function deactivate(): void {
  clearSimulation();
  office?.dispose();
}

// --- Capture mode (raw output-channel logging for parser calibration) ---

/**
 * Toggles capture mode. While on, EVERY line from EVERY `output`-scheme
 * document is echoed to the "CodeCubicle" channel (with its source channel
 * name), so real Copilot output can be inspected and the parser patterns in
 * `parser.ts` calibrated. Note: a channel only emits document changes while it
 * is open/visible in the Output panel.
 */
function toggleCapture(): void {
  captureMode = !captureMode;
  if (captureMode) {
    seenChannels.clear();
    log.appendLine(
      "\n=== CAPTURE ON === Logging ALL output-channel lines. " +
        "Open the Copilot output channel(s) in the Output panel so they emit text."
    );
    log.show(true);
    void vscode.window.showInformationMessage(
      "CodeCubicle: output capture ON — open Copilot's Output channel to record it. Run the command again to stop."
    );
  } else {
    log.appendLine("=== CAPTURE OFF ===\n");
    void vscode.window.showInformationMessage("CodeCubicle: output capture OFF.");
  }
}

/**
 * Best-effort listener for Copilot output. VS Code has no public API to read
 * another extension's output channel, so we watch text documents with the
 * `output` scheme. This only fires while the matching channel is open in the
 * Output panel, and the parser patterns are heuristics. Enable capture mode
 * (`CodeCubicle: Toggle Output Capture`) to record raw lines for calibration.
 */
function subscribeToOutputChannels(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "output") return;

      const docName = e.document.uri.path;

      if (captureMode) {
        captureRaw(docName, e.contentChanges);
      }

      const isWatched = WATCHED_CHANNEL_NAMES.some((name) =>
        docName.toLowerCase().includes(name.toLowerCase())
      );
      if (!isWatched) return;

      for (const change of e.contentChanges) {
        const events = parseChunk(change.text);
        for (const event of events) {
          logEvent("copilot", event);
          office.apply(event);
        }
      }
    })
  );
}

/** Echo raw output-channel lines to the log, announcing each new channel once. */
function captureRaw(
  channel: string,
  changes: readonly vscode.TextDocumentContentChangeEvent[]
): void {
  if (!seenChannels.has(channel)) {
    seenChannels.add(channel);
    log.appendLine(`[capture] new channel: ${channel}`);
  }
  for (const change of changes) {
    for (const line of change.text.split("\n")) {
      if (line.trim()) log.appendLine(`[capture] ${channel} | ${line}`);
    }
  }
}

// --- Hook capture (terminal-mode Claude CLI activity) ---

/** Byte offset already consumed per watched activity file, so we only read appends. */
const hookOffsets = new Map<string, number>();

/** How often the polling fallback re-checks each activity file for appends. */
const HOOK_POLL_MS = 1500;

/**
 * Tail this window's per-workspace hook-capture files. The standalone `claude`
 * CLI writes nothing to an output channel; instead a global hook (configured
 * once in `~/.claude/settings.json`) runs `~/.codecubicle/capture.cjs`, which
 * routes each payload to `~/.codecubicle/sessions/<sessionKey(cwd)>.jsonl`. We
 * tail only the file(s) whose key matches a folder open in THIS window, so
 * multiple VS Code windows each show only their own workspace's activity.
 *
 * Delivery is by **polling** (`tail -f` style). The files live under the home
 * dir, outside any workspace folder, so VS Code's workspace-scoped
 * `FileSystemWatcher` can't see them anyway — and polling proved more reliable
 * than the watcher for externally-appended files. `readNewHookLines` only reads
 * bytes past the stored offset.
 */
function subscribeToHookCapture(context: vscode.ExtensionContext): void {
  // Prime offsets for files that already exist, so startup skips the historical
  // backlog (no replay of past sessions) AND the first new append is still read.
  for (const file of hookFilePaths()) {
    try {
      hookOffsets.set(file, fs.statSync(file).size);
    } catch {
      /* not created yet — will be read from the start once it appears */
    }
  }

  const timer = setInterval(() => {
    for (const file of hookFilePaths()) readNewHookLines(file);
  }, HOOK_POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

/**
 * The central per-workspace activity files this window should tail — one per
 * open workspace folder, keyed identically to `capture.cjs` (see `sessionKey`).
 */
function hookFilePaths(): string[] {
  const sessionsDir = path.join(os.homedir(), ".codecubicle", "sessions");
  return (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.join(sessionsDir, `${sessionKey(folder.uri.fsPath)}.jsonl`)
  );
}

/**
 * Read bytes appended to `file` since we last looked and apply any complete
 * lines. An unseen file is read from the start (offset 0); existing files are
 * primed at startup so their backlog is skipped (see `subscribeToHookCapture`).
 */
function readNewHookLines(file: string): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // file vanished or not created yet
  }

  const prev = hookOffsets.get(file) ?? 0;
  // Truncated/rotated (smaller than before) → restart from the top.
  const start = size < prev ? 0 : prev;
  if (size <= start) {
    hookOffsets.set(file, size);
    return;
  }

  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }

  // Only consume up to the last newline; a trailing partial line (mid-append)
  // stays unread until the next change completes it.
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return; // no complete line yet — leave offset untouched
  const complete = text.slice(0, lastNl + 1);
  hookOffsets.set(file, start + Buffer.byteLength(complete, "utf8"));

  for (const event of parseHookChunk(complete)) {
    logEvent("hook", event);
    office.apply(event);
  }
}

// --- Simulation (for testing the pipeline without live Copilot output) ---

interface ScriptStep {
  at: number; // ms from start
  role: AgentEvent["role"];
  name: string;
  action: AgentEvent["action"];
  detail?: string;
}

/**
 * Scripted demo that exercises the full visual pipeline. Station assignment is
 * by first-appearance order, so the first two distinct names land on the
 * left-door desks (stations 0–1) and the next two on the right-door desks
 * (stations 2–3). The script covers: arrivals through both doors, every
 * activity animation (working→typing, tool_call→thinking), a worker going idle,
 * done→celebrate→walk-out, and a worker leaving then re-entering.
 */
const SIMULATION_SCRIPT: ScriptStep[] = [
  // --- Phase 1: arrivals (two from the left door, two from the right) ---
  { at: 0, role: "main", name: "Agent", action: "spawn" }, // station 0 (left)
  { at: 700, role: "main", name: "Agent", action: "working" },
  { at: 1400, role: "subagent", name: "Helper", action: "spawn" }, // station 1 (left)
  { at: 2100, role: "subagent", name: "Helper", action: "tool_call", detail: "read_file" },
  { at: 2800, role: "subagent", name: "Scout", action: "spawn" }, // station 2 (right)
  { at: 3500, role: "subagent", name: "Scout", action: "working" },
  { at: 4200, role: "subagent", name: "Tester", action: "spawn" }, // station 3 (right)
  { at: 4900, role: "subagent", name: "Tester", action: "tool_call", detail: "run_tests" },

  // --- Phase 2: activity variety (typing / thinking bubbles) ---
  { at: 5600, role: "main", name: "Agent", action: "tool_call", detail: "edit_file" },
  { at: 6300, role: "subagent", name: "Helper", action: "working" }, // Helper's last event → goes idle ~14.3s
  { at: 7000, role: "subagent", name: "Scout", action: "tool_call", detail: "grep" },
  { at: 7700, role: "main", name: "Agent", action: "working" },
  { at: 8400, role: "subagent", name: "Tester", action: "working" },

  // --- Phase 3: completions → celebrate → walk out (frees stations 2 & 3) ---
  { at: 9000, role: "subagent", name: "Scout", action: "done" },
  { at: 10500, role: "subagent", name: "Tester", action: "done" },

  // --- Phase 4: re-entry from the right door (reclaims a freed desk) ---
  { at: 13000, role: "subagent", name: "Scout", action: "spawn" },
  { at: 13700, role: "subagent", name: "Scout", action: "tool_call", detail: "search" },
  { at: 14500, role: "subagent", name: "Scout", action: "working" },

  // --- Phase 5: wind down — everyone finishes and walks out, office empties ---
  { at: 16000, role: "main", name: "Agent", action: "done" }, // walks out left
  { at: 16500, role: "subagent", name: "Helper", action: "done" }, // walks out left
  { at: 17500, role: "subagent", name: "Scout", action: "done" }, // walks out right
];

let simCounter = 0;

function runSimulation(): void {
  clearSimulation();
  office.reset();
  log.appendLine("[CodeCubicle] Running simulation...");

  for (const step of SIMULATION_SCRIPT) {
    simTimers.push(
      setTimeout(() => {
        const event: AgentEvent = {
          id: `sim_${Date.now()}_${++simCounter}`,
          role: step.role,
          name: step.name,
          action: step.action,
          timestamp: Date.now(),
          detail: step.detail,
        };
        logEvent("sim", event);
        office.apply(event);
      }, step.at)
    );
  }
}

function clearSimulation(): void {
  for (const t of simTimers) clearTimeout(t);
  simTimers = [];
}

function logEvent(source: string, event: AgentEvent): void {
  log.appendLine(
    `[${source}] ${event.role} "${event.name}" ${event.action}` +
      (event.detail ? ` (${event.detail})` : "")
  );
}
