import type { AgentEvent, WorkerAnimation, WorkerState } from "./types";

/**
 * Maintains the set of on-screen workers from a stream of AgentEvents.
 *
 * This module is intentionally free of any `vscode` dependency so it can be
 * unit-tested in isolation. Timers use the global `setTimeout`/`clearTimeout`
 * so tests can drive them with fake timers.
 */

/** Number of available workstations (matches the renderer's office layout). */
export const MAX_STATIONS = 4;
/** After this much inactivity, a worker leaves the office entirely. */
export const REMOVE_AFTER_IDLE_MS = 30_000;
/** How long a "done" worker celebrates before leaving. */
export const CELEBRATE_MS = 3_000;

interface WorkerTimers {
  remove?: ReturnType<typeof setTimeout>;
}

export function actionToAnimation(action: AgentEvent["action"]): WorkerAnimation {
  switch (action) {
    case "spawn":
      return "walking";
    case "working":
      return "typing";
    case "tool_call":
      return "thinking";
    case "idle":
      return "idle";
    case "done":
      return "celebrating";
    default:
      return "idle";
  }
}

export class OfficeState {
  private readonly workers = new Map<string, WorkerState>();
  private readonly timers = new Map<string, WorkerTimers>();

  constructor(private readonly onChange: (workers: WorkerState[]) => void) {}

  /** Current workers, stable order by station for deterministic rendering. */
  list(): WorkerState[] {
    return [...this.workers.values()].sort((a, b) => a.station - b.station);
  }

  /** Feed a single agent event into the office. */
  apply(event: AgentEvent): void {
    if (event.action === "done") {
      this.markDone(event);
    } else {
      this.upsert(event);
    }
    this.emit();
  }

  /** Clear all workers and pending timers (e.g. the reset command). */
  reset(): void {
    for (const name of [...this.timers.keys()]) {
      this.clearTimers(name);
    }
    this.workers.clear();
    this.emit();
  }

  /** Tear down without emitting (extension deactivation). */
  dispose(): void {
    for (const name of [...this.timers.keys()]) {
      this.clearTimers(name);
    }
    this.workers.clear();
  }

  private upsert(event: AgentEvent): void {
    const existing = this.workers.get(event.name);
    const animation = actionToAnimation(event.action);

    if (existing) {
      existing.animation = animation;
      existing.role = event.role;
    } else {
      const station = this.firstFreeStation();
      if (station < 0) return; // office is full — ignore extra agents
      this.workers.set(event.name, {
        id: event.id,
        name: event.name,
        role: event.role,
        animation,
        station,
      });
    }
    this.scheduleRemoval(event.name);
  }

  private markDone(event: AgentEvent): void {
    const worker = this.workers.get(event.name);
    if (!worker) return;
    worker.animation = "celebrating";
    this.clearTimers(event.name);
    this.timers.set(event.name, {
      remove: setTimeout(() => this.remove(event.name), CELEBRATE_MS),
    });
  }

  /**
   * Schedule the worker to leave after prolonged inactivity. We intentionally
   * do NOT flip the worker to an "idle"/asleep animation: between log lines the
   * agent is usually still working, so it retains its last activity animation
   * (typing/thinking + its bubble) until it either gets a new event or times
   * out and walks off.
   */
  private scheduleRemoval(name: string): void {
    this.clearTimers(name);
    this.timers.set(name, {
      remove: setTimeout(() => this.remove(name), REMOVE_AFTER_IDLE_MS),
    });
  }

  private remove(name: string): void {
    this.clearTimers(name);
    if (this.workers.delete(name)) {
      this.emit();
    }
  }

  private firstFreeStation(): number {
    const taken = new Set([...this.workers.values()].map((w) => w.station));
    for (let i = 0; i < MAX_STATIONS; i++) {
      if (!taken.has(i)) return i;
    }
    return -1;
  }

  private clearTimers(name: string): void {
    const t = this.timers.get(name);
    if (t) {
      if (t.remove) clearTimeout(t.remove);
    }
    this.timers.delete(name);
  }

  private emit(): void {
    this.onChange(this.list());
  }
}
