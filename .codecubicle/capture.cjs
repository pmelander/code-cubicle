#!/usr/bin/env node
// CodeCubicle hook capture — VERIFICATION SCAFFOLD.
//
// Reads a Claude Code hook payload (JSON on stdin) and appends it as one line
// to .codecubicle/activity.jsonl, stamped with when we received it. This is the
// terminal-mode CLI complement to the output-channel parsing in src/parser.ts:
// the standalone `claude` CLI writes nothing to the VS Code output window, but
// it does fire hooks, and hook payloads carry proper agent/subagent attribution.
//
// The output path is resolved relative to THIS script (__dirname), so it does
// not matter what working directory the hook runs in. CommonJS (.cjs) so it runs
// regardless of the repo's package.json "type".
const fs = require("fs");
const path = require("path");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const outFile = path.join(__dirname, "activity.jsonl");
  let record;
  try {
    record = { receivedAt: new Date().toISOString(), payload: JSON.parse(raw) };
  } catch {
    // Keep malformed/unexpected input verbatim so we can see what arrived.
    record = { receivedAt: new Date().toISOString(), raw: raw.trim() };
  }
  try {
    fs.appendFileSync(outFile, JSON.stringify(record) + "\n");
  } catch {
    // Never let a capture failure interfere with the agent.
  }
  // Exit clean and silent — hooks may parse stdout as JSON.
  process.exit(0);
});
