/**
 * Shared types for extension <-> webview communication.
 * Both contexts import from this file (extension via TS, webview via copy/bundle).
 */

// --- Agent activity events ---

export type AgentRole = "main" | "subagent";

/**
 * Semantic kind of work, used to pick the activity bubble glyph in the renderer
 * (independent of `WorkerAnimation`, which is the body pose). Derived from the
 * tool in `parser.ts`. Absent when the activity is unknown (the renderer then
 * falls back to an animation-based icon).
 */
export type ActivityKind = "edit" | "read" | "search" | "shell" | "web" | "think";

export interface AgentEvent {
  id: string;
  role: AgentRole;
  name: string;
  action: "spawn" | "working" | "tool_call" | "idle" | "done";
  timestamp: number;
  detail?: string;
  activity?: ActivityKind;
}

// --- Worker visual state ---

export type WorkerAnimation =
  | "idle"
  | "typing"
  | "thinking"
  | "talking"
  | "walking"
  | "celebrating";

export interface WorkerState {
  id: string;
  name: string;
  role: AgentRole;
  animation: WorkerAnimation;
  /** Latest activity kind, for the bubble glyph. Undefined ⟹ animation-based icon. */
  activity?: ActivityKind;
  /**
   * Workstation index (0-based). The webview renderer owns the office layout
   * and maps this to on-screen coordinates, so the extension never needs to
   * know pixel positions.
   */
  station: number;
}

// --- Extension -> Webview messages ---

export type ExtToWebMessage =
  | { type: "agent-update"; payload: AgentEvent }
  | { type: "state-sync"; payload: WorkerState[] }
  | { type: "reset" };

// --- Webview -> Extension messages ---

export type WebToExtMessage =
  | { type: "ready" }
  | { type: "request-state" };
