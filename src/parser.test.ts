import { describe, it, expect } from "vitest";
import { parseLine, parseChunk, parseHookPayload, parseHookChunk } from "./parser";

// Real lines sampled from a captured `GitHub Copilot Chat.log`
// (Copilot Chat 0.53.1, VS Code 1.125.1).
const L = {
  prep: "2026-06-22 17:28:11.171 [info] ccreq:ec67d6d9.copilotmd | markdown",
  editAgent:
    "2026-06-22 17:28:25.500 [info] ccreq:4d22b11b.copilotmd | success | claude-opus-4.6 -> claude-opus-4-6 | 6735ms | [panel/editAgent]",
  helper:
    "2026-06-22 17:28:12.229 [info] ccreq:de867198.copilotmd | success | gpt-4o-mini-2024-07-18 | 769ms | [copilotLanguageModelWrapper]",
  progress:
    "2026-06-22 17:28:18.581 [info] ccreq:91677af8.copilotmd | success | gpt-4o-mini-2024-07-18 | 1276ms | [progressMessages]",
  message:
    "2026-06-22 17:28:25.481 [info] [messagesAPI] message 0 returned. finish reason: [stop]",
  turnEnd:
    "2026-06-22 17:29:18.595 [info] [ToolCallingLoop] Stop hook result: shouldContinue=false, reasons=undefined",
  noise:
    "2026-06-22 17:28:58.953 [info] [CopilotCLIChatSessionContentProvider] listSessions took 14.03ms",
  // Real lines sampled from a captured "Terminal" output channel.
  termCreate:
    "2026-06-23 07:31:05.030 [info] ToolTerminalCreator#createTerminal: Waiting 4997ms for shell integration []",
  termCreateNoise:
    "2026-06-23 07:31:06.609 [info] ToolTerminalCreator#createTerminal: Waiting up to 2s for PromptInputModel state to change []",
  termRun:
    "2026-06-23 08:30:27.335 [info] RunInTerminalTool: Using `rich` execute strategy for command `dotnet test \"source\\Yield Price Engine.sln\" --no-restore 2>&1 | Select-Object -Last 15` []",
  termDoneOk:
    "2026-06-23 07:40:06.907 [info] RunInTerminalTool: Finished `rich` execute strategy with exitCode `0`, result.length `12889`, error `undefined` []",
  termDoneFail:
    "2026-06-23 08:31:36.071 [info] RunInTerminalTool: Finished `rich` execute strategy with exitCode `1`, result.length `416`, error `boom` []",
  // Real lines sampled from a captured "Claude Code" channel
  // (`Claude VSCode.log`, Claude Code 2.1.187).
  claudeSpawn:
    "2026-06-24 12:18:35.635 [info] Spawning Claude with SDK query function - cwd: c:\\OpenCode\\dp-package-price-toggle, permission mode: default, version: 2.1.187, resume: undefined",
  claudeConfigNoise:
    "2026-06-24 12:18:23.346 [info] Loading config cache by launching Claude (no channel)...",
  claudeGrepStart:
    "2026-06-24 15:38:55.227 [info] From claude: 2026-06-24T13:38:55.223Z [INFO] [Stall] tool_dispatch_start tool=Grep toolUseId=toolu_018Aet4RmxTmjA33FYC6qnKo permissionDecisionMs=6",
  claudeGrepEnd:
    "2026-06-24 15:38:55.323 [info] From claude: 2026-06-24T13:38:55.319Z [INFO] [Stall] tool_dispatch_end tool=Grep toolUseId=toolu_018Aet4RmxTmjA33FYC6qnKo outcome=ok durationMs=96",
  claudeEditStart:
    "2026-06-24 15:39:26.160 [info] From claude: 2026-06-24T13:39:26.157Z [INFO] [Stall] tool_dispatch_start tool=Edit toolUseId=toolu_01HbBJRjxovNzJpxpdfz8YSG permissionDecisionMs=1",
  claudeBashStart:
    "2026-06-24 15:39:26.160 [info] From claude: 2026-06-24T13:39:26.157Z [INFO] [Stall] tool_dispatch_start tool=Bash toolUseId=toolu_01HbBJRjxovNzJpxpdfz8YSX permissionDecisionMs=1",
  claudeInterrupt:
    "2026-06-24 12:19:40.650 [info] Interrupted Claude for requestId: oxkh6bz4pid",
  claudeClose:
    "2026-06-24 12:19:40.650 [info] Closing Claude on channel: oxkh6bz4pid",
  // Subagent orchestration (Claude Code 2.1.x): a SubagentStart hook and the
  // per-request `source=` attribution tag.
  claudeSubagentStart:
    '2026-06-25 09:49:16.187 [info] From claude: 2026-06-25T07:49:16.179Z [DEBUG] "Hook SubagentStart:tdd-backend-csharp (SubagentStart) error:\\n/usr/bin/bash: line 1: node: command not found\\n"',
  claudeSubagentRequest:
    "2026-06-25 09:55:18.550 [info] From claude: 2026-06-25T07:55:18.549Z [DEBUG] [API REQUEST] /v1/messages x-client-request-id=95c6a8a7-f888-4566-b791-358c81c70a51 source=agent:custom:tdd-backend-csharp",
  claudeSdkRequest:
    "2026-06-25 09:49:16.187 [info] From claude: 2026-06-25T07:49:16.187Z [DEBUG] [API REQUEST] /v1/messages x-client-request-id=c305d53b-3143-473b-868f-fe1123ace80f source=sdk",
  claudeGrowthbookNoise:
    "2026-06-25 09:49:16.187 [info] From claude: 2026-06-25T07:49:16.187Z [DEBUG] [API REQUEST] /v1/messages x-client-request-id=deadbeef source=growthbook",
  // An agent name we've never seen, with mixed casing/underscores — the parser
  // must not assume any fixed set of agent names.
  claudeUnknownAgentStart:
    '2026-06-25 11:00:00.000 [info] From claude: 2026-06-25T09:00:00.000Z [DEBUG] "Hook SubagentStart:My_Custom.Agent42 (SubagentStart) error: x"',
  claudeUnknownAgentRequest:
    "2026-06-25 11:00:01.000 [info] From claude: 2026-06-25T09:00:01.000Z [DEBUG] [API REQUEST] /v1/messages x-client-request-id=abc source=agent:custom:My_Custom.Agent42",
};

describe("parseLine", () => {
  it("treats a prepared request as the main agent spawning", () => {
    expect(parseLine(L.prep)).toMatchObject({
      action: "spawn",
      name: "Agent",
      role: "main",
    });
  });

  it("attributes a panel/editAgent request to the main agent working", () => {
    expect(parseLine(L.editAgent)).toMatchObject({
      action: "working",
      name: "Agent",
      role: "main",
      detail: "claude-opus-4.6 -> claude-opus-4-6",
    });
  });

  it("attributes a copilotLanguageModelWrapper request to a helper subagent", () => {
    expect(parseLine(L.helper)).toMatchObject({
      action: "tool_call",
      name: "Helper",
      role: "subagent",
    });
  });

  it("attributes a progressMessages request to the progress subagent", () => {
    expect(parseLine(L.progress)).toMatchObject({
      action: "working",
      name: "Progress",
      role: "subagent",
    });
  });

  it("keeps the main agent active on a messagesAPI message", () => {
    expect(parseLine(L.message)).toMatchObject({
      action: "working",
      name: "Agent",
      role: "main",
    });
  });

  it("ends the turn with a done event on the ToolCallingLoop stop hook", () => {
    expect(parseLine(L.turnEnd)).toMatchObject({
      action: "done",
      name: "Agent",
      role: "main",
    });
  });

  it("returns null for unrecognized lines", () => {
    expect(parseLine(L.noise)).toBeNull();
    expect(parseLine("just some random log output")).toBeNull();
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
  });
});

describe("parseLine (Terminal channel)", () => {
  it("spawns the Terminal worker when a tool terminal is created", () => {
    expect(parseLine(L.termCreate)).toMatchObject({
      action: "spawn",
      name: "Terminal",
      role: "subagent",
    });
  });

  it("ignores the secondary createTerminal line (PromptInputModel wait)", () => {
    expect(parseLine(L.termCreateNoise)).toBeNull();
  });

  it("emits a tool_call with the command text when a command runs", () => {
    expect(parseLine(L.termRun)).toMatchObject({
      action: "tool_call",
      name: "Terminal",
      role: "subagent",
      detail: 'dotnet test "source\\Yield Price Engine.sln" --no-restore 2>&1 | Select-Object -Last 15',
    });
  });

  it("keeps the Terminal worker active and flags success on exit 0", () => {
    expect(parseLine(L.termDoneOk)).toMatchObject({
      action: "working",
      name: "Terminal",
      detail: "✓ exit 0",
    });
  });

  it("flags failure on a non-zero exit code", () => {
    expect(parseLine(L.termDoneFail)).toMatchObject({
      action: "working",
      name: "Terminal",
      detail: "✗ exit 1",
    });
  });
});

describe("parseLine (Claude Code channel)", () => {
  it("spawns the main Agent when the Claude process is launched", () => {
    expect(parseLine(L.claudeSpawn)).toMatchObject({
      action: "spawn",
      name: "Agent",
      role: "main",
    });
  });

  it("ignores the config-cache launch line (not a real session)", () => {
    expect(parseLine(L.claudeConfigNoise)).toBeNull();
  });

  it("counts a non-shell tool (Grep) as the main Agent's own work", () => {
    expect(parseLine(L.claudeGrepStart)).toMatchObject({
      action: "working",
      name: "Agent",
      role: "main",
      detail: "Grep",
    });
  });

  it("keeps the Agent active and flags success when a tool finishes", () => {
    expect(parseLine(L.claudeGrepEnd)).toMatchObject({
      action: "working",
      name: "Agent",
      detail: "✓ Grep",
    });
  });

  it("treats an edit tool as the main Agent's own work (typing)", () => {
    expect(parseLine(L.claudeEditStart)).toMatchObject({
      action: "working",
      name: "Agent",
      role: "main",
      detail: "Edit",
    });
  });

  it("routes Bash to the Terminal worker", () => {
    expect(parseLine(L.claudeBashStart)).toMatchObject({
      action: "tool_call",
      name: "Terminal",
      role: "subagent",
      detail: "Bash",
    });
  });

  it("spawns a subagent keyed by name on a SubagentStart hook", () => {
    expect(parseLine(L.claudeSubagentStart)).toMatchObject({
      action: "spawn",
      name: "tdd-backend-csharp",
      role: "subagent",
    });
  });

  it("keeps a subagent active on its own API request (source=agent:custom:*)", () => {
    expect(parseLine(L.claudeSubagentRequest)).toMatchObject({
      action: "working",
      name: "tdd-backend-csharp",
      role: "subagent",
    });
  });

  it("attributes an sdk API request to the main Agent", () => {
    expect(parseLine(L.claudeSdkRequest)).toMatchObject({
      action: "working",
      name: "Agent",
      role: "main",
    });
  });

  it("ignores API requests from other sources (growthbook, titles, …)", () => {
    expect(parseLine(L.claudeGrowthbookNoise)).toBeNull();
  });

  it("handles an arbitrary, never-before-seen agent name", () => {
    expect(parseLine(L.claudeUnknownAgentStart)).toMatchObject({
      action: "spawn",
      name: "My_Custom.Agent42",
      role: "subagent",
    });
    expect(parseLine(L.claudeUnknownAgentRequest)).toMatchObject({
      action: "working",
      name: "My_Custom.Agent42",
      role: "subagent",
    });
  });

  it("ends the turn on an interrupt", () => {
    expect(parseLine(L.claudeInterrupt)).toMatchObject({
      action: "done",
      name: "Agent",
      role: "main",
    });
  });

  it("ends the turn when the session is closed", () => {
    expect(parseLine(L.claudeClose)).toMatchObject({
      action: "done",
      name: "Agent",
      role: "main",
    });
  });
});

describe("parseChunk", () => {
  it("extracts every recognized event from a multi-line chunk", () => {
    const chunk = [
      L.prep,
      L.helper,
      L.noise,
      L.editAgent,
      L.turnEnd,
    ].join("\n");

    const events = parseChunk(chunk);
    expect(events.map((e) => e.action)).toEqual([
      "spawn",
      "tool_call",
      "working",
      "done",
    ]);
    expect(events[1].role).toBe("subagent");
  });
});

// Real hook payloads sampled from a `.codecubicle/activity.jsonl` capture
// (Claude Code 2.1.x). Subagent events/tool-calls carry agent_id/agent_type;
// the main agent's do not — that is the attribution discriminator.
const H = {
  sessionStart: {
    session_id: "s1",
    transcript_path: "C:\\Users\\x\\.claude\\projects\\p\\s1.jsonl",
    cwd: "C:\\.workspaces\\code-cubicle",
    hook_event_name: "SessionStart",
  },
  mainEdit: {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "x.ts", old_string: "a", new_string: "b" },
    tool_use_id: "toolu_1",
  },
  mainBash: {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_use_id: "toolu_2",
  },
  mainEditDone: {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_response: { filePath: "x.ts", structuredPatch: [] },
    duration_ms: 32,
  },
  mainEditFailed: {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_response: { is_error: true, error: "no match" },
  },
  subagentStart: {
    agent_id: "aa290ac7cf0598444",
    agent_type: "Explore",
    hook_event_name: "SubagentStart",
  },
  subagentRead: {
    agent_id: "aa290ac7cf0598444",
    agent_type: "Explore",
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "package.json" },
    tool_use_id: "toolu_3",
  },
  subagentBash: {
    agent_id: "aa290ac7cf0598444",
    agent_type: "Explore",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  },
  subagentStop: {
    agent_id: "aa290ac7cf0598444",
    agent_type: "Explore",
    hook_event_name: "SubagentStop",
    last_assistant_message: "done",
  },
  stop: { hook_event_name: "Stop" },
  notification: { hook_event_name: "Notification", message: "idle" },
};

describe("parseHookPayload (Claude Code hooks)", () => {
  it("spawns the main Agent on SessionStart", () => {
    expect(parseHookPayload(H.sessionStart)).toMatchObject({
      action: "spawn",
      name: "Agent",
      role: "main",
    });
  });

  it("treats the main agent's non-shell tool as its own work (typing)", () => {
    expect(parseHookPayload(H.mainEdit)).toMatchObject({
      action: "working",
      name: "Agent",
      role: "main",
      detail: "Edit",
    });
  });

  it("routes the main agent's Bash to the Terminal desk (thinking)", () => {
    expect(parseHookPayload(H.mainBash)).toMatchObject({
      action: "tool_call",
      name: "Terminal",
      role: "subagent",
      detail: "Bash",
    });
  });

  it("attributes a subagent's tool call to ITS OWN desk via agent_type", () => {
    expect(parseHookPayload(H.subagentRead)).toMatchObject({
      action: "working",
      name: "Explore",
      role: "subagent",
      detail: "Read",
    });
  });

  it("keeps shell tools on the Terminal desk even for a subagent", () => {
    expect(parseHookPayload(H.subagentBash)).toMatchObject({
      action: "tool_call",
      name: "Terminal",
      role: "subagent",
    });
  });

  it("flags success on PostToolUse", () => {
    expect(parseHookPayload(H.mainEditDone)).toMatchObject({
      action: "working",
      name: "Agent",
      detail: "✓ Edit",
    });
  });

  it("flags failure when the tool_response carries an error", () => {
    expect(parseHookPayload(H.mainEditFailed)).toMatchObject({
      action: "working",
      detail: "✗ Edit",
    });
  });

  it("spawns a subagent keyed by agent_type on SubagentStart", () => {
    expect(parseHookPayload(H.subagentStart)).toMatchObject({
      action: "spawn",
      name: "Explore",
      role: "subagent",
    });
  });

  it("ends a subagent on SubagentStop", () => {
    expect(parseHookPayload(H.subagentStop)).toMatchObject({
      action: "done",
      name: "Explore",
      role: "subagent",
    });
  });

  it("ends the main Agent turn on Stop", () => {
    expect(parseHookPayload(H.stop)).toMatchObject({
      action: "done",
      name: "Agent",
      role: "main",
    });
  });

  it("returns null for events we do not visualize", () => {
    expect(parseHookPayload(H.notification)).toBeNull();
  });

  it("returns null for a tool event missing its tool_name", () => {
    expect(parseHookPayload({ hook_event_name: "PreToolUse" })).toBeNull();
  });

  it("returns null for a SubagentStart missing agent_type", () => {
    expect(parseHookPayload({ hook_event_name: "SubagentStart", agent_id: "x" })).toBeNull();
  });
});

describe("parseHookChunk", () => {
  it("unwraps capture.cjs's { receivedAt, payload } envelope", () => {
    const line = JSON.stringify({ receivedAt: "2026-06-25T08:58:24Z", payload: H.subagentStart });
    const events = parseHookChunk(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "Explore", action: "spawn" });
  });

  it("accepts a bare payload (no envelope)", () => {
    const events = parseHookChunk(JSON.stringify(H.sessionStart));
    expect(events[0]).toMatchObject({ name: "Agent", action: "spawn" });
  });

  it("skips blank, partial, and non-JSON lines", () => {
    const text = [
      "",
      "   ",
      "{ not valid json",
      '{"receivedAt":"t","payload":', // truncated mid-append
      JSON.stringify({ payload: H.mainEdit }),
    ].join("\n");
    const events = parseHookChunk(text);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "Agent", detail: "Edit" });
  });

  it("extracts multiple events preserving order", () => {
    const text = [
      H.sessionStart,
      H.subagentStart,
      H.subagentRead,
      H.notification, // ignored
      H.subagentStop,
    ]
      .map((p) => JSON.stringify({ payload: p }))
      .join("\n");
    const events = parseHookChunk(text);
    expect(events.map((e) => `${e.name}:${e.action}`)).toEqual([
      "Agent:spawn",
      "Explore:spawn",
      "Explore:working",
      "Explore:done",
    ]);
  });
});
