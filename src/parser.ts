import type { AgentEvent, AgentRole } from "./types";

/**
 * Parses raw Copilot output channel text into structured AgentEvents.
 *
 * This module is intentionally isolated so it can be updated independently
 * when GitHub Copilot changes its output format.
 *
 * Calibrated against a real `GitHub Copilot Chat.log` (Copilot Chat 0.53.1,
 * VS Code 1.125.1). Lines look like:
 *
 *   2026-06-22 17:28:25.500 [info] ccreq:4d22b11b.copilotmd | success | \
 *     claude-opus-4.6 -> claude-opus-4-6 | 6735ms | [panel/editAgent]
 *   2026-06-22 17:28:25.481 [info] [messagesAPI] message 0 returned. finish reason: [stop]
 *   2026-06-22 17:29:18.595 [info] [ToolCallingLoop] Stop hook result: \
 *     shouldContinue=false, reasons=undefined
 *
 * The request endpoint (the trailing `[...]`) tells us *who* did the work:
 *   - `[panel/editAgent]`            -> the main agent (does the real editing)
 *   - `[copilotLanguageModelWrapper]`-> a helper/sub-model call (tool work)
 *   - `[progressMessages]`           -> progress/status generation helper
 *
 * A second supported source is the **Claude Code** extension's output channel
 * (calibrated against a real `Claude VSCode.log`, Claude Code 2.1.x). Its lines
 * look like:
 *
 *   2026-06-24 12:18:35.635 [info] Spawning Claude with SDK query function - cwd: ...
 *   2026-06-24 15:38:55.227 [info] From claude: ... [INFO] [Stall] \
 *     tool_dispatch_start tool=Grep toolUseId=toolu_018Aet... permissionDecisionMs=6
 *   2026-06-25 09:49:16.187 [info] From claude: ... [DEBUG] [API REQUEST] \
 *     /v1/messages x-client-request-id=... source=agent:custom:tdd-backend-csharp
 *   2026-06-25 09:49:16.179 [info] From claude: ... [DEBUG] "Hook \
 *     SubagentStart:tdd-backend-csharp (SubagentStart) error: ..."
 *   2026-06-24 12:19:40.650 [info] Interrupted Claude for requestId: oxkh6bz4pid
 *
 * Worker mapping (the office has only four desks, so we keep the main agent and
 * its delegated subagents as the first-class actors):
 *   - main agent (`Spawning Claude`, `source=sdk`, and every non-shell tool
 *     dispatch) -> the **Agent** desk
 *   - shell tools (`Bash`/`PowerShell`)            -> the **Terminal** desk
 *   - each delegated subagent, keyed by its name (`SubagentStart:<name>` and
 *     `[API REQUEST] ... source=agent:custom:<name>`) -> its own desk
 * Tool dispatches are NOT spread across separate Helper/Progress desks (as the
 * Copilot endpoints are) — that would keep those desks permanently warm and
 * starve the subagents, which are the more interesting signal here.
 */

// Known output channel names to try subscribing to.
//   - "GitHub Copilot Chat" carries the model-request markers (turn start/end,
//     endpoint attribution).
//   - "Terminal" carries the agent's `RunInTerminalTool` activity: every line
//     there is the Copilot agent running a shell command, with the command text
//     and an exit code — a clean, high-signal source.
//   - "Claude Code" / "Claude VSCode" is the Claude Code extension's own
//     channel (spawn + tool-dispatch + session-end markers).
// Matching is case-insensitive substring (see extension.ts), so the names only
// need to be a recognizable fragment of the channel's document path.
export const WATCHED_CHANNEL_NAMES = [
  "GitHub Copilot Chat",
  "GitHub Copilot",
  "GitHub Copilot Agent",
  "Terminal",
  "Claude Code",
  "Claude VSCode",
] as const;

/** A completed request: `ccreq:<id>.copilotmd | success | <model> | <ms>ms | [<endpoint>]`. */
const REQUEST_DONE_PATTERN =
  /ccreq:\S+\s*\|\s*(?:success|error|cancelled)\s*\|\s*([^|]+?)\s*\|\s*\d+ms\s*\|\s*\[([^\]]+)\]/i;

/** A request being prepared: `ccreq:<id>.copilotmd | markdown`. Marks a turn start. */
const REQUEST_PREP_PATTERN = /ccreq:\S+\s*\|\s*markdown\s*$/i;

/** The main agent produced a model message: `[messagesAPI] message N returned`. */
const MESSAGE_RETURNED_PATTERN = /\[messagesAPI\]\s*message\s+\d+\s+returned/i;

/** End of an agent turn: `[ToolCallingLoop] Stop hook result: shouldContinue=false`. */
const TURN_END_PATTERN = /\[ToolCallingLoop\]\s*Stop hook result:\s*shouldContinue=false/i;

// --- Terminal channel markers (the agent's `RunInTerminalTool`) ---

/** A fresh tool terminal is being created -> the Terminal worker walks in. */
const TERMINAL_CREATE_PATTERN =
  /ToolTerminalCreator#createTerminal:\s*Waiting\s+\d+ms for shell integration/i;

/** The agent starts running a command: `... execute strategy for command \`<CMD>\``. */
const TERMINAL_RUN_PATTERN =
  /RunInTerminalTool:\s*Using\s+`[^`]*`\s+execute strategy for command\s+`(.*)$/i;

/** A command finished: `... with exitCode \`N\`, result.length \`L\`, error \`<err>\``. */
const TERMINAL_DONE_PATTERN =
  /RunInTerminalTool:\s*Finished\s+`[^`]*`\s+execute strategy with exitCode\s+`(-?\d+)`.*?error\s+`([^`]*)`/i;

// --- Claude Code channel markers (the `anthropic.claude-code` extension) ---

/** The Claude agent process is (re)started -> the main Agent walks in. */
const CLAUDE_SPAWN_PATTERN = /Spawning Claude with SDK query function/i;

/** A tool starts: `[Stall] tool_dispatch_start tool=<Tool> toolUseId=...`. */
const CLAUDE_TOOL_START_PATTERN = /tool_dispatch_start\s+tool=(\w+)/i;

/** A tool finished: `[Stall] tool_dispatch_end tool=<Tool> ... outcome=<o> ...`. */
const CLAUDE_TOOL_END_PATTERN = /tool_dispatch_end\s+tool=(\w+)\b.*?outcome=(\w+)/i;

/** The session ends — closed by the user or interrupted -> the Agent finishes. */
const CLAUDE_DONE_PATTERN = /(?:Interrupted Claude for requestId|Closing Claude on channel):/i;

/**
 * A delegated subagent is launched: `Hook SubagentStart:<name> (SubagentStart)`.
 * The name is whatever the user called their agent, so we capture the whole
 * token up to the next space/paren rather than assuming a fixed naming scheme.
 */
const CLAUDE_SUBAGENT_START_PATTERN = /\bSubagentStart:([^\s(]+)/i;

/**
 * An LLM request, tagged with who made it:
 *   `[API REQUEST] /v1/messages ... source=sdk`                -> the main agent
 *   `[API REQUEST] /v1/messages ... source=agent:custom:<name>`-> a subagent
 * The `<name>` is arbitrary (any user-defined agent), so it is captured as a
 * whole non-whitespace token. Other sources (growthbook, generate_session_title,
 * …) are intentionally unmatched so they stay out of the office.
 */
const CLAUDE_API_REQUEST_PATTERN =
  /\[API REQUEST\].*?\bsource=(sdk|agent:custom:\S+)/i;

/** Stable worker identities. Each distinct name owns one desk in the office. */
const AGENT_NAME = "Agent";
const HELPER_NAME = "Helper";
const PROGRESS_NAME = "Progress";
const TERMINAL_NAME = "Terminal";

let eventCounter = 0;

function makeId(): string {
  return `evt_${Date.now()}_${++eventCounter}`;
}

interface Classification {
  name: string;
  role: AgentRole;
  action: AgentEvent["action"];
}

/** Map a completed request's endpoint to a worker identity and activity. */
function classifyEndpoint(endpoint: string): Classification {
  if (/editAgent/i.test(endpoint)) {
    return { name: AGENT_NAME, role: "main", action: "working" };
  }
  if (/progressMessages/i.test(endpoint)) {
    return { name: PROGRESS_NAME, role: "subagent", action: "working" };
  }
  // copilotLanguageModelWrapper and any other helper endpoints.
  return { name: HELPER_NAME, role: "subagent", action: "tool_call" };
}

/**
 * Map a Claude Code tool dispatch onto a desk. The `[Stall]` line carries only
 * the tool's name (no arguments and, crucially, no agent attribution), so we
 * keep this deliberately coarse: shell commands get the iconic Terminal desk,
 * and everything else counts as the main Agent's own work. Spreading tools
 * across more desks would crowd out the delegated subagents (see header).
 */
/** Tools that run a shell command — these get the iconic Terminal desk. */
const SHELL_TOOL_PATTERN = /^(Bash|PowerShell)$/i;

function claudeWorkerForTool(tool: string): { name: string; role: AgentRole } {
  if (SHELL_TOOL_PATTERN.test(tool)) return { name: TERMINAL_NAME, role: "subagent" };
  return { name: AGENT_NAME, role: "main" };
}

/** Turn a raw `source=` value into a worker identity (main Agent or a subagent). */
function classifyClaudeSource(source: string): { name: string; role: AgentRole } {
  const subagent = source.match(/^agent:custom:(.+)$/i);
  if (subagent) return { name: subagent[1], role: "subagent" };
  return { name: AGENT_NAME, role: "main" }; // source=sdk
}

function event(c: Classification, detail: string): AgentEvent {
  return {
    id: makeId(),
    name: c.name,
    role: c.role,
    action: c.action,
    timestamp: Date.now(),
    detail,
  };
}

/**
 * Clean a command captured from a terminal log line. The log wraps commands in
 * backticks and appends a ` []` structured-data marker; multi-line commands are
 * truncated to the first line (which is plenty for a speech bubble).
 */
function cleanTerminalCommand(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\[\]\s*$/, "") // trailing structured-data marker
    .replace(/`$/, "") // closing backtick of the `...` wrapper
    .trim();
}

/**
 * Attempt to parse a single line of Copilot output into an AgentEvent.
 * Returns null if the line is not recognized as an agent activity event.
 */
export function parseLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // --- Terminal channel: the agent's `RunInTerminalTool` activity ---

  // A new tool terminal is spun up -> the Terminal worker arrives.
  if (TERMINAL_CREATE_PATTERN.test(trimmed)) {
    return event({ name: TERMINAL_NAME, role: "subagent", action: "spawn" }, "opening a terminal");
  }

  // A command starts running -> show it as a tool call with the command text.
  const runMatch = trimmed.match(TERMINAL_RUN_PATTERN);
  if (runMatch) {
    return event(
      { name: TERMINAL_NAME, role: "subagent", action: "tool_call" },
      cleanTerminalCommand(runMatch[1])
    );
  }

  // A command finished -> keep the worker active; note success/failure.
  const termDone = trimmed.match(TERMINAL_DONE_PATTERN);
  if (termDone) {
    const [, exitCode, error] = termDone;
    const ok = exitCode === "0" && /^undefined$/i.test(error.trim());
    return event(
      { name: TERMINAL_NAME, role: "subagent", action: "working" },
      ok ? "✓ exit 0" : `✗ exit ${exitCode}`
    );
  }

  // --- Claude Code channel: the `anthropic.claude-code` extension ---

  // The Claude agent process is (re)started -> the main Agent walks in.
  if (CLAUDE_SPAWN_PATTERN.test(trimmed)) {
    return event({ name: AGENT_NAME, role: "main", action: "spawn" }, "starting Claude");
  }

  // The session was closed or interrupted -> the main Agent finishes.
  if (CLAUDE_DONE_PATTERN.test(trimmed)) {
    return event({ name: AGENT_NAME, role: "main", action: "done" }, "session ended");
  }

  // A delegated subagent is launched -> it walks in at its own desk.
  const subStart = trimmed.match(CLAUDE_SUBAGENT_START_PATTERN);
  if (subStart) {
    const name = subStart[1];
    return event({ name, role: "subagent", action: "spawn" }, `subagent ${name}`);
  }

  // An LLM request -> keep its author (the main agent or a named subagent)
  // active. This is what animates a subagent between its tool calls.
  const apiReq = trimmed.match(CLAUDE_API_REQUEST_PATTERN);
  if (apiReq) {
    const worker = classifyClaudeSource(apiReq[1]);
    return event({ ...worker, action: "working" }, apiReq[1]);
  }

  // A tool starts -> shell commands run on the Terminal desk (a tool_call /
  // thinking bubble); any other tool is the main Agent's own work (typing).
  const claudeStart = trimmed.match(CLAUDE_TOOL_START_PATTERN);
  if (claudeStart) {
    const tool = claudeStart[1];
    const worker = claudeWorkerForTool(tool);
    const action = worker.name === AGENT_NAME ? "working" : "tool_call";
    return event({ ...worker, action }, tool);
  }

  // A tool finished -> keep the worker active; note success/failure.
  const claudeEnd = trimmed.match(CLAUDE_TOOL_END_PATTERN);
  if (claudeEnd) {
    const [, tool, outcome] = claudeEnd;
    const worker = claudeWorkerForTool(tool);
    const ok = /^ok$/i.test(outcome);
    return event({ ...worker, action: "working" }, ok ? `✓ ${tool}` : `✗ ${tool}`);
  }

  // --- Copilot Chat channel: model-request markers ---

  // End of a turn -> the main agent celebrates.
  if (TURN_END_PATTERN.test(trimmed)) {
    return event({ name: AGENT_NAME, role: "main", action: "done" }, trimmed);
  }

  // A completed request -> attribute the work to the right worker by endpoint.
  const doneMatch = trimmed.match(REQUEST_DONE_PATTERN);
  if (doneMatch) {
    const [, model, endpoint] = doneMatch;
    return event(classifyEndpoint(endpoint), model.trim());
  }

  // A request is being prepared -> the main agent starts working (turn start).
  if (REQUEST_PREP_PATTERN.test(trimmed)) {
    return event({ name: AGENT_NAME, role: "main", action: "spawn" }, trimmed);
  }

  // The main agent produced a model message -> keep it active/typing.
  if (MESSAGE_RETURNED_PATTERN.test(trimmed)) {
    return event({ name: AGENT_NAME, role: "main", action: "working" }, trimmed);
  }

  return null;
}

/**
 * Parse a multi-line chunk of output, returning all recognized events.
 */
export function parseChunk(text: string): AgentEvent[] {
  const lines = text.split("\n");
  const events: AgentEvent[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Claude Code hook source (terminal-mode CLI)
// ---------------------------------------------------------------------------
//
// The output-channel parsing above only sees the Claude Code *extension*. When
// the standalone `claude` CLI runs in the integrated terminal it writes nothing
// to any output channel, but it does fire hooks. `.codecubicle/capture.cjs`
// (configured via `.claude/settings.json`) appends each hook payload as a JSON
// line, and the extension tails that file through `parseHookChunk`.
//
// Hook payloads are *better* than the `[Stall]` output-channel lines: a
// subagent's own tool calls carry `agent_id`/`agent_type`, so we can route them
// to the subagent's desk instead of the main Agent's (the attribution gap noted
// in AGENTS.md). The discriminator is simple — `agent_type` present ⟹ subagent,
// absent ⟹ the main Agent. Verified against a real capture (Claude Code 2.1.x):
//
//   { "hook_event_name": "SessionStart", session_id, transcript_path, cwd }
//   { "hook_event_name": "PreToolUse",  tool_name, tool_input, tool_use_id }            (main agent)
//   { "hook_event_name": "PreToolUse",  tool_name, …, agent_id, agent_type }            (subagent)
//   { "hook_event_name": "PostToolUse", tool_name, tool_response, duration_ms, … }
//   { "hook_event_name": "SubagentStart", agent_id, agent_type }
//   { "hook_event_name": "SubagentStop",  agent_id, agent_type, last_assistant_message }
//   { "hook_event_name": "Stop", … }

/** The subset of a Claude Code hook payload we map onto office activity. */
export interface ClaudeHookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string; [key: string]: unknown };
  tool_response?: unknown;
  /** Present only on a subagent's events; absent for the main agent. */
  agent_id?: string;
  agent_type?: string;
}

/**
 * Pick the desk for a hook tool event. Shell tools keep the iconic Terminal
 * desk regardless of who ran them; otherwise a subagent's work goes to its own
 * desk (keyed by `agent_type`) and the main agent's to the Agent desk.
 */
function hookWorkerForTool(
  tool: string,
  agentType?: string
): { name: string; role: AgentRole } {
  if (SHELL_TOOL_PATTERN.test(tool)) return { name: TERMINAL_NAME, role: "subagent" };
  if (agentType) return { name: agentType, role: "subagent" };
  return { name: AGENT_NAME, role: "main" };
}

/**
 * Best-effort failure detection for a PostToolUse `tool_response`. The shape
 * varies per tool and no field is universal, so we only flag the unambiguous
 * error markers and otherwise assume success.
 */
function hookToolErrored(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const r = response as Record<string, unknown>;
  if (r.is_error === true || r.isError === true) return true;
  return typeof r.error === "string" && r.error.trim().length > 0;
}

/**
 * Map a single Claude Code hook payload onto an AgentEvent, or null if it is
 * not an activity event we visualize (Notification, PreCompact, …).
 */
export function parseHookPayload(payload: ClaudeHookPayload): AgentEvent | null {
  switch (payload.hook_event_name) {
    case "SessionStart":
      return event({ name: AGENT_NAME, role: "main", action: "spawn" }, "starting Claude");

    case "Stop":
      return event({ name: AGENT_NAME, role: "main", action: "done" }, "session ended");

    case "SubagentStart": {
      const name = payload.agent_type;
      if (!name) return null;
      return event({ name, role: "subagent", action: "spawn" }, `subagent ${name}`);
    }

    case "SubagentStop": {
      const name = payload.agent_type;
      if (!name) return null;
      return event({ name, role: "subagent", action: "done" }, `subagent ${name} done`);
    }

    case "PreToolUse": {
      const tool = payload.tool_name;
      if (!tool) return null;
      const worker = hookWorkerForTool(tool, payload.agent_type);
      // Shell commands show a thinking bubble; an agent's own tools = typing.
      const action = SHELL_TOOL_PATTERN.test(tool) ? "tool_call" : "working";
      return event({ ...worker, action }, tool);
    }

    case "PostToolUse": {
      const tool = payload.tool_name;
      if (!tool) return null;
      const worker = hookWorkerForTool(tool, payload.agent_type);
      const ok = !hookToolErrored(payload.tool_response);
      return event({ ...worker, action: "working" }, ok ? `✓ ${tool}` : `✗ ${tool}`);
    }

    default:
      return null;
  }
}

/**
 * Parse appended lines of `.codecubicle/activity.jsonl`. Each line is a JSON
 * record written by `capture.cjs` (`{ receivedAt, payload }`); a bare payload
 * is also accepted. Malformed/partial lines are skipped.
 */
export function parseHookChunk(text: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // partial or non-JSON line — skip it
    }
    const payload = unwrapHookRecord(parsed);
    if (!payload) continue;
    const evt = parseHookPayload(payload);
    if (evt) events.push(evt);
  }
  return events;
}

/** Unwrap capture.cjs's `{ receivedAt, payload }` envelope, or a bare payload. */
function unwrapHookRecord(parsed: unknown): ClaudeHookPayload | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const inner = obj.payload;
  if (inner && typeof inner === "object") return inner as ClaudeHookPayload;
  return obj as ClaudeHookPayload;
}
