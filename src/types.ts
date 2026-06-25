/**
 * Shared types for extension <-> webview communication.
 * Both contexts import from this file (extension via TS, webview via copy/bundle).
 */

// --- Agent activity events ---

export type AgentRole = "main" | "subagent";

export interface AgentEvent {
  id: string;
  role: AgentRole;
  name: string;
  action: "spawn" | "working" | "tool_call" | "idle" | "done";
  timestamp: number;
  detail?: string;
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
