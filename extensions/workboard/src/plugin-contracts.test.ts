// The gateway rejects the whole workboard tool registration when one tool is missing from
// contracts.tools, so a unit test that constructs the tools directly can never see the gap.
// This test reads the manifest and compares it against the registered names.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WORKBOARD_CARD_TOOL_NAMES,
  WORKBOARD_SESSIONS_BOARD_TOOL_NAMES,
} from "./workspace-access.js";

describe("workboard plugin contracts", () => {
  it("declares every registered tool in contracts.tools", () => {
    const manifestUrl = new URL("../openclaw.plugin.json", import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
      contracts?: { tools?: string[] };
      toolMetadata?: Record<string, { optional?: boolean }>;
    };
    const declared = new Set(manifest.contracts?.tools ?? []);
    const registered = [...WORKBOARD_CARD_TOOL_NAMES, ...WORKBOARD_SESSIONS_BOARD_TOOL_NAMES];
    const missing = registered.filter((name) => !declared.has(name));
    // The reverse direction: a declared tool that no longer registers is the same drift, and a
    // one-way check never sees it.
    const orphaned = [...declared].filter((name) => !registered.includes(name));

    expect(missing).toEqual([]);
    expect(orphaned).toEqual([]);

    // Optionality is a separate list and not every tool has an entry; only assert the ones that
    // do, so a card tool declared in toolMetadata must stay optional like its siblings.
    const cardTools = new Set<string>(WORKBOARD_CARD_TOOL_NAMES);
    const nonOptional = Object.entries(manifest.toolMetadata ?? {})
      .filter(([name, meta]) => cardTools.has(name) && meta?.optional !== true)
      .map(([name]) => name);
    expect(nonOptional).toEqual([]);
  });
});
