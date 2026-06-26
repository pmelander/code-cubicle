/**
 * Maps an absolute path (a session's `cwd` on the capture side, a workspace
 * folder on the extension side) to the filename key for its per-workspace
 * activity file: `~/.codecubicle/sessions/<key>.jsonl`.
 *
 * This is what scopes the office to a single VS Code window — each workspace
 * gets its own file, and a window only tails the key for its own folder(s).
 *
 * ⚠️ The capture script `.codecubicle/capture.cjs` (and its installed copy at
 * `~/.codecubicle/capture.cjs`) duplicates this exact logic — they MUST stay in
 * sync, or the extension tails a different file than the hook writes. Lowercase
 * + collapse every run of non-alphanumerics to `-` so `C:\Yield` and `c:/yield`
 * resolve to the same key regardless of drive-letter case or slash direction.
 */
export function sessionKey(absPath: string): string {
  return absPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
