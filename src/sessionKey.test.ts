import { describe, it, expect } from "vitest";
import { sessionKey } from "./sessionKey";

describe("sessionKey", () => {
  it("derives a filename-safe key from a Windows path", () => {
    expect(sessionKey("C:\\.workspaces\\code-cubicle")).toBe("c-workspaces-code-cubicle");
  });

  it("is stable across drive-letter case and slash direction", () => {
    // The capture side (payload cwd) and the extension side (workspace fsPath)
    // may differ in these — they must still resolve to the same key.
    const a = sessionKey("C:\\Yield\\PriceEngine");
    const b = sessionKey("c:/yield/priceengine");
    expect(a).toBe(b);
    expect(a).toBe("c-yield-priceengine");
  });

  it("collapses runs of separators and trims edges", () => {
    expect(sessionKey("/home/user//proj/")).toBe("home-user-proj");
  });

  it("keeps distinct workspaces distinct", () => {
    expect(sessionKey("C:\\a\\one")).not.toBe(sessionKey("C:\\a\\two"));
  });
});
