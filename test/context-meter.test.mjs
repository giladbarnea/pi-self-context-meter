import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const contextWindow = 272_000;

test("the package is named pi-self-context-meter", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.name, "@giladbarnea/pi-self-context-meter");
});

test("context_meter reports Pi's context usage against the model's window", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-self-context-meter-"));
  const faux = fauxProvider({ models: [{ id: "faux-context", contextWindow }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(sandbox, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "local-test");
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
  const { session } = await createAgentSession({
    cwd: sandbox,
    agentDir: sandbox,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(sandbox),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });

  let usageSeenByTool;
  session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "context_meter") {
      usageSeenByTool = session.getContextUsage();
    }
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("context_meter", {})),
    fauxAssistantMessage("Noted."),
  ]);

  try {
    const activeToolNames = session.getActiveToolNames();
    assert.ok(activeToolNames.includes("context_meter"), `Expected context_meter among active tools. Got: ${activeToolNames}`);
    assert.ok(!activeToolNames.includes("how_much_context"), `The old name how_much_context must be gone. Got: ${activeToolNames}`);
    await session.prompt("Fill the context window. ".repeat(10_000));

    const toolResult = session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "context_meter",
    );
    assert.ok(toolResult, `Expected a context_meter tool result. Got roles: ${session.messages.map((message) => message.role)}`);
    assert.equal(toolResult.isError, false, `Expected success. Got: ${JSON.stringify(toolResult.content)}`);
    assert.ok(usageSeenByTool?.tokens >= 50_000, `Expected substantial usage from the large prompt. Got: ${JSON.stringify(usageSeenByTool)}`);
    const expectedText = `You have used ${Math.round(usageSeenByTool.tokens / 1_000)}k tokens out of 272k available (used ${Math.round(usageSeenByTool.percent)}%).`;
    assert.deepEqual(toolResult.content, [{ type: "text", text: expectedText }]);
  } finally {
    session.dispose();
    await rm(sandbox, { recursive: true, force: true });
  }
});
