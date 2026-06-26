#!/usr/bin/env node
// CodeCubicle hook capture (GLOBAL). Configured once in ~/.claude/settings.json,
// installed at ~/.codecubicle/capture.cjs. Routes each Claude Code hook payload
// to a PER-WORKSPACE file keyed by the session's cwd:
//
//     ~/.codecubicle/sessions/<sessionKey(cwd)>.jsonl
//
// so every VS Code window's office shows only the activity from sessions whose
// cwd matches one of that window's workspace folders. The extension tails the
// same file (src/extension.ts → hookFilePaths).
//
// ⚠️ sessionKey() below MUST stay in sync with src/sessionKey.ts.
const fs = require("fs");
const os = require("os");
const path = require("path");

function sessionKey(p) {
  return String(p)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not JSON — nothing to route
  }
  const cwd = payload && payload.cwd;
  if (!cwd) process.exit(0); // no workspace to attribute it to

  const dir = path.join(os.homedir(), ".codecubicle", "sessions");
  const file = path.join(dir, sessionKey(cwd) + ".jsonl");
  const record = { receivedAt: new Date().toISOString(), payload };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n");
  } catch {
    // Never let a capture failure disturb the agent.
  }
  process.exit(0); // exit clean and silent — hooks may parse stdout as JSON
});
