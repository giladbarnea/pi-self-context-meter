import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const storedSentence = "You have used 87k tokens out of 272k available (used 32%).";
const approvedLine = `● Context Meter  ${"━".repeat(8)}${"─".repeat(16)}  32% used · 87k of 272k · 185k left`;

let toolDefinition;

before(async () => {
  initTheme("dark");
  const sandbox = await mkdtemp(join(tmpdir(), "pi-self-context-meter-render-"));
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: sandbox,
      agentDir: sandbox,
      additionalExtensionPaths: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    toolDefinition = resourceLoader.getExtensions().extensions[0].tools.get("context_meter").definition;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

function plain(line) {
  return line.replace(/\x1b\[[0-9;:]*m/g, "").trimEnd();
}

/** Renders the tool through Pi's own tool-execution component, as the transcript does. */
function renderTool({ result, executionStarted = true, width = 110 }) {
  const component = new ToolExecutionComponent("context_meter", "meter-1", {}, {}, toolDefinition, { requestRender() {} }, "/");
  if (executionStarted) component.markExecutionStarted();
  if (result) component.updateResult(result, false);
  return component.render(width);
}

test("a stored result renders as the approved one-line meter", () => {
  const lines = renderTool({ result: { content: [{ type: "text", text: storedSentence }], isError: false } });
  assert.deepEqual(lines.map(plain), ["", approvedLine]);
});

test("narrow widths keep one line that fits, with the used percent and what is left as long as they fit", () => {
  for (let width = 1; width <= 120; width++) {
    const lines = renderTool({ result: { content: [{ type: "text", text: storedSentence }], isError: false }, width });
    assert.equal(lines.length, 2, `Expected one meter line at width ${width}. Got: ${JSON.stringify(lines.map(plain))}`);
    assert.ok(visibleWidth(lines[1]) <= width, `Line exceeds width ${width}: ${JSON.stringify(plain(lines[1]))}`);
    if (width >= 22) {
      assert.match(plain(lines[1]), /32% used .*185k left/, `Width ${width} lost the figures: ${JSON.stringify(plain(lines[1]))}`);
    }
  }
});

test("an unexpected result text is shown in full, wrapped instead of dropped", () => {
  const text = "Context usage arrived in a format this renderer does not know: 1,234,567 tokens of an unknown window.\nSecond line.";
  const lines = renderTool({ result: { content: [{ type: "text", text }], isError: false }, width: 40 }).map(plain);
  assert.ok(lines.every((line) => visibleWidth(line) <= 40), `Lines exceed width 40: ${JSON.stringify(lines)}`);
  assert.equal(lines.join(" ").replace(/\s+/g, " ").includes(`Context Meter · ${text.replace(/\s+/g, " ")}`), true, `Text was dropped: ${JSON.stringify(lines)}`);
});

test("an error result shows the label and the error text", () => {
  const lines = renderTool({ result: { content: [{ type: "text", text: "Context usage is unavailable" }], isError: true } }).map(plain);
  assert.deepEqual(lines, ["", "● Context Meter · Context usage is unavailable"]);
});

test("a running call shows only the label, and nothing before execution starts", () => {
  assert.deepEqual(renderTool({ executionStarted: false }), []);
  assert.deepEqual(renderTool({}).map(plain), ["", "● Context Meter"]);
});
