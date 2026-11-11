import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const toolsExamplePath = join(dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))), "examples", "extensions", "tools.ts");

async function startSession(sandbox, sessionManager, { withExtension, tools, savedSelection = false }) {
  const faux = fauxProvider({ models: [{ id: "faux-resume" }] });
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
    additionalExtensionPaths: [...(savedSelection ? [toolsExamplePath] : []), ...(withExtension ? [extensionPath] : [])],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], "Extensions must load without errors");
  const { session } = await createAgentSession({
    cwd: sandbox,
    agentDir: sandbox,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools,
  });
  await session.bindExtensions({});
  return { session, faux };
}

async function saveAndResume(context, { tools, savedSelection = false, recordedRemoval = false } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-self-context-meter-resume-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const sessionManager = SessionManager.create(sandbox, join(sandbox, "sessions"));
  const saved = await startSession(sandbox, sessionManager, { withExtension: recordedRemoval });
  try {
    saved.faux.setResponses([fauxAssistantMessage("Noted."), fauxAssistantMessage("Noted again.")]);
    await saved.session.prompt("Remember this session.");
    if (savedSelection) {
      sessionManager.appendCustomEntry("tools-config", { enabledTools: ["read"] });
      saved.session.setActiveToolsByName(["read"]);
      await saved.session.prompt("Continue with the selected tools.");
    }
    if (recordedRemoval) {
      saved.session.setActiveToolsByName(saved.session.getActiveToolNames().filter((name) => name !== "context_meter"));
      await saved.session.prompt("Continue without the context tool.");
    }
  } finally {
    saved.session.dispose();
  }
  const resumed = await startSession(sandbox, SessionManager.open(sessionManager.getSessionFile()), {
    withExtension: true, tools, savedSelection,
  });
  context.after(() => resumed.session.dispose());
  return resumed;
}

async function callContextMeter({ session, faux }) {
  faux.setResponses([fauxAssistantMessage(fauxToolCall("context_meter", {})), fauxAssistantMessage("Noted.")]);
  await session.prompt("How much context do you have?");
  return session.messages.filter((message) => message.role === "toolResult" && message.toolName === "context_meter").at(-1);
}

test("a session saved before the install resumes with a callable context_meter", async (context) => {
  const resumed = await saveAndResume(context);
  const result = await callContextMeter(resumed);
  assert.equal(result?.isError, false, `Expected a successful call. Got: ${JSON.stringify(result?.content)}`);
});

test("/tree back to before the install keeps context_meter callable", async (context) => {
  const resumed = await saveAndResume(context);
  const firstPrompt = resumed.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
  await resumed.session.reload();
  const before = await callContextMeter(resumed);
  assert.equal(before?.isError, false, `Expected a callable tool before the rewind. Got: ${JSON.stringify(before?.content)}`);
  await resumed.session.navigateTree(firstPrompt.id, { summarize: false });
  const result = await callContextMeter(resumed);
  assert.equal(result?.isError, false, `Expected a successful call after the rewind. Got: ${JSON.stringify(result?.content)}`);
});

test("an SDK removal keeps context_meter off when resuming a pre-install session", async (context) => {
  const { session } = await saveAndResume(context, { tools: ["-context_meter"] });
  assert.equal(session.getActiveToolNames().includes("context_meter"), false, `SDK removal was overridden: ${session.getActiveToolNames()}`);
});

test("a saved /tools selection stays unchanged when resuming a pre-install session", async (context) => {
  const { session } = await saveAndResume(context, { savedSelection: true });
  assert.deepEqual(session.getActiveToolNames(), ["read"], "The extension must respect the saved /tools selection");
});

test("a recorded removal keeps context_meter off on resume", async (context) => {
  const { session } = await saveAndResume(context, { recordedRemoval: true });
  assert.equal(session.getActiveToolNames().includes("context_meter"), false, `Recorded removal was overridden: ${session.getActiveToolNames()}`);
});
