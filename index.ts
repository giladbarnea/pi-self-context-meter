import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

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

  renderShell: "self",
  renderCall: (_arguments, theme, context) => (context.executionStarted && context.isPartial ? new Text(label(theme, "warning"), 0, 0) : new Text("", 0, 0)),
  renderResult: (result, _options, theme, context) => {
    const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const usage = context.isError ? undefined : parseSentence(text);
    return usage ? new MeterLine(theme, usage) : new Text(`${label(theme, context.isError ? "error" : "accent")}${theme.fg("dim", " · ")}${theme.fg(context.isError ? "error" : "toolOutput", text)}`, 0, 0);
  },
});

type SentenceUsage = { usedThousands: number; windowThousands: number; percent: number };

const SENTENCE = /^You have used (\d+)k tokens out of (\d+)k available \(used (\d+)%\)\.$/;
const METER_CELLS = 24;
const MIN_METER_CELLS = 8;

/**
 * Reads the numbers back from the model-facing sentence, the only data the stored result has.
 * @example parseSentence("You have used 87k tokens out of 272k available (used 32%).") // { usedThousands: 87, windowThousands: 272, percent: 32 }
 */
function parseSentence(text: string): SentenceUsage | undefined {
  const match = SENTENCE.exec(text);
  return match ? { usedThousands: Number(match[1]), windowThousands: Number(match[2]), percent: Number(match[3]) } : undefined;
}

function label(theme: Theme, bulletColor: ThemeColor): string {
  return `${theme.fg(bulletColor, "● ")}${theme.fg("text", theme.bold("Context Meter"))}`;
}

type Rgb = [number, number, number];
type HeatStop = { at: number; color: ThemeColor; quiet?: boolean };

/** Quiet at empty, loud at full: the context ramp of pi-simple-team and custom-footer. */
const CONTEXT_HEAT_STOPS: HeatStop[] = [
  { at: 0, color: "success", quiet: true },
  { at: 40, color: "success" },
  { at: 70, color: "warning" },
  { at: 100, color: "error" },
];
const QUIET_BLEND = 0.38;

function colorRgb(theme: Theme, color: ThemeColor): Rgb | undefined {
  const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(theme.getFgAnsi(color));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** @example blendRgb([0, 0, 0], [100, 200, 50], 0.5) // [50, 100, 25] */
function blendRgb(start: Rgb, end: Rgb, ratio: number): Rgb {
  return start.map((channel, index) => Math.round(channel + (end[index]! - channel) * ratio)) as Rgb;
}

function stopRgb(theme: Theme, stop: HeatStop): Rgb | undefined {
  const base = colorRgb(theme, stop.color);
  const dim = colorRgb(theme, "dim");
  if (!stop.quiet) return base;
  return base && dim ? blendRgb(base, dim, QUIET_BLEND) : undefined;
}

/** Colors `text` by where `percent` sits on the context ramp; without truecolor values it uses the nearest stop's color. */
function contextHeat(theme: Theme, percent: number, text: string): string {
  const value = Math.min(100, Math.max(0, percent));
  const upper = Math.max(1, CONTEXT_HEAT_STOPS.findIndex((stop) => stop.at >= value));
  const low = CONTEXT_HEAT_STOPS[upper - 1]!;
  const high = CONTEXT_HEAT_STOPS[upper]!;
  const lowRgb = stopRgb(theme, low);
  const highRgb = stopRgb(theme, high);
  if (theme.getColorMode() === "256color" || !lowRgb || !highRgb) {
    return theme.fg(value - low.at <= high.at - value ? low.color : high.color, text);
  }
  const [red, green, blue] = blendRgb(lowRgb, highRgb, (value - low.at) / (high.at - low.at));
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

/**
 * Width of a line built only from this file's one-cell characters; much cheaper than pi-tui's general visibleWidth.
 * @example meterTextWidth("\x1b[1m32%\x1b[22m used") // 8
 */
function meterTextWidth(line: string): number {
  return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}

type MeterParts = { meterless: Array<{ line: string; width: number }>; label: string; figures: string; meterBudget: number; fillOpen: string; fillClose: string; empty(cells: number): string };

/** One meter line. Narrower widths shrink the meter, then drop it, then the label and the totals, keeping the used percent and what is left. */
class MeterLine implements Component {
  private parts: MeterParts | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] = [];

  constructor(private readonly theme: Theme, private readonly usage: SentenceUsage) {}

  render(width: number): string[] {
    if (width !== this.cachedWidth) {
      this.cachedWidth = width;
      this.cachedLines = [this.layout(width, (this.parts ??= this.buildParts()))];
    }
    return this.cachedLines;
  }

  invalidate(): void {
    this.parts = undefined;
    this.cachedWidth = undefined;
  }

  /** Everything that does not depend on the width, built once per theme. */
  private buildParts(): MeterParts {
    const { theme, usage } = this;
    const dot = theme.fg("dim", " · ");
    const used = `${theme.fg("text", theme.bold(`${usage.percent}%`))}${theme.fg("muted", " used")}`;
    const total = `${theme.fg("text", `${usage.usedThousands}k`)}${theme.fg("muted", ` of ${usage.windowThousands}k`)}`;
    const left = `${theme.fg("text", `${usage.windowThousands - usage.usedThousands}k`)}${theme.fg("muted", " left")}`;
    const fullLabel = `${label(theme, "accent")}  `;
    const figures = `${used}${dot}${total}${dot}${left}`;
    const meterless = [`${fullLabel}${figures}`, `${fullLabel}${used}${dot}${left}`, `${theme.fg("accent", "● ")}${used}${dot}${left}`];
    const [fillOpen, fillClose] = contextHeat(theme, usage.percent, "\0").split("\0") as [string, string];
    return {
      meterless: meterless.map((line) => ({ line, width: meterTextWidth(line) })),
      label: fullLabel,
      figures,
      meterBudget: meterTextWidth(`${fullLabel}  ${figures}`),
      fillOpen,
      fillClose,
      empty: (cells) => theme.fg("borderMuted", "─".repeat(cells)),
    };
  }

  private layout(width: number, parts: MeterParts): string {
    const meterCells = Math.min(METER_CELLS, width - parts.meterBudget);
    if (meterCells >= MIN_METER_CELLS) {
      const filled = Math.min(meterCells, Math.max(0, Math.round((this.usage.percent / 100) * meterCells)));
      return `${parts.label}${parts.fillOpen}${"━".repeat(filled)}${parts.fillClose}${parts.empty(meterCells - filled)}  ${parts.figures}`;
    }
    const fitting = parts.meterless.find((candidate) => candidate.width <= width);
    return fitting ? fitting.line : truncateToWidth(parts.meterless.at(-1)!.line, width, "");
  }
}

export default function contextMeter(pi: ExtensionAPI): void {
  pi.registerTool(contextMeterTool);
}
