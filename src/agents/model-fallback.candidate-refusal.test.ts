import { describe, expect, it, vi } from "vitest";
import { ModelFallbackCandidateRefusal } from "./model-fallback-candidate-refusal.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

const primary = { provider: "openai", model: "gpt-4.1" };

function config(fallbacks: string[] = []) {
  return createModelFallbackConfig(`${primary.provider}/${primary.model}`, fallbacks);
}

describe("refused fallback candidates", () => {
  it("reports a primary refusal when no earlier outcome exists", async () => {
    const run = vi.fn(async () => {
      throw new ModelFallbackCandidateRefusal(
        "Automation candidate anthropic is incompatible with its recorded inference account",
      );
    });
    await expect(runWithModelFallback({ cfg: config(), ...primary, run })).rejects.toThrow(
      /incompatible with its recorded inference account/,
    );
  });

  it("keeps the primary failure when a later candidate is refused", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic primary failure"))
      .mockRejectedValueOnce(
        new ModelFallbackCandidateRefusal(
          "Automation candidate anthropic is incompatible with its recorded inference account",
        ),
      );
    await expect(
      runWithModelFallback({
        cfg: config(["anthropic/claude-sonnet-4-5"]),
        ...primary,
        run,
      }),
    ).rejects.toThrow("synthetic primary failure");
  });
});
