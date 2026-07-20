import { describe, expect, it } from "vitest";

import type { MagiEvent, SessionSummary } from "../src/shared/contracts";
import {
  buildModelOptions,
  eventDelta,
  groupSessions,
  isChangeEvent,
  mergeEvents,
  permissionModeLabel,
  projectName,
  streamedTextForJob,
  toggleProjectPath
} from "../src/renderer/src/state";

const session = (id: string, cwd: string, updatedAt: string): SessionSummary => ({
  id,
  cwd,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  messageCount: 1
});

const event = (id: number, action = "agent.tool.completed"): MagiEvent => ({
  id,
  sessionId: "s1",
  action,
  eventName: action,
  category: "tool",
  status: "completed",
  createdAt: new Date(id).toISOString(),
  message: "tool completed",
  metadata: {}
});

describe("desktop state", () => {
  it("groups recent projects and sorts sessions by recency", () => {
    const groups = groupSessions(
      [session("old", "/work/magi", "2026-01-01"), session("new", "/work/magi", "2026-02-01")],
      ["/work/empty"]
    );
    expect(groups.map((group) => group.name)).toEqual(["empty", "magi"]);
    expect(groups[1].sessions.map((item) => item.id)).toEqual(["new", "old"]);
    expect(projectName("/work/magi/")).toBe("magi");
  });

  it("deduplicates replayed stream events and preserves order", () => {
    expect(mergeEvents([event(2)], [event(1), event(2), event(3)]).map((item) => item.id)).toEqual([
      1, 2, 3
    ]);
  });

  it("toggles a project path without disturbing other collapsed projects", () => {
    expect(toggleProjectPath(["/work/one"], "/work/two")).toEqual(["/work/one", "/work/two"]);
    expect(toggleProjectPath(["/work/one", "/work/two"], "/work/one")).toEqual(["/work/two"]);
  });

  it("uses compact permission labels for the composer", () => {
    expect(permissionModeLabel("acceptEdits")).toBe("替我审批");
    expect(permissionModeLabel("default")).toBe("变更前询问");
    expect(permissionModeLabel("bypassPermissions")).toBe("完全访问");
  });

  it("uses full streamed text and recognizes file changes", () => {
    const delta = {
      ...event(1, "agent.text.delta"),
      jobId: "job-1",
      metadata: { text: "hello" }
    };
    const second = {
      ...event(2, "agent.text.delta"),
      jobId: "job-1",
      metadata: { text: " world" }
    };
    expect(eventDelta(delta)).toBe("hello");
    expect(streamedTextForJob([second, delta], "job-1")).toBe("hello world");
    expect(isChangeEvent({ ...event(2), target: "Write" })).toBe(true);
  });

  it("combines configured aliases and discovered provider models for the composer", () => {
    const options = buildModelOptions(
      {
        aliases: { main: "anthropic:claude-main" },
        providers: [
          {
            name: "desktop",
            type: "openai",
            protocol: "openai",
            baseUrl: "https://models.example/v1",
            defaultModel: "coder-main",
            models: ["coder-main", "coder-fast"],
            configured: true
          }
        ]
      },
      "desktop:coder-fast"
    );

    expect(options).toEqual([
      { value: "main", label: "main · anthropic:claude-main" },
      { value: "desktop:coder-main", label: "coder-main · desktop" },
      { value: "desktop:coder-fast", label: "coder-fast · desktop" }
    ]);
  });
});
