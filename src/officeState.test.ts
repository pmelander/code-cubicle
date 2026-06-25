import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OfficeState,
  MAX_STATIONS,
  REMOVE_AFTER_IDLE_MS,
  CELEBRATE_MS,
  actionToAnimation,
} from "./officeState";
import type { AgentEvent } from "./types";

let idCounter = 0;
function event(
  name: string,
  action: AgentEvent["action"],
  role: AgentEvent["role"] = "main"
): AgentEvent {
  return { id: `e${++idCounter}`, name, action, role, timestamp: Date.now() };
}

describe("actionToAnimation", () => {
  it("maps actions to animations", () => {
    expect(actionToAnimation("spawn")).toBe("walking");
    expect(actionToAnimation("working")).toBe("typing");
    expect(actionToAnimation("tool_call")).toBe("thinking");
    expect(actionToAnimation("idle")).toBe("idle");
    expect(actionToAnimation("done")).toBe("celebrating");
  });
});

describe("OfficeState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds a worker on first event at station 0", () => {
    const office = new OfficeState(() => {});
    office.apply(event("Builder", "spawn"));
    const workers = office.list();
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      name: "Builder",
      station: 0,
      animation: "walking",
    });
  });

  it("updates animation for an existing worker without adding a station", () => {
    const office = new OfficeState(() => {});
    office.apply(event("Builder", "spawn"));
    office.apply(event("Builder", "working"));
    const workers = office.list();
    expect(workers).toHaveLength(1);
    expect(workers[0].animation).toBe("typing");
  });

  it("assigns distinct stations and ignores agents beyond capacity", () => {
    const office = new OfficeState(() => {});
    for (let i = 0; i < MAX_STATIONS + 2; i++) {
      office.apply(event(`Agent${i}`, "spawn"));
    }
    const workers = office.list();
    expect(workers).toHaveLength(MAX_STATIONS);
    expect(workers.map((w) => w.station)).toEqual([0, 1, 2, 3]);
  });

  it("keeps its last animation until it leaves", () => {
    const office = new OfficeState(() => {});
    office.apply(event("Builder", "working"));
    expect(office.list()[0].animation).toBe("typing");

    // Between log lines the worker stays "working" rather than dropping to idle.
    vi.advanceTimersByTime(REMOVE_AFTER_IDLE_MS - 1);
    expect(office.list()[0].animation).toBe("typing");

    vi.advanceTimersByTime(1);
    expect(office.list()).toHaveLength(0);
  });

  it("celebrates on done then frees the station", () => {
    const office = new OfficeState(() => {});
    office.apply(event("Builder", "spawn"));
    office.apply(event("Builder", "done"));
    expect(office.list()[0].animation).toBe("celebrating");

    vi.advanceTimersByTime(CELEBRATE_MS);
    expect(office.list()).toHaveLength(0);

    // Station 0 is now free and reused by the next agent
    office.apply(event("NextOne", "spawn"));
    expect(office.list()[0].station).toBe(0);
  });

  it("ignores a done event for an unknown worker", () => {
    const office = new OfficeState(() => {});
    office.apply(event("Ghost", "done"));
    expect(office.list()).toHaveLength(0);
  });

  it("emits the worker list on every change", () => {
    const onChange = vi.fn();
    const office = new OfficeState(onChange);
    office.apply(event("Builder", "spawn"));
    office.apply(event("Builder", "working"));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.lastCall?.[0][0].animation).toBe("typing");
  });

  it("reset clears workers and pending timers", () => {
    const office = new OfficeState(() => {});
    office.apply(event("Builder", "spawn"));
    office.reset();
    expect(office.list()).toHaveLength(0);

    // No stray timers should resurrect or mutate state
    vi.advanceTimersByTime(REMOVE_AFTER_IDLE_MS * 2);
    expect(office.list()).toHaveLength(0);
  });
});
