import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { rewriteCopilotResponsePayloadConnectionBoundIds } from "./connection-bound-ids.js";

type _StreamContext = Parameters<StreamFn>[1];
type StreamOptions = Parameters<StreamFn>[2];

// Clone payloads before mutating them for display so the original objects
// (which may later be used to build follow-up requests) are not modified.
function clonePayload<T>(value: T): T {
  if (value && typeof value === "object") {
    try {
      // Prefer structuredClone when available (Node 17+ / modern runtimes).
      const sc = (globalThis as unknown as { structuredClone?: (v: unknown) => unknown })
        .structuredClone;
      if (typeof sc === "function") {
        return (sc as (v: unknown) => unknown)(value) as T;
      }
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      // If cloning fails, fall back to returning the original to avoid crashes.
      return value;
    }
  }
  return value;
}

function patchOnPayloadResult(result: unknown): unknown {
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).then((next) => {
      const display = clonePayload(next);
      rewriteCopilotResponsePayloadConnectionBoundIds(display);
      return display;
    });
  }
  const display = clonePayload(result);
  rewriteCopilotResponsePayloadConnectionBoundIds(display);
  return display;
}

export function wrapCopilotAnthropicStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: {
          ...buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages: hasCopilotVisionInput(context.messages),
          }),
          ...options?.headers,
        },
      },
      applyAnthropicEphemeralCacheControlMarkers,
    );
  };
}

export function wrapCopilotOpenAIResponsesStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "openai-responses") {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    const wrappedOptions: StreamOptions = {
      ...options,
      onPayload: (payload, payloadModel) => {
        // Create a display clone and rewrite IDs for UI/handlers.
        const displayPayload = clonePayload(payload);
        rewriteCopilotResponsePayloadConnectionBoundIds(displayPayload);
        // Also rewrite the original payload in-place so downstream processing
        // (encryption, network layers) sees normalized IDs - maintains legacy behavior.
        rewriteCopilotResponsePayloadConnectionBoundIds(payload);
        // Pass the (possibly mutated) original payload to the original hook, and ensure
        // any returned payload is converted to a display clone with rewritten IDs.
        return patchOnPayloadResult(originalOnPayload?.(payload, payloadModel));
      },
    };
    return underlying(model, context, wrappedOptions);
  };
}

export function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return wrapCopilotOpenAIResponsesStream(wrapCopilotAnthropicStream(ctx.streamFn));
}
