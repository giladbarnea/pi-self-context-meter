import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** @example humanizeTokenCount(87_000) // "87k" */
function humanizeTokenCount(tokenCount: number): string {
  return `${Math.round(tokenCount / 1_000)}k`;
}

const contextMeterTool = defineTool({
  name: "context_meter",
  label: "Context Meter",
  description: "Query how much of the your current context window is used and how much is left. Your context window is your runway. You would want to adapt if you’re running out of it.",
  parameters: Type.Object({}),

  async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) {
      throw new Error("Context usage is unavailable");
    }

    const text = `You have used ${humanizeTokenCount(usage.tokens)} tokens out of ${humanizeTokenCount(usage.contextWindow)} available (used ${Math.round(usage.percent)}%).`;
    return { content: [{ type: "text" as const, text }] };
  },
});

export default function contextMeter(pi: ExtensionAPI): void {
  pi.registerTool(contextMeterTool);
}
