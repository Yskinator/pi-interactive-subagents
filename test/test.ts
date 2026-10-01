import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@mariozechner/pi-tui";
// Must come first: it scrubs the ambient sub-agent env the extension seeds at
// module load (PI_SUBAGENT_ALLOWED). Keep it above every pi-extension import.
import "./hermetic-env.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  countSessionEntryLines,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  nameRegistryPath,
  writeSubagentLoadout,
  loadoutSidecarPath,
  type SubagentLoadout,
  resetSessionIndexCache,
  resolveSessionFileById,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
  summarizeSessionStats,
} from "../pi-extension/subagents/session.ts";

import { shellEscape } from "../pi-extension/subagents/tmux.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  runningChildrenCount,
  __test__ as subagentDoneTest,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/tmux.ts";
import { searchSearxng, formatSearchResults, DEFAULT_SEARXNG_URL, waitForSearchSlot, rlStateFile, getMinIntervalMs } from "../pi-extension/subagents/tools/web-search/index.ts";
import { __test__ as webFetchTest } from "../pi-extension/subagents/tools/web-fetch/index.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("countSessionEntryLines matches getNewEntries(0).length without parsing", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(countSessionEntryLines(file), getNewEntries(file, 0).length);
      assert.equal(countSessionEntryLines(file), 4);
    });

    it("countSessionEntryLines ignores blank lines and returns 0 for missing files", () => {
      const file = join(dir, "blanks.jsonl");
      writeFileSync(file, JSON.stringify({ type: "session", id: "x" }) + "\n\n\n");
      assert.equal(countSessionEntryLines(file), 1);
      assert.equal(countSessionEntryLines(join(dir, "does-not-exist.jsonl")), 0);
    });
  });

  describe("getSessionId / resolveSessionFileById", () => {
    function writeSession(d: string, fname: string, id: string): string {
      const p = join(d, fname);
      writeFileSync(p, JSON.stringify({ type: "session", id, version: 3 }) + "\n");
      return p;
    }

    // The resolver caches an id→file index per root; reset it so each test
    // builds a fresh index from the current on-disk state.
    beforeEach(() => {
      resetSessionIndexCache();
    });

    it("reads the header id from a session file", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getSessionId(file), "sess-001");
    });

    it("returns null for a file without a session header", () => {
      const file = createSessionFile(dir, [USER_MSG]);
      assert.equal(getSessionId(file), null);
    });

    it("resolves a session file by exact id under the root", () => {
      const a = writeSession(dir, "a.jsonl", "019f-aaaa");
      writeSession(dir, "b.jsonl", "019f-bbbb");
      assert.equal(resolveSessionFileById("019f-aaaa", dir), a);
    });

    it("resolves a session file by id prefix", () => {
      const a = writeSession(dir, "p.jsonl", "019f-prefix-match");
      assert.equal(resolveSessionFileById("019f-prefix", dir), a);
    });

    it("returns null when no session matches", () => {
      writeSession(dir, "c.jsonl", "abc");
      assert.equal(resolveSessionFileById("zzz", dir), null);
    });

    it("picks up newly added sessions on repeat calls without a reset", () => {
      // Prime the index (first call builds it).
      writeSession(dir, "first.jsonl", "id-first");
      assert.equal(resolveSessionFileById("id-first", dir) !== null, true);
      // Add a new session AFTER the index was built — no reset. The resolver's
      // cheap refresh should index it.
      const b = writeSession(dir, "second.jsonl", "id-second");
      assert.equal(resolveSessionFileById("id-second", dir), b);
    });
  });

  describe("subagent loadout snapshot", () => {
    const sample: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,edit,safe_bash,web_search,subagent,ask_question",
      model: "openrouter/z-ai/glm-5.2",
      thinking: "medium",
      systemPromptMode: "append",
      identity: "You are a worker agent.",
      spawnable: ["scout", "researcher"],
      autoExit: true,
      cwd: "/work/dir",
      agentDir: "/home/u/.pi/agent",
    };

    it("writes the sidecar next to the session file", () => {
      const sf = join(dir, "s1.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.equal(loadoutSidecarPath(sf), sf + ".loadout.json");
      assert.ok(existsSync(sf + ".loadout.json"));
    });

    it("round-trips the full loadout", () => {
      const sf = join(dir, "s2.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.deepEqual(readSubagentLoadout(sf), sample);
    });

    it("returns null when the sidecar is absent", () => {
      assert.equal(readSubagentLoadout(join(dir, "missing.jsonl")), null);
    });

    it("returns null when the sidecar is corrupt", () => {
      const sf = join(dir, "s3.jsonl");
      writeFileSync(sf + ".loadout.json", "not json{", "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });
  });

  describe("subagent name registry", () => {
    it("registers and resolves a name to its session file", () => {
      const adir = join(dir, "art-1");
      registerName(adir, "worker", { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      const entry = resolveNameInRegistry(adir, "worker");
      assert.deepEqual(entry, { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      assert.ok(existsSync(nameRegistryPath(adir)));
    });

    it("accumulates multiple names and overwrites on re-register", () => {
      const adir = join(dir, "art-2");
      registerName(adir, "scout", { sessionFile: "/s/scout.jsonl", sessionId: "id-scout" });
      registerName(adir, "scout-2", { sessionFile: "/s/scout2.jsonl", sessionId: "id-scout2" });
      const reg = readNameRegistry(adir);
      assert.deepEqual(Object.keys(reg).sort(), ["scout", "scout-2"]);
      // Overwrite scout with a new session file.
      registerName(adir, "scout", { sessionFile: "/s/scout-new.jsonl", sessionId: "id-scout-new" });
      assert.equal(resolveNameInRegistry(adir, "scout")!.sessionFile, "/s/scout-new.jsonl");
    });

    it("returns null for unknown names and {} for a missing/corrupt registry", () => {
      const adir = join(dir, "art-3");
      assert.equal(resolveNameInRegistry(adir, "nope"), null);
      assert.deepEqual(readNameRegistry(adir), {});
      mkdirSync(adir, { recursive: true });
      writeFileSync(nameRegistryPath(adir), "not json{", "utf8");
      assert.deepEqual(readNameRegistry(adir), {});
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("summarizeSessionStats", () => {
    const asstWithUsage = (id: string, opts: {
      model?: string;
      provider?: string;
      tools?: string[];
      usage?: Record<string, unknown>;
    }) => ({
      type: "message",
      id,
      parentId: "user-001",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
        content: [
          { type: "text", text: "ok" },
          ...(opts.tools ?? []).map((name, i) => ({ type: "toolCall", name, id: `${id}-tc${i}` })),
        ],
        ...(opts.usage ? { usage: opts.usage } : {}),
      },
    });

    it("aggregates tokens/cost cumulatively and tracks last context size", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-sonnet-4-6" },
        USER_MSG,
        asstWithUsage("a1", {
          tools: ["read", "grep"],
          usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, totalTokens: 1350, cost: { total: 0.01 } },
        }),
        asstWithUsage("a2", {
          tools: ["write"],
          usage: { input: 30, output: 70, cacheRead: 2000, cacheWrite: 0, totalTokens: 3500, cost: { total: 0.02 } },
        }),
      ]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.model, "claude-sonnet-4-6");
      assert.equal(stats.toolCount, 3);
      assert.equal(stats.inputTokens, 130);
      assert.equal(stats.outputTokens, 120);
      assert.equal(stats.cacheReadTokens, 3000);
      assert.equal(stats.cacheWriteTokens, 200);
      // contextTokens is the LAST assistant turn's totalTokens, not the sum.
      assert.equal(stats.contextTokens, 3500);
      assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);
    });

    it("prefers per-message model over model_change", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-haiku-4-5" },
        asstWithUsage("a1", { model: "claude-sonnet-4-6", usage: { totalTokens: 10, cost: { total: 0 } } }),
      ]);
      assert.equal(summarizeSessionStats(file)!.model, "claude-sonnet-4-6");
    });

    it("captures the provider that pairs with the model", () => {
      // The gauge needs the provider: the same bare id can exist under two
      // providers, and summarizeSessionStats used to discard the sibling field.
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, provider: "llama.cpp", modelId: "qwen3.8-27b" },
        asstWithUsage("a1", { usage: { totalTokens: 10, cost: { total: 0 } } }),
      ]);
      assert.equal(summarizeSessionStats(file)!.model, "qwen3.8-27b");
      assert.equal(summarizeSessionStats(file)!.provider, "llama.cpp");

      // A per-message model wins, and so does its own provider.
      const withMsg = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, provider: "llama.cpp", modelId: "qwen3.8-27b" },
        asstWithUsage("a1", {
          model: "qwen3.8-flash-next",
          provider: "vllm",
          usage: { totalTokens: 10, cost: { total: 0 } },
        }),
      ]);
      assert.equal(summarizeSessionStats(withMsg)!.model, "qwen3.8-flash-next");
      assert.equal(summarizeSessionStats(withMsg)!.provider, "vllm");

      // No provider recorded anywhere stays null (bare-id matching still applies).
      const bare = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "qwen3.8-27b" },
      ]);
      assert.equal(summarizeSessionStats(bare)!.provider, null);
    });

    it("handles missing usage gracefully", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.toolCount, 0);
      assert.equal(stats.inputTokens, 0);
      assert.equal(stats.cost, 0);
      assert.equal(stats.contextTokens, 0);
    });

    it("returns null for an unreadable file", () => {
      assert.equal(summarizeSessionStats(join(dir, "does-not-exist.jsonl")), null);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("bundled scout/researcher/planner/worker/reviewer all resolve as non-interactive (auto-exit)", () => {
    for (const name of ["scout", "researcher", "planner", "worker", "reviewer"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous, auto-exit)`,
      );
    }
    // reviewer is read-only + read-only bash: it may inspect and diff, never modify.
    const reviewer = testApi.loadAgentDefaults("reviewer");
    const tools = new Set((reviewer.tools ?? "").split(",").map((t: string) => t.trim()).filter(Boolean));
    for (const t of ["read", "grep", "find", "ls", "bash"]) {
      assert.ok(tools.has(t), `expected reviewer tool ${t}`);
    }
    for (const t of ["write", "edit"]) {
      assert.ok(!tools.has(t), `reviewer must not have ${t}`);
    }
  });

  it("worker is granted the spawning toolset restricted to scout, planner, and reviewer", () => {
    const worker = testApi.loadAgentDefaults("worker");
    assert.ok(worker, "expected bundled worker to be discoverable");
    assert.deepEqual(worker.subagentAgents, ["scout", "planner", "reviewer"]);

    const allowlist = testApi.buildSubagentToolAllowlist(worker.tools, { grantSpawning: true });
    assert.ok(allowlist, "expected an allowlist");
    const tools = new Set(allowlist!.split(","));
    for (const t of ["subagent", "subagent_message", "subagents_list"]) {
      assert.ok(tools.has(t), `expected spawning tool ${t} in worker allowlist`);
    }
    assert.ok(tools.has("bash"), "expected worker to keep bash");
    // Policy: workers are pure implementers — no web tools of their own.
    assert.ok(!tools.has("web_search"), "worker must not get web_search");
    assert.ok(!tools.has("web_fetch"), "worker must not get web_fetch");
  });

  it("planner is granted the spawning toolset restricted to scout", () => {
    const planner = testApi.loadAgentDefaults("planner");
    assert.ok(planner, "expected bundled planner to be discoverable");
    assert.deepEqual(planner.subagentAgents, ["scout"]);

    const allowlist = testApi.buildSubagentToolAllowlist(planner.tools, { grantSpawning: true });
    assert.ok(allowlist, "expected an allowlist");
    const tools = new Set(allowlist!.split(","));
    for (const t of ["subagent", "subagent_message", "subagents_list"]) {
      assert.ok(tools.has(t), `expected spawning tool ${t} in planner allowlist`);
    }
    // Policy: planner is read-only — it plans, never edits.
    for (const t of ["read", "grep", "find", "ls"]) {
      assert.ok(tools.has(t), `expected planner tool ${t}`);
    }
    for (const t of ["write", "edit", "bash"]) {
      assert.ok(!tools.has(t), `planner must not have ${t}`);
    }
  });

  it("scout, researcher, and reviewer are not granted spawning tools", () => {
    for (const name of ["scout", "researcher", "reviewer"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.subagentAgents, undefined, `${name} should not declare subagent_agents`);
    }
  });

  it("getToolExtensionPath maps custom tools and skips built-ins", () => {
    assert.equal(testApi.getToolExtensionPath("read"), undefined);
    assert.equal(testApi.getToolExtensionPath("bash"), undefined);
    assert.ok(testApi.getToolExtensionPath("web_search")?.endsWith("tools/web-search/index.ts"));
    assert.ok(testApi.getToolExtensionPath("web_fetch")?.endsWith("tools/web-fetch/index.ts"));
    assert.ok(testApi.getToolExtensionPath("safe_bash")?.endsWith("tools/safe-bash.ts"));
    // Spawning tools are registered by this extension itself.
    assert.ok(testApi.getToolExtensionPath("subagent")?.endsWith("index.ts"));
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode from frontmatter (standalone default)", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "fork" }),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,ask_question",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("applySandboxToParts replays model, identity, and default-deny tool restriction", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write,safe_bash",
          model: "openrouter/z-ai/glm-5.2",
          thinking: "medium",
          systemPromptMode: "append",
          identity: "You are a worker.",
          spawnable: ["scout"],
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const joined = parts.join(" ");
      // Model with thinking suffix.
      assert.ok(joined.includes("--model"), "expected --model");
      assert.ok(joined.includes("openrouter/z-ai/glm-5.2:medium"), "expected model:thinking");
      // Identity written to a file and appended.
      assert.ok(joined.includes("--append-system-prompt"), "expected --append-system-prompt");
      // Default-deny restriction.
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      // The value is shell-escaped (single-quoted) before joining.
      assert.ok(
        parts[toolsIdx + 1].includes("read,write,safe_bash"),
        "expected the tool allowlist as the --tools value",
      );
    });
  });

  it("applySandboxToParts omits restriction flags when the loadout was unrestricted", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: null,
          toolAllowlist: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.deepEqual(parts, []);
    });
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("agent_model command (model overrides)", () => {
  const testApi = (subagentsModule as any).__test__;

  afterEach(() => {
    testApi.resetAgentModelOverrides();
    testApi.setInheritedModelOverrides(undefined);
  });

  describe("parseModelOverridesEnv", () => {
    it("parses a valid JSON object into a map", () => {
      const m = testApi.parseModelOverridesEnv(
        '{"worker": "anthropic/claude-sonnet", "scout": "vllm/qwen"}',
      );
      assert.deepEqual(
        m,
        new Map([["worker", "anthropic/claude-sonnet"], ["scout", "vllm/qwen"]]),
      );
    });

    it("returns undefined for unset or empty values", () => {
      assert.equal(testApi.parseModelOverridesEnv(undefined), undefined);
      assert.equal(testApi.parseModelOverridesEnv(""), undefined);
    });

    it("ignores malformed JSON", () => {
      assert.equal(testApi.parseModelOverridesEnv("{not json"), undefined);
      assert.equal(testApi.parseModelOverridesEnv("{}\n{"), undefined);
    });

    it("ignores non-object JSON", () => {
      assert.equal(testApi.parseModelOverridesEnv("[]"), undefined);
      assert.equal(testApi.parseModelOverridesEnv('"str"'), undefined);
      assert.equal(testApi.parseModelOverridesEnv("42"), undefined);
      assert.equal(testApi.parseModelOverridesEnv("null"), undefined);
    });

    it("filters non-string/empty values and drops objects with nothing left", () => {
      assert.equal(
        testApi.parseModelOverridesEnv(JSON.stringify({ a: 1, b: "", c: null })),
        undefined,
      );
      assert.deepEqual(
        testApi.parseModelOverridesEnv(JSON.stringify({ a: 1, b: "p/m" })),
        new Map([["b", "p/m"]]),
      );
    });
  });

  describe("resolution precedence (per-session > inherited > agent default)", () => {
    it("returns undefined with no overrides anywhere", () => {
      assert.equal(testApi.getAgentModelOverride("sess-a", "worker"), undefined);
      assert.equal(testApi.getAgentModelOverride(undefined, "worker"), undefined);
      assert.equal(testApi.getAgentModelOverride("sess-a", undefined), undefined);
      assert.equal(testApi.getAgentModelOverride(undefined, undefined), undefined);
    });

    it("falls back to the inherited snapshot when the session has no entry", () => {
      testApi.setInheritedModelOverrides(new Map([["worker", "vllm/inherited-model"]]));
      assert.equal(testApi.getAgentModelOverride("sess-b", "worker"), "vllm/inherited-model");
      // An undefined session id still sees the inherited snapshot.
      assert.equal(testApi.getAgentModelOverride(undefined, "worker"), "vllm/inherited-model");
      // Agents not in the snapshot are unaffected.
      assert.equal(testApi.getAgentModelOverride("sess-b", "scout"), undefined);
    });

    it("per-session entry wins over the inherited snapshot", () => {
      testApi.setInheritedModelOverrides(new Map([["worker", "vllm/inherited-model"]]));
      testApi.setAgentModelOverride("sess-c", "worker", "anthropic/claude-sonnet");
      assert.equal(testApi.getAgentModelOverride("sess-c", "worker"), "anthropic/claude-sonnet");
      // Other sessions are unaffected and still see the inherited snapshot.
      assert.equal(testApi.getAgentModelOverride("sess-d", "worker"), "vllm/inherited-model");
    });

    it("per-session entries are isolated by session id", () => {
      testApi.setAgentModelOverride("sess-e", "worker", "a/b");
      testApi.setAgentModelOverride("sess-f", "worker", "c/d");
      assert.equal(testApi.getAgentModelOverride("sess-e", "worker"), "a/b");
      assert.equal(testApi.getAgentModelOverride("sess-f", "worker"), "c/d");
      assert.equal(testApi.getAgentModelOverride("sess-g", "worker"), undefined);
    });
  });

  describe("setAgentModelOverride", () => {
    it("stores a qualified ref for the session only", () => {
      testApi.setAgentModelOverride("sess-h", "worker", "anthropic/claude-sonnet");
      assert.equal(testApi.getAgentModelOverride("sess-h", "worker"), "anthropic/claude-sonnet");
      assert.equal(testApi.getAgentModelOverride("sess-h2", "worker"), undefined);
    });

    it("'default' deletes the entry, falling back to inherited then agent default", () => {
      const s = "sess-i";
      testApi.setInheritedModelOverrides(new Map([["worker", "vllm/inherited-model"]]));
      testApi.setAgentModelOverride(s, "worker", "anthropic/claude-sonnet");
      testApi.setAgentModelOverride(s, "worker", "default");
      assert.equal(testApi.getAgentModelOverride(s, "worker"), "vllm/inherited-model");
      // With no inherited snapshot either, resolution falls through to undefined
      // (the caller then uses the agent file default).
      testApi.setInheritedModelOverrides(undefined);
      assert.equal(testApi.getAgentModelOverride(s, "worker"), undefined);
    });

    it("'default' with no existing entry is a no-op", () => {
      testApi.setAgentModelOverride("sess-j", "worker", "default");
      assert.equal(testApi.getAgentModelOverride("sess-j", "worker"), undefined);
      assert.deepEqual(testApi.getMergedModelOverrides("sess-j"), {});
    });
  });

  describe("getMergedModelOverrides (spawn/resume env emission)", () => {
    it("returns {} when there are no overrides", () => {
      assert.deepEqual(testApi.getMergedModelOverrides("sess-k"), {});
    });

    it("includes only the inherited snapshot when the session has no entries", () => {
      testApi.setInheritedModelOverrides(new Map([["worker", "vllm/x"]]));
      assert.deepEqual(testApi.getMergedModelOverrides("sess-l"), { worker: "vllm/x" });
    });

    it("merges inherited + per-session with per-session winning", () => {
      testApi.setInheritedModelOverrides(
        new Map([
          ["worker", "vllm/inherited-worker"],
          ["scout", "vllm/inherited-scout"],
        ]),
      );
      const s = "sess-m";
      testApi.setAgentModelOverride(s, "worker", "anthropic/claude-sonnet");
      assert.deepEqual(testApi.getMergedModelOverrides(s), {
        worker: "anthropic/claude-sonnet",
        scout: "vllm/inherited-scout",
      });
      // The JSON round-trip used for env emission is stable.
      const emitted = JSON.stringify(testApi.getMergedModelOverrides(s));
      const parsed = testApi.parseModelOverridesEnv(emitted);
      assert.ok(parsed);
      assert.deepEqual(Object.fromEntries(parsed), testApi.getMergedModelOverrides(s));
    });
  });

  describe("command registration and handler", () => {
    const fakeTheme: any = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const tick = () => new Promise((r) => setTimeout(r, 0));

    function makeCtx(overrides: {
      hasUI?: boolean;
      models?: Array<{ provider: string; id: string }>;
      sessionId?: string;
    }) {
      const notifications: Array<[string, string?]> = [];
      const comps: any[] = [];
      return {
        ctx: {
          hasUI: overrides.hasUI ?? false,
          ui: {
            notify: (msg: string, type?: string) => notifications.push([msg, type]),
            custom: (factory: any) =>
              new Promise((resolve) => {
                const comp = factory(null, fakeTheme, null, (v: string | undefined) => resolve(v));
                comps.push(comp);
              }),
          },
          modelRegistry: {
            getAvailable: () =>
              overrides.models ?? [
                { provider: "vllm", id: "qwen" },
                { provider: "anthropic", id: "claude-sonnet" },
              ],
          },
          sessionManager: { getSessionId: () => overrides.sessionId ?? "am-sess" },
        },
        notifications,
        comps,
      };
    }

    /**
     * Register the extension in an isolated agent env and hand the test the
     * command plus a visible agent name. The visible set depends on
     * PI_SUBAGENT_ALLOWED (seeded at module load from the ambient env), so
     * pick whatever is visible here and shadow it with a project file that
     * pins the default model — deterministic in every environment.
     */
    async function withAgentModelCommand(
      fn: (cmd: any, agentName: string) => Promise<void> | void,
    ) {
      await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
        const { api, registeredCommands } = createMockExtensionApi();
        (subagentsModule as any).default(api);
        const cmd = registeredCommands.find((c: any) => c.name === "agent_model");
        assert.ok(cmd, "expected agent_model to be registered");
        const visible = (cmd.getArgumentCompletions("") ?? []).map((i: any) => i.value);
        if (visible.length === 0) return; // no discoverable agents in this env
        const agentName = visible[0];
        writeAgentFile(
          projectAgentsDir,
          agentName,
          `name: ${agentName}\nmodel: vllm/agent-default`,
        );
        await fn(cmd, agentName);
      });
    }

    it("registers agent_model next to subagent with completions", () => {
      const { api, registeredCommands } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const names = registeredCommands.map((c: any) => c.name);
      assert.ok(names.includes("subagent"), "subagent command should be registered");
      const cmd = registeredCommands.find((c: any) => c.name === "agent_model");
      assert.ok(cmd, "agent_model command should be registered");
      assert.match(cmd.description, /model/);
      assert.equal(typeof cmd.getArgumentCompletions, "function");
      assert.equal(typeof cmd.handler, "function");
    });

    it("completes the first argument with discovered agent names", async () => {
      await withAgentModelCommand((cmd, agentName) => {
        const items = cmd.getArgumentCompletions(agentName.slice(0, 3));
        assert.ok(
          items?.some((i: any) => i.value === agentName),
          "agent name should be offered for its prefix",
        );
        // No match -> null (fall back to other providers)
        assert.equal(cmd.getArgumentCompletions("zzz-no-such"), null);
      });
    });

    it("applies the full form /agent_model <agent> <model> in non-TUI mode", async () => {
      await withAgentModelCommand(async (cmd, agentName) => {
        const { ctx, notifications } = makeCtx({ hasUI: false, sessionId: "am-sess-1" });

        // Bare model id resolves to its provider.
        await cmd.handler(`${agentName} qwen`, ctx);
        assert.equal(testApi.getAgentModelOverride("am-sess-1", agentName), "vllm/qwen");

        // Unknown model -> error notification, override unchanged.
        await cmd.handler(`${agentName} no/such-model`, ctx);
        assert.equal(testApi.getAgentModelOverride("am-sess-1", agentName), "vllm/qwen");
        const err = notifications[notifications.length - 1];
        assert.deepEqual(err, [`Unknown model "no/such-model".`, "error"]);

        // Qualified ref passes through.
        await cmd.handler(`${agentName} anthropic/claude-sonnet`, ctx);
        assert.equal(
          testApi.getAgentModelOverride("am-sess-1", agentName),
          "anthropic/claude-sonnet",
        );

        // "default" clears the override (agent default is then used).
        await cmd.handler(`${agentName} default`, ctx);
        assert.equal(testApi.getAgentModelOverride("am-sess-1", agentName), undefined);
        assert.match(
          notifications[notifications.length - 1][0],
          /default model \(vllm\/agent-default\)/,
        );
      });
    });

    it("rejects unknown agents and requires TUI mode for the pickers", async () => {
      await withAgentModelCommand(async (cmd, agentName) => {
        const { ctx, notifications } = makeCtx({ hasUI: false, sessionId: "am-sess-2" });

        await cmd.handler("zzz-no-such-agent", ctx);
        const err = notifications[notifications.length - 1];
        assert.equal(err[1], "error");
        assert.match(err[0], /Unknown agent "zzz-no-such-agent"/);
        assert.match(err[0], new RegExp(agentName));

        // Agent given but no model -> TUI usage warning.
        await cmd.handler(agentName, ctx);
        const warn1 = notifications[notifications.length - 1];
        assert.equal(warn1[1], "warning");
        assert.match(warn1[0], /requires TUI mode/);

        // No args at all -> TUI usage warning.
        await cmd.handler("", ctx);
        const warn2 = notifications[notifications.length - 1];
        assert.equal(warn2[1], "warning");
        assert.match(warn2[0], /requires TUI mode/);
      });
    });

    it("runs the two-stage picker flow in TUI mode (agent picker -> model picker)", async () => {
      await withAgentModelCommand(async (cmd, agentName) => {
        const { ctx, comps, notifications } = makeCtx({ hasUI: true, sessionId: "am-sess-3" });

        const p = cmd.handler("", ctx);
        await tick();
        const stage1 = comps[0];
        assert.ok(stage1, "stage-1 agent picker should be open");
        const agentIndex = stage1.items.findIndex((it: any) => it.label === agentName);
        assert.ok(agentIndex >= 0, "agent should appear in the picker");
        for (let i = 0; i < agentIndex; i++) stage1.handleInput("\x1b[B"); // down
        stage1.handleInput("\r"); // enter

        await tick();
        const stage2 = comps[1];
        assert.ok(stage2, "stage-2 model picker should be open");
        // Items: [default, ...sorted models] — sorted by "provider/id".
        assert.deepEqual(
          stage2.items.map((it: any) => it.value),
          ["default", "anthropic/claude-sonnet", "vllm/qwen"],
        );
        // No existing override: "default" is preselected (index 0).
        stage2.handleInput("\x1b[B"); // down -> claude-sonnet
        stage2.handleInput("\r"); // enter

        await p;
        assert.equal(
          testApi.getAgentModelOverride("am-sess-3", agentName),
          "anthropic/claude-sonnet",
        );
        assert.match(
          notifications[notifications.length - 1][0],
          /anthropic\/claude-sonnet/,
        );
      });
    });

    it("preselects the current effective model and honours esc cancel", async () => {
      await withAgentModelCommand(async (cmd, agentName) => {
        // Existing session override -> preselected in the model picker.
        testApi.setAgentModelOverride("am-sess-4", agentName, "vllm/qwen");
        const { ctx, comps, notifications } = makeCtx({ hasUI: true, sessionId: "am-sess-4" });

        const p = cmd.handler(agentName, ctx); // agent given -> straight to stage 2
        await tick();
        const stage2 = comps[0];
        assert.ok(stage2, "model picker should be open directly");
        const lines = stage2.render(100);
        const selectedLine = lines.find((l: string) => l.startsWith("> "));
        assert.ok(selectedLine, "a row should be preselected");
        assert.match(selectedLine, /qwen/);

        stage2.handleInput("\x1b"); // esc cancels
        await p;
        // Override untouched, no notifications.
        assert.equal(testApi.getAgentModelOverride("am-sess-4", agentName), "vllm/qwen");
        assert.equal(notifications.length, 0);
      });
    });

    it("picking 'default' in the model picker clears the override", async () => {
      await withAgentModelCommand(async (cmd, agentName) => {
        testApi.setAgentModelOverride("am-sess-5", agentName, "vllm/qwen");
        const { ctx, comps, notifications } = makeCtx({ hasUI: true, sessionId: "am-sess-5" });

        // Items: [default, claude-sonnet, qwen]; the override preselects
        // qwen (index 2). Down wraps to "default" (index 0); enter confirms.
        const p = cmd.handler(agentName, ctx);
        await tick();
        const stage2 = comps[0];
        assert.ok(stage2);
        stage2.handleInput("\x1b[B"); // down (wraps to "default")
        stage2.handleInput("\r"); // enter

        await p;
        assert.equal(testApi.getAgentModelOverride("am-sess-5", agentName), undefined);
        assert.match(
          notifications[notifications.length - 1][0],
          /default model \(vllm\/agent-default\)/,
        );
      });
    });

    it("labels stage-1 agent hints by override source (session vs inherited)", async () => {
      await withAgentModelCommand(async (cmd, agentName) => {
        const s = "am-sess-6";
        const { ctx, comps } = makeCtx({ hasUI: true, sessionId: s });

        // No override anywhere: agent file default hint.
        let p = cmd.handler("", ctx);
        await tick();
        let stage1 = comps[0];
        assert.ok(stage1);
        let item = stage1.items.find((it: any) => it.label === agentName);
        assert.ok(item);
        assert.equal(item.hint, "model: vllm/agent-default (default)");
        stage1.handleInput("\x1b"); // esc cancels
        await p;

        // Inherited spawner snapshot only: labelled as inherited.
        testApi.setInheritedModelOverrides(
          new Map([[agentName, "vllm/inherited-model"]]),
        );
        p = cmd.handler("", ctx);
        await tick();
        stage1 = comps[1];
        assert.ok(stage1);
        item = stage1.items.find((it: any) => it.label === agentName);
        assert.ok(item);
        assert.equal(
          item.hint,
          "model: vllm/inherited-model (inherited from spawner)",
        );
        stage1.handleInput("\x1b");
        await p;

        // Per-session entry: labelled as a session override.
        testApi.setAgentModelOverride(s, agentName, "anthropic/claude-sonnet");
        p = cmd.handler("", ctx);
        await tick();
        stage1 = comps[2];
        assert.ok(stage1);
        item = stage1.items.find((it: any) => it.label === agentName);
        assert.ok(item);
        assert.equal(
          item.hint,
          "model: anthropic/claude-sonnet (session override)",
        );
        stage1.handleInput("\x1b");
        await p;
      });
    });

    it("keeps the selection visible when the model list overflows the window", async () => {
      await withAgentModelCommand(async (cmd, agentName) => {
        const models = Array.from({ length: 20 }, (_, i) => ({
          provider: "vllm",
          id: `model-${String(i).padStart(2, "0")}`,
        }));
        const { ctx, comps } = makeCtx({ hasUI: true, sessionId: "am-sess-7", models });

        const p = cmd.handler(agentName, ctx);
        await tick();
        const stage2 = comps[0];
        assert.ok(stage2);
        assert.equal(stage2.items.length, 21); // default + 20 sorted models

        // Selection starts at "default" (index 0); walk to the last item.
        for (let i = 0; i < 20; i++) stage2.handleInput("\x1b[B"); // down

        const lines = stage2.render(100);
        const selectedLine = lines.find((l: string) => l.startsWith("> "));
        assert.ok(
          selectedLine,
          "the selected row must stay visible while scrolling",
        );
        assert.match(selectedLine, /model-19/);
        assert.ok(!lines.includes("  default"), "'default' should have scrolled out");

        stage2.handleInput("\r"); // enter
        await p;
        assert.equal(
          testApi.getAgentModelOverride("am-sess-7", agentName),
          "vllm/model-19",
        );
      });
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("runningChildrenCount", () => {
    const KEY = Symbol.for("pi-subagents/running-children-count");
    function withGlobal(value: unknown, run: () => void) {
      const prev = (globalThis as any)[KEY];
      (globalThis as any)[KEY] = value;
      try {
        run();
      } finally {
        (globalThis as any)[KEY] = prev;
      }
    }

    it("returns 0 when the spawning tools aren't loaded (no global)", () => {
      withGlobal(undefined, () => {
        assert.equal(runningChildrenCount(), 0);
      });
    });

    it("reflects the live child count published by index.ts", () => {
      withGlobal(() => 3, () => {
        assert.equal(runningChildrenCount(), 3);
      });
    });

    it("treats zero/negative/non-number/throwing getters as 0", () => {
      withGlobal(() => 0, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => -1, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => "two", () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => { throw new Error("boom"); }, () => assert.equal(runningChildrenCount(), 0));
    });
  });

  describe("ask_question tool", () => {
    function setupSubagentExtension(sessionFile: string) {
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      const mock = createMockExtensionApi();
      subagentDoneExtension(mock.api);
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { mock, restore };
    }

    it("registers ask_question (and no caller_ping) with a single freeform question param", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"));
        assert.ok(!names.includes("caller_ping"));
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
        assert.match(tool.description, /orchestrator/i);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes a .ask signal with name/agent/question while it blocks, and does NOT shut the session down", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = { shutdown() { shutdownCalled = true; } } as any;

        await withAskTimings({ pollMs: 25, timeoutMs: 150 }, async () => {
          // .ask is written synchronously when the call starts, before the
          // blocking wait loop.
          const pending = tool.execute("call-1", { question: "Which API base URL?" }, undefined, undefined, ctx);
          const askFile = `${sessionFile}.ask`;
          assert.ok(existsSync(askFile), ".ask signal file should be written");
          const payload = JSON.parse(readFileSync(askFile, "utf-8"));
          assert.equal(payload.question, "Which API base URL?");
          assert.equal(payload.name, "scout-2");
          assert.equal(payload.agent, "scout");

          // No reply arrives — the call times out instead of hanging.
          const out = await pending;
          assert.match(out.content[0].text, /No reply from the orchestrator within/);
          assert.equal(shutdownCalled, false, "ask_question must keep the session open");
          // No .exit sidecar — the session is not exiting.
          assert.ok(!existsSync(`${sessionFile}.exit`));
        });
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("blocks until the reply file appears, returns it as the tool result, and removes both sidecars", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = { shutdown() { shutdownCalled = true; } } as any;

        await withAskTimings({ pollMs: 25 }, async () => {
          const pending = tool.execute("call-1", { question: "Which API base URL?" }, undefined, undefined, ctx);
          // The orchestrator replies ~100ms later (parent writes the reply file).
          setTimeout(() => writeFileSync(`${sessionFile}.ask-reply`, "Use https://api.example.com"), 100);
          const out = await pending;
          assert.equal(out.content[0].text, "Use https://api.example.com", "the reply IS the tool result");
          assert.deepEqual(out.details, { question: "Which API base URL?", replied: true });
          assert.equal(shutdownCalled, false, "ask_question must keep the session open");
          assert.ok(!existsSync(`${sessionFile}.ask`), ".ask is removed after the reply is consumed");
          assert.ok(!existsSync(`${sessionFile}.ask-reply`), "reply file is removed after the reply is consumed");
        });
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("deletes a stale reply file at start so an old answer is never returned", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        // Leftover reply from a previous question cycle.
        writeFileSync(`${sessionFile}.ask-reply`, "STALE-REPLY");
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        const ctx = { shutdown() {} } as any;

        await withAskTimings({ pollMs: 25 }, async () => {
          const pending = tool.execute("call-1", { question: "v1 or v2?" }, undefined, undefined, ctx);
          // The real reply arrives later; only it may be returned.
          setTimeout(() => writeFileSync(`${sessionFile}.ask-reply`, "Use v2"), 100);
          const out = await pending;
          assert.equal(out.content[0].text, "Use v2", "the stale reply must never be returned");
        });
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("times out: no-reply text, .ask removed, and the awaiting flag cleared", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile);
      try {
        emit("agent_start");
        await withAskTimings({ pollMs: 25, timeoutMs: 150 }, async () => {
          const out = await ask();
          assert.match(out.content[0].text, /No reply from the orchestrator within/);
          assert.match(out.content[0].text, /Proceed with your best judgment/);
          assert.equal(out.details.replied, false);
          assert.ok(!existsSync(`${sessionFile}.ask`), "timeout removes the .ask signal");
        });
        // The flag must have been cleared: the question cycle is over, so
        // agent_end exits instead of parking as `waiting`.
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, true, "after the ask timeout, agent_end should exit, not park");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // The tool call blocks while it waits for the orchestrator's reply, so
    // keep the wait short in tests (overridable via subagentDoneTest).
    function withAskTimings(overrides: { pollMs?: number; timeoutMs?: number }, run: () => Promise<void>) {
      const pollMs = subagentDoneTest.askQuestion.pollMs;
      const timeoutMs = subagentDoneTest.askQuestion.timeoutMs;
      Object.assign(subagentDoneTest.askQuestion, overrides);
      return run().finally(() => {
        subagentDoneTest.askQuestion.pollMs = pollMs;
        subagentDoneTest.askQuestion.timeoutMs = timeoutMs;
      });
    }

    // Blocking-semantics regression tests: while the tool is blocked the
    // session must park (not exit) at agent_end, and once the reply (or
    // timeout) is consumed the flag is cleared INSIDE the tool — the reply
    // does not start a new turn, so no input/agent_start clear can fire.
    function setupCapturingExtension(sessionFile: string) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) { tools.push(t); },
        registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
        sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      subagentDoneExtension(api);
      const emit = (event: string, ...args: any[]) =>
        (handlers.get(event) ?? []).forEach((h) => h(...args));
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      const ask = (signal?: AbortSignal) => {
        const tool = tools.find((t) => t.name === "ask_question");
        return tool.execute("c1", { question: "v1 or v2?" }, signal, undefined, { shutdown() {} });
      };
      return { emit, ask, restore };
    }

    it("exits (does not park) once the reply is consumed as the tool result", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile);
      try {
        emit("agent_start");
        await withAskTimings({ pollMs: 25 }, async () => {
          const pending = ask(); // blocks mid-run with awaitingAnswer set
          // Reply arrives while the tool is still blocked; the tool returns it.
          writeFileSync(`${sessionFile}.ask-reply`, "Use v1");
          const out = await pending;
          assert.equal(out.content[0].text, "Use v1");
          let shutdown = false;
          emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
          assert.equal(shutdown, true, "reply consumed in-turn → agent_end should exit, not park");
        });
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks as waiting at agent_end while the reply is still pending", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile);
      try {
        emit("agent_start");
        await withAskTimings({ pollMs: 25 }, async () => {
          const pending = ask(); // blocks; awaitingAnswer set, no reply yet
          // The orchestrator has not replied — the session must not exit.
          let shutdown = false;
          emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
          assert.equal(shutdown, false, "pending question with no reply must park, not exit");
          // The reply arrives; the tool consumes it, then the turn may exit.
          writeFileSync(`${sessionFile}.ask-reply`, "Use v2");
          await pending;
          let shutdown2 = false;
          emit("agent_end", { messages: [] }, { shutdown() { shutdown2 = true; } });
          assert.equal(shutdown2, true, "after the reply was consumed, agent_end should exit");
        });
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("aborts while waiting: throws, unlinks the .ask signal, and the next agent_start clears the flag", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile);
      try {
        emit("agent_start");
        const ac = new AbortController();
        const pending = ask(ac.signal).then(
          () => assert.fail("execute should throw on abort"),
          (err: any) => err,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        ac.abort();
        const err = await pending;
        assert.match(err.message, /Interrupted while waiting for the orchestrator reply/);
        // The abort path must unlink `.ask`: the child is no longer waiting,
        // so the file no longer represents a pending question. Left behind,
        // the parent's existsSync routing would swallow the orchestrator's
        // next subagent_message (naturally the reply to this question) into
        // the `.ask-reply` sidecar.
        assert.ok(!existsSync(`${sessionFile}.ask`), "abort unlinks the .ask signal");
        // The abort path leaves the flag set — agent_end parks defensively...
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "aborted wait with the flag set must park, not exit");
        // ...and the next turn's agent_start clears it, resuming auto-exit.
        emit("agent_start");
        let shutdown2 = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown2 = true; } });
        assert.equal(shutdown2, true, "agent_start clears the flag → exit resumes");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a reply that lands just before the abort is preserved, not discarded", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile);
      try {
        emit("agent_start");
        const ac = new AbortController();
        await withAskTimings({ pollMs: 25, timeoutMs: 500 }, async () => {
          const pending = ask(ac.signal);
          // The orchestrator's reply lands, then the abort fires — both
          // before the next poll. The loop checks the reply FIRST, so the
          // just-arrived answer wins over the abort.
          setTimeout(() => writeFileSync(`${sessionFile}.ask-reply`, "the answer"), 30);
          setTimeout(() => ac.abort(), 31);
          const out = await pending;
          assert.equal(out.content[0].text, "the answer", "the just-arrived reply is preserved");
          assert.equal(out.details.replied, true);
          assert.ok(!existsSync(`${sessionFile}.ask`), "sidecars cleaned up on consumption");
          assert.ok(!existsSync(`${sessionFile}.ask-reply`), "sidecars cleaned up on consumption");
        });
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a reply that lands just before the timeout is consumed, not orphaned", async () => {
      // The timeout branch does ONE FINAL read before giving up, so a reply
      // that is on disk by the time the timeout fires is returned as the
      // tool result instead of being orphaned (and later purged as a stale
      // reply by the next question cycle). The sub-millisecond window
      // between the poll's read and the timeout branch's return is the same
      // final read — not unit-testable on real timers.
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile);
      try {
        emit("agent_start");
        await withAskTimings({ pollMs: 10, timeoutMs: 60 }, async () => {
          const pending = ask();
          // The reply lands between polls, shortly before the timeout.
          setTimeout(() => writeFileSync(`${sessionFile}.ask-reply`, "late but in time"), 45);
          const out = await pending;
          assert.equal(out.content[0].text, "late but in time", "the reply is consumed, not the no-reply note");
          assert.equal(out.details.replied, true);
          assert.ok(!existsSync(`${sessionFile}.ask`), ".ask removed");
          assert.ok(!existsSync(`${sessionFile}.ask-reply`), "reply file removed");
        });
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ignores a reply whose askedAt does not match its own question cycle", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile);
      try {
        emit("agent_start");
        await withAskTimings({ pollMs: 25, timeoutMs: 400 }, async () => {
          const pending = ask();
          const askPayload = JSON.parse(readFileSync(`${sessionFile}.ask`, "utf8"));
          // The parent echoes askedAt from the .ask file into the reply. A
          // reply carrying a DIFFERENT askedAt belongs to another question
          // cycle (a stale .ask outlived its child) — dropped, not returned.
          writeFileSync(`${sessionFile}.ask-reply`, JSON.stringify({ askedAt: 1, text: "stale answer" }));
          // The real reply arrives for THIS cycle.
          setTimeout(() => {
            writeFileSync(`${sessionFile}.ask-reply`, JSON.stringify({ askedAt: askPayload.askedAt, text: "the real answer" }));
          }, 100);
          const out = await pending;
          assert.equal(out.content[0].text, "the real answer", "only the matching-cycle reply is returned");
          assert.ok(!existsSync(`${sessionFile}.ask`), "sidecars cleaned up on consumption");
          assert.ok(!existsSync(`${sessionFile}.ask-reply`), "sidecars cleaned up on consumption");
        });
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("watcher notifies once per question (content-keyed dedupe, file lingers)", () => {
      const testApi = (subagentsModule as any).__test__;
      const mock = createMockExtensionApi();
      (subagentsModule as any).default(mock.api); // installs latestPi for sendMessage
      const dir = createTestDir();
      try {
        const sessionFile = join(dir, "s.jsonl");
        const running = { name: "scout-2", agent: "scout", startTime: Date.now(), sessionFile } as any;
        const questions = () =>
          mock.sentMessages.filter((m: any) => m.message?.customType === "subagent_question");

        writeFileSync(`${sessionFile}.ask`, JSON.stringify({ name: "scout-2", agent: "scout", question: "q1?", askedAt: 1 }));
        testApi.deliverPendingQuestion(running);
        testApi.deliverPendingQuestion(running); // unchanged lingering file → no re-notify
        assert.equal(questions().length, 1, "one notification per question");

        // A re-ask (new askedAt) — e.g. after an aborted wait left the old file
        // in place — notifies again.
        writeFileSync(`${sessionFile}.ask`, JSON.stringify({ name: "scout-2", agent: "scout", question: "q2?", askedAt: 2 }));
        testApi.deliverPendingQuestion(running);
        assert.equal(questions().length, 2, "a new question re-notifies");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("gives up on a .ask that keeps failing to parse (unlinked after N ticks)", () => {
      const testApi = (subagentsModule as any).__test__;
      const mock = createMockExtensionApi();
      (subagentsModule as any).default(mock.api); // installs latestPi for sendMessage
      const dir = createTestDir();
      try {
        const sessionFile = join(dir, "s.jsonl");
        const running = { name: "scout-2", agent: "scout", startTime: Date.now(), sessionFile } as any;
        writeFileSync(`${sessionFile}.ask`, "{ not valid json");
        testApi.deliverPendingQuestion(running);
        testApi.deliverPendingQuestion(running);
        assert.ok(existsSync(`${sessionFile}.ask`), "a few bad ticks are tolerated (the child may still be writing)");
        // Third consecutive parse failure → give up and unlink, so the
        // file neither clogs the loop nor keeps steering replies into the
        // sidecar.
        testApi.deliverPendingQuestion(running);
        assert.ok(!existsSync(`${sessionFile}.ask`), "give up after 3 consecutive parse failures");
        const questions = mock.sentMessages.filter((m: any) => m.message?.customType === "subagent_question");
        assert.equal(questions.length, 0, "no notification for a malformed .ask");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("tmux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("no longer decodes ping payloads (ask_question keeps the session open instead)", () => {
    // ask_question writes a `.ask` signal, not a `.exit` ping sidecar, so an
    // unknown `type: "ping"` payload now falls through to a clean done.
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      { reason: "done", exitCode: 0 },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("commands", () => {
  it("/subagent emits a spawn tool call for a known agent", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const subagent = registeredCommands.find((command) => command.name === "subagent");
    assert.ok(subagent, "expected /subagent to be registered");

    subagent.handler("scout map the auth code", {
      ui: { notify() {} },
    });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /agent: "scout"/);
    assert.match(sentUserMessages[0], /map the auth code/);
  });

  it("does not register the removed /iterate or /plan commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(registeredCommands.find((c) => c.name === "iterate"), undefined);
    assert.equal(registeredCommands.find((c) => c.name === "plan"), undefined);
  });
});

describe("tool registration", () => {
  it("always resumes subagents as autonomous (auto-exit, non-interactive tracking)", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior(), {
      autoExit: true,
      interactive: false,
    });
  });


  it("rejects a top-level spawn with no agent and no chain", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", { name: "x", task: "do it" });
    assert.equal(result.details?.error, "agent+task or chain required");
    assert.match(result.content[0].text, /specify which agent/i);
    assert.match(result.content[0].text, /chain/i);
  });

  it("rejects a top-level spawn naming an unknown agent", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", {
      name: "x",
      task: "do it",
      agent: "wizard",
    });
    assert.equal(result.details?.error, "unknown agent");
    assert.match(result.content[0].text, /not a known agent/i);
  });

  it("exposes a debloated schema: agent/task optional (chain alternative), no override knobs", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const props = subagentTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["agent", "chain", "cwd", "model", "name", "task"],
      "only agent/task/name/model/cwd/chain should remain",
    );
    // Nothing is required at the schema level: the tool requires agent+task
    // (single mode) or a non-empty chain and validates that itself.
    assert.deepEqual(
      [...(subagentTool.parameters.required ?? [])].sort(),
      [],
      "mode is validated in execute (agent+task or chain)",
    );
    // `name` is optional and purely cosmetic.
    assert.match(props.name.description, /cosmetic/i);
    // Chain steps require agent + task and document the automatic hand-off.
    const stepProps = props.chain.items.properties;
    assert.deepEqual(
      Object.keys(stepProps).sort(),
      ["agent", "cwd", "model", "name", "task"],
      "chain steps take agent/task + the usual per-spawn options",
    );
    assert.deepEqual(
      [...(props.chain.items.required ?? [])].sort(),
      ["agent", "task"],
      "each chain step must have an agent and a task",
    );
    assert.match(stepProps.task.description, /appended/i);
    // The removed override knobs must be gone.
    for (const gone of ["tools", "skills", "systemPrompt", "fork", "interactive", "resumeSessionId"]) {
      assert.equal(props[gone], undefined, `expected ${gone} param to be removed`);
    }
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with name + message both required (name-only addressing)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const props = messageTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["message", "name"],
      "only name/message should remain (sessionId dropped)",
    );
    assert.equal(props.message.type, "string");
    assert.equal(props.name.type, "string");
    assert.deepEqual(
      messageTool.parameters.required?.slice().sort(),
      ["message", "name"],
      "name and message should both be required",
    );
    assert.equal(props.sessionId, undefined, "sessionId should be removed");
    assert.equal(props.autoExit, undefined, "autoExit knob should be removed");
  });

  it("no longer registers subagent_interrupt or subagent_resume", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });
});

describe("subagent chain", () => {
  const testApi = (subagentsModule as any).__test__;

  function chainSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  let sessionDir: string;
  let sessionId: string;

  // startChain reads PI_SUBAGENT_AGENT per call for its self-spawn guard and
  // PI_SUBAGENT_ALLOWED for the allowlist guard, and both reject the chain
  // before registering it — which would leave getChainMapForSession() empty for
  // every orchestration test below. Run each test as a plain top-level session
  // and hand back whatever the environment held beforehand in afterEach, so a
  // test that sets one of them itself cannot leak into the next one. (The
  // module-load half of PI_SUBAGENT_ALLOWED is handled by ./hermetic-env.ts,
  // which normally means these snapshot as unset.)
  const saved = {
    agent: process.env.PI_SUBAGENT_AGENT,
    allowed: process.env.PI_SUBAGENT_ALLOWED,
  };

  beforeEach(() => {
    sessionDir = createTestDir();
    sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    delete process.env.PI_SUBAGENT_AGENT;
    delete process.env.PI_SUBAGENT_ALLOWED;
  });

  afterEach(() => {
    restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
    restoreEnvVar("PI_SUBAGENT_ALLOWED", saved.allowed);
    testApi.stopTimersForTest();
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {}
  });

  function mockCtx() {
    return {
      sessionManager: {
        getSessionFile: () => join(sessionDir, "session.jsonl"),
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
      },
      cwd: sessionDir,
    } as any;
  }

  /** A fake RunningSubagent registered in runningSubagents so steering can resolve it. */
  function makeFakeRunning(name: string) {
    const fake: any = {
      id: `fake-${Math.random().toString(36).slice(2)}`,
      name,
      surface: "%stub",
      startTime: Date.now(),
      sessionFile: join(sessionDir, `sub-${name}.jsonl`),
      interactive: false,
    };
    fake.statusState = createStatusState({ source: "pi", startTimeMs: fake.startTime });
    return fake;
  }

  // ── buildChainStepTask: automatic output hand-off ──

  it("returns the task unchanged for the first step (no previous output)", () => {
    assert.equal(testApi.buildChainStepTask("do the thing", null), "do the thing");
  });

  it("appends the previous step's output to the next step's task", () => {
    const task = testApi.buildChainStepTask("review the implementation", {
      agent: "worker",
      stepIndex: 1,
      output: "## Changes Made\n- added X",
    });
    assert.ok(task.startsWith("review the implementation"), "the step's own task comes first");
    assert.ok(task.includes("## Output from previous step (step 1: worker)"));
    assert.ok(task.endsWith("## Changes Made\n- added X"));
    // The caller never supplies a {previous} placeholder.
    assert.ok(!task.includes("{previous}"));
  });

  it("does not append anything when the previous output is empty", () => {
    const task = testApi.buildChainStepTask("next step", {
      agent: "worker",
      stepIndex: 1,
      output: "   ",
    });
    assert.equal(task, "next step");
  });

  // ── buildChainContextBlock: the step's position, as a system-prompt block ──
  // Descriptive: the block names the chain, its other steps, the fact that any
  // later steps run on their own, and one consequence of that hand-off (only the
  // last step's final message reaches the orchestrator). It never restricts
  // spawning.

  it("tells a chain step its position, role, and the full chain sequence", () => {
    const block = testApi.buildChainContextBlock({
      chainName: "fix-auth",
      stepIndex: 2,
      stepTotal: 3,
      agent: "reviewer",
      sequence: "worker → reviewer → worker",
    });
    assert.ok(block.startsWith("## Chain context\n"), "heading comes first");
    assert.match(block, /step 2 of 3 in the sub-agent chain `fix-auth`/, "position within the chain");
    assert.match(block, /agent role is `reviewer`/, "its own role");
    assert.match(block, /chain sequence is `worker → reviewer → worker`/, "the whole sequence");
    // Both clauses of the hand-off line are qualified with "any". The same
    // sentence is emitted for step 1 (no earlier steps exist) and for the last
    // step (no later steps exist), so it must not read as asserting that such
    // peers are always there on both sides.
    assert.ok(block.length > 0, "the block must not be empty — a blank block must fail every match below");
    assert.match(block, /Any earlier steps have already run/, "earlier steps ran, if the chain has any");
    assert.match(
      block,
      /any later steps run automatically after you and receive your final message/,
      "later steps run on their own and get this step's output, if the chain has any",
    );
    assert.match(
      block,
      /sees only the final step's final message, so pass along anything the orchestrator should know from earlier steps/,
      "the orchestrator only sees the last step's final message",
    );
    assert.ok(block.includes("worker") && block.includes("reviewer"), "peers are named");
    // Rides along in a system prompt: no trailing whitespace, no blank runs.
    assert.equal(block, block.trimEnd(), "no trailing whitespace");
    assert.ok(!block.includes("\n\n\n"), "no double blank lines");
  });

  it("states the chain facts without any prohibitive or enforcement wording", () => {
    const block = testApi.buildChainContextBlock({
      chainName: "fix-auth",
      stepIndex: 1,
      stepTotal: 3,
      agent: "worker",
      sequence: "worker → reviewer → worker",
    });
    // The block is information about where the step sits, what happens next, and
    // one consequence of the hand-off — never an instruction, a prohibition, or a
    // spawning restriction. The list below still guards against that wording even
    // though the block now carries the practical-consequence line: the line states
    // what the orchestrator sees and what carrying forward means, without ever
    // telling a step what it may or may not do.
    const lower = block.toLowerCase();
    for (const banned of [
      "do not",
      "don't",
      "never",
      "avoid",
      "instead",
      "spawn a",
      "unless",
      "forbidden",
      "restricted",
      "allowlist",
      "whitelist",
      "pi_subagent_allowed",
      "subagent_agents",
    ]) {
      assert.ok(!lower.includes(banned), `the block must stay factual (found ${JSON.stringify(banned)})`);
    }
    // Not vacuous: every fact a step needs is still there — position, sequence,
    // the automatic hand-off, who sees the final message, and its peers by name.
    assert.match(block, /step 1 of 3 in the sub-agent chain `fix-auth`/, "position within the chain");
    assert.match(block, /agent role is `worker`/, "its own role");
    assert.match(block, /chain sequence is `worker → reviewer → worker`/, "the whole sequence");
    assert.match(
      block,
      /The orchestrator that started this chain sees only the final step's final message/,
      "the orchestrator only sees the last step's final message",
    );
    assert.match(
      block,
      /so pass along anything the orchestrator should know from earlier steps/,
      "earlier-step information is carried forward",
    );
    // This is step 1, which has no earlier steps at all. The hand-off sentence is
    // emitted identically for every step, so both clauses stay conditional ("any
    // earlier", "any later") instead of claiming peers on both sides.
    assert.ok(block.length > 0, "the block must not be empty — a blank block must fail every match below");
    assert.match(
      block,
      /Any earlier steps have already run/,
      "earlier steps ran, if the chain has any (step 1 has none)",
    );
    assert.match(
      block,
      /any later steps run automatically after you and receive your final message/,
      "later steps run on their own and get this step's output, if the chain has any",
    );
    assert.ok(block.includes("worker") && block.includes("reviewer"), "peers are named");
    // Exactly the six emitted lines: heading, blank line, then four fact lines.
    const lines = block.split("\n");
    assert.equal(lines.length, 6, "heading, blank line, then the four fact lines and nothing more");
    assert.equal(lines[0], "## Chain context");
    assert.equal(lines[1], "");
    assert.ok(lines.every((line) => line === line.trimEnd()), "no trailing whitespace");
  });

  it("falls back to a generic role label when agent and sequence are blank", () => {
    const block = testApi.buildChainContextBlock({
      chainName: "c",
      stepIndex: 1,
      stepTotal: 2,
      agent: "   ",
      sequence: "  ",
    });
    assert.match(block, /agent role is `subagent`/);
    assert.match(block, /chain sequence is `subagent`/);
  });

  it("returns an empty block when there is no chain to describe", () => {
    // A one-step chain is not a chain — the step must launch exactly like an
    // ordinary spawn, with no extra prompt noise.
    assert.equal(
      testApi.buildChainContextBlock({ chainName: "c", stepIndex: 1, stepTotal: 1, agent: "worker", sequence: "worker" }),
      "",
    );
    assert.equal(
      testApi.buildChainContextBlock({ chainName: "c", stepIndex: 0, stepTotal: 0, agent: "worker", sequence: "" }),
      "",
    );
  });

  it("emits the PI_SUBAGENT_CHAIN_* vars for chain steps only", () => {
    assert.deepEqual(
      testApi.buildChainEnvParts({
        chainName: "fix auth",
        stepIndex: 2,
        stepTotal: 3,
        sequence: "worker → reviewer",
      }),
      [
        `PI_SUBAGENT_CHAIN_NAME=${shellEscape("fix auth")}`,
        "PI_SUBAGENT_CHAIN_STEP=2",
        "PI_SUBAGENT_CHAIN_STEP_TOTAL=3",
        `PI_SUBAGENT_CHAIN_SEQUENCE=${shellEscape("worker → reviewer")}`,
      ],
      "name, 1-based step, total, and sequence — quoted like every other PI_SUBAGENT_* var",
    );
    // Ordinary spawns and one-step chains get none at all.
    assert.deepEqual(testApi.buildChainEnvParts(undefined), []);
    assert.deepEqual(testApi.buildChainEnvParts(null), []);
    assert.deepEqual(
      testApi.buildChainEnvParts({ chainName: "c", stepIndex: 1, stepTotal: 1, sequence: "worker" }),
      [],
    );
  });

  // ── Exactly-once delivery into the child's system prompt ──

  /** Resolve the file a --append-system-prompt/--system-prompt flag points at. */
  function promptFileArg(parts: string[], flag: string): string {
    const i = parts.indexOf(flag);
    assert.ok(i >= 0, `expected ${flag} in ${parts.join(" ")}`);
    return parts[i + 1].replace(/^'/, "").replace(/'$/, "").replace(/'\\''/g, "'");
  }

  const unrestrictedLoadout = {
    toolAllowlist: null,
    model: null,
    thinking: null,
    spawnable: null,
    autoExit: true,
    cwd: null,
    agentDir: null,
    modelOverrides: null,
  };
  const stepTwo = { chainName: "fix-auth", stepIndex: 2, stepTotal: 3, sequence: "worker → reviewer → worker" };

  it("rides the block on the identity's single system-prompt call", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        { ...unrestrictedLoadout, agent: "worker", systemPromptMode: "append", identity: "You are a worker.", chain: stepTwo },
        { artifactDir: d, name: "worker" },
      );
      assert.equal(parts.filter((p) => p === "--append-system-prompt").length, 1, "exactly one system-prompt call");
      assert.equal(parts.filter((p) => p === "--system-prompt").length, 0);
      const written = readFileSync(promptFileArg(parts, "--append-system-prompt"), "utf8");
      assert.ok(written.includes("You are a worker."), "identity still arrives");
      assert.ok(written.includes("## Chain context"), "block arrives with it");
      assert.ok(written.includes("step 2 of 3"), "with the position");
    });
  });

  it("delivers the block on its own when the identity went into the task instead", () => {
    withTempDir((d) => {
      // No `system-prompt:` frontmatter → the loadout carries no identity (it
      // lived in the task's roleBlock), so the block must still reach the
      // system prompt — as the only system-prompt call.
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        { ...unrestrictedLoadout, agent: "worker", systemPromptMode: null, identity: null, chain: stepTwo },
        { artifactDir: d, name: "worker" },
      );
      assert.equal(parts.filter((p) => p === "--append-system-prompt").length, 1);
      const written = readFileSync(promptFileArg(parts, "--append-system-prompt"), "utf8");
      assert.ok(written.startsWith("## Chain context"), "block only — no identity text in it");
      assert.ok(!written.includes("You are a worker."));
    });
  });

  it("delivers the block for an agentless (fork) launch too", () => {
    withTempDir((d) => {
      // inheritsConversationContext mode passes params.task through verbatim, so
      // the task text is no injection point at all — the append channel is.
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        { ...unrestrictedLoadout, agent: null, systemPromptMode: null, identity: null, chain: stepTwo },
        { artifactDir: d, name: "fork" },
      );
      assert.equal(parts.filter((p) => p === "--append-system-prompt").length, 1);
      assert.ok(readFileSync(promptFileArg(parts, "--append-system-prompt"), "utf8").includes("step 2 of 3"));
    });
  });

  it("adds nothing at all to a non-chain launch", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        { ...unrestrictedLoadout, agent: "worker", systemPromptMode: "append", identity: "You are a worker." },
        { artifactDir: d, name: "worker" },
      );
      assert.equal(parts.filter((p) => p === "--append-system-prompt").length, 1, "identity call only");
      assert.equal(readdirSync(join(d, "context")).filter((f) => f.includes("chain-context")).length, 0, "no block file");
      assert.ok(!readFileSync(promptFileArg(parts, "--append-system-prompt"), "utf8").includes("Chain context"));
    });
  });

  it("replays the identical block and the original position from the loadout on resume", () => {
    const loadout = {
      ...unrestrictedLoadout,
      agent: "reviewer",
      systemPromptMode: "append" as const,
      identity: "You are a reviewer.",
      chain: stepTwo,
    };
    assert.equal(
      testApi.chainBlockForLoadout(loadout as any),
      testApi.buildChainContextBlock({
        chainName: "fix-auth",
        stepIndex: 2,
        stepTotal: 3,
        agent: "reviewer",
        sequence: "worker → reviewer → worker",
      }),
      "resume rebuilds the launch's block verbatim",
    );
    // The position the resumed step reports is the persisted one.
    assert.deepEqual(testApi.buildChainEnvParts(loadout.chain), [
      `PI_SUBAGENT_CHAIN_NAME=${shellEscape("fix-auth")}`,
      "PI_SUBAGENT_CHAIN_STEP=2",
      "PI_SUBAGENT_CHAIN_STEP_TOTAL=3",
      `PI_SUBAGENT_CHAIN_SEQUENCE=${shellEscape("worker → reviewer → worker")}`,
    ]);
  });

  it("carries identity and block in one system-prompt value", () => {
    const block = testApi.buildChainContextBlock({
      chainName: "fix-auth",
      stepIndex: 1,
      stepTotal: 2,
      agent: "worker",
      sequence: "worker → reviewer",
    });
    // The Claude CLI branch builds its single --append-system-prompt argument
    // with this same helper, so one value carries both pieces there too.
    const both = testApi.composeSystemPromptText("You are a worker.", block);
    assert.equal(both, `You are a worker.\n\n${block}`);
    assert.ok(!both.includes("\n\n\n"), "exactly one separator");
    assert.equal(testApi.composeSystemPromptText("You are a worker.", ""), "You are a worker.", "no chain → identity only");
    assert.equal(testApi.composeSystemPromptText(null, block), block, "no identity → block only");
    assert.equal(testApi.composeSystemPromptText(undefined, ""), "");
    assert.equal(testApi.composeSystemPromptText("   ", ""), "", "blank identity contributes nothing");
  });

  it("replays launch and resume from the same persisted loadout snapshot", () => {
    withTempDir((d) => {
      const sessionFile = join(d, "sub-worker.jsonl");
      writeSubagentLoadout(sessionFile, {
        ...unrestrictedLoadout,
        agent: "worker",
        systemPromptMode: "append",
        identity: "You are a worker.",
        chain: stepTwo,
      } as any);

      // This is exactly what the resume path reads back and replays.
      const restored = readSubagentLoadout(sessionFile);
      assert.ok(restored, "snapshot readable");
      assert.deepEqual(restored.chain, stepTwo, "position survived the round trip");

      const parts: string[] = [];
      testApi.applySandboxToParts(parts, restored, { artifactDir: d, name: "worker" });
      assert.equal(parts.filter((p) => p === "--append-system-prompt").length, 1, "still exactly one call");
      const written = readFileSync(promptFileArg(parts, "--append-system-prompt"), "utf8");
      assert.ok(written.includes("You are a worker."), "identity replayed");
      assert.ok(written.includes("step 2 of 3"), "position replayed, not recomputed");
      assert.deepEqual(testApi.buildChainEnvParts(restored.chain), [
        `PI_SUBAGENT_CHAIN_NAME=${shellEscape("fix-auth")}`,
        "PI_SUBAGENT_CHAIN_STEP=2",
        "PI_SUBAGENT_CHAIN_STEP_TOTAL=3",
        `PI_SUBAGENT_CHAIN_SEQUENCE=${shellEscape("worker → reviewer → worker")}`,
      ]);
    });
  });

  it("never lets a corrupt snapshot inject text into the launch command", () => {
    // Resume reads these numbers from an on-disk file, so they are sanitized
    // rather than interpolated.
    assert.deepEqual(
      testApi.buildChainEnvParts({ chainName: "c", stepIndex: "2; rm -rf /", stepTotal: 3, sequence: "a → b" } as any),
      [],
      "an unusable step index means no chain vars at all",
    );
    assert.deepEqual(
      testApi.buildChainEnvParts({ chainName: "c", stepIndex: "2", stepTotal: "x`id`", sequence: "a → b" } as any),
      [],
      "same for an unusable total",
    );
    assert.deepEqual(
      testApi.buildChainEnvParts({ chainName: "c", stepIndex: 2.9, stepTotal: 3, sequence: "a → b" } as any),
      [`PI_SUBAGENT_CHAIN_NAME=${shellEscape("c")}`, "PI_SUBAGENT_CHAIN_STEP=2", "PI_SUBAGENT_CHAIN_STEP_TOTAL=3", `PI_SUBAGENT_CHAIN_SEQUENCE=${shellEscape("a → b")}`],
      "numbers are truncated, never quoted as text",
    );
    assert.equal(testApi.chainBlockForLoadout({ agent: "worker", chain: { chainName: "c", stepIndex: "1$(id)", stepTotal: 2, sequence: "a → b" } } as any), "");
  });

  it("never lets a corrupt snapshot reach the widget, so no channel disagrees", () => {
    const corrupt = { chainName: "c", stepIndex: "2; rm -rf /", stepTotal: 3, sequence: "a → b" } as any;
    // The widget, the env vars, and the block share one gate — so a snapshot
    // that opts out of the block and the vars must opt out of the widget too,
    // and must never contribute raw text (or ANSI) to a rendered TUI line.
    assert.deepEqual(testApi.chainWidgetPosition(corrupt), {}, "an unusable position renders nothing");
    assert.deepEqual(testApi.buildChainEnvParts(corrupt), [], "…no env vars…");
    assert.equal(testApi.chainBlockForLoadout({ agent: "worker", chain: corrupt } as any), "", "…and no block");

    // A one-step chain opts out of all three the same way.
    assert.deepEqual(testApi.chainWidgetPosition({ chainName: "c", stepIndex: 1, stepTotal: 1, sequence: "worker" }), {});
    assert.deepEqual(testApi.chainWidgetPosition(undefined), {}, "ordinary spawns have no widget position");
    assert.deepEqual(testApi.chainWidgetPosition(null), {});
    assert.deepEqual(testApi.chainWidgetPosition({ chainName: "c", stepIndex: 0, stepTotal: 3, sequence: "a → b" }), {}, "step 0 is not a position");
    // A real position renders truncated integers, identical to the env vars.
    assert.deepEqual(
      testApi.chainWidgetPosition({ chainName: "c", stepIndex: 2.9, stepTotal: 3, sequence: "a → b" }),
      { chainStep: 2, chainStepTotal: 3 },
    );

    const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
    const render = (chain: any) =>
      strip(
        testApi.renderSubagentWidgetLines(
          [{ ...makeFakeRunning("worker"), agent: "worker", ...testApi.chainWidgetPosition(chain) }],
          100,
        )[1],
      );
    const row = render(corrupt);
    assert.ok(!row.includes("rm") && !row.includes(";"), `no snapshot text in a widget row, got: ${row}`);
    assert.ok(!row.includes("/3"), `and no position either — this launch is not a chain step, got: ${row}`);
    assert.ok(render({ chainName: "c", stepIndex: 2.9, stepTotal: 3, sequence: "a → b" }).includes(" 2/3 "), "a valid position renders");
  });

  it("passes no system-prompt flag at all when identity and block are both blank", () => {
    // A truthy-but-blank identity must not produce an empty prompt file, and a
    // block-only delivery must never REPLACE pi's own system prompt.
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        { ...unrestrictedLoadout, agent: "worker", systemPromptMode: "replace", identity: "   " },
        { artifactDir: d, name: "worker" },
      );
      assert.equal(parts.filter((p) => p === "--append-system-prompt").length, 0);
      assert.equal(parts.filter((p) => p === "--system-prompt").length, 0, "nothing is passed for a blank identity");
    });
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        { ...unrestrictedLoadout, agent: "worker", systemPromptMode: "replace", identity: null, chain: stepTwo },
        { artifactDir: d, name: "worker" },
      );
      assert.equal(parts.filter((p) => p === "--system-prompt").length, 0, "the block never replaces the prompt");
      assert.equal(parts.filter((p) => p === "--append-system-prompt").length, 1, "…it only ever appends");
    });
    withTempDir((d) => {
      // A real identity still replaces when the snapshot says so.
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        { ...unrestrictedLoadout, agent: "worker", systemPromptMode: "replace", identity: "You are a worker.", chain: stepTwo },
        { artifactDir: d, name: "worker" },
      );
      assert.equal(parts.filter((p) => p === "--system-prompt").length, 1);
      assert.equal(parts.filter((p) => p === "--append-system-prompt").length, 0, "still exactly one call");
      const written = readFileSync(promptFileArg(parts, "--system-prompt"), "utf8");
      assert.ok(written.includes("You are a worker.") && written.includes("## Chain context"));
    });
  });

  it("caps long non-final step outputs in the presentation", () => {
    assert.equal(testApi.truncateChainOutput("short", 100), "short");
    const long = testApi.truncateChainOutput("x".repeat(200), 100);
    assert.ok(long.length < 200);
    assert.match(long, /truncated/);
  });

  // ── Validation (no tmux panes involved) ──

  it("rejects mixing single-spawn params with a chain", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const result = await subagentTool.execute(
      "call-1",
      { agent: "worker", task: "solo", chain: [{ agent: "worker", task: "a" }] },
      undefined,
      undefined,
      mockCtx(),
    );
    assert.equal(result.details?.error, "chain and single spawn are mutually exclusive");
  });

  it("rejects a chain step naming an unknown agent (before launching anything)", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const original = testApi.chainHooks.runStep;
    let stepCalls = 0;
    testApi.chainHooks.runStep = async () => {
      stepCalls++;
    };
    try {
      const result = await subagentTool.execute(
        "call-1",
        { chain: [{ agent: "worker", task: "a" }, { agent: "wizard", task: "b" }] },
        undefined,
        undefined,
        mockCtx(),
      );
      // The ambient PI_SUBAGENT_ALLOWED is scrubbed at import (hermetic-env.ts)
      // and this suite deletes the var per test, so SUBAGENT_ALLOWLIST is null
      // here and only the "unknown chain agent" branch is reachable. The
      // allowlist branch is covered in the "subagent spawn guards" suite, which
      // loads a second module instance with the var set.
      assert.match(result.details?.error, /^unknown chain agent$/);
      assert.equal(result.details?.step, 2);
    } finally {
      testApi.chainHooks.runStep = original;
    }
    assert.equal(stepCalls, 0, "no step should have launched");
    assert.equal(sentMessages.length, 0, "no steer should have been sent");
  });

  it("rejects a chain step missing a task", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const result = await subagentTool.execute(
      "call-1",
      { chain: [{ agent: "worker", task: "a" }, { agent: "reviewer" }] as any },
      undefined,
      undefined,
      mockCtx(),
    );
    assert.equal(result.details?.error, "chain step missing task");
    assert.equal(result.details?.step, 2);
  });

  it("rejects a chain longer than the max step count", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const many = Array.from(
      { length: testApi.MAX_CHAIN_STEPS + 1 },
      (_, i) => ({ agent: "scout", task: `t${i}` }),
    );
    const result = await subagentTool.execute("call-1", { chain: many }, undefined, undefined, mockCtx());
    assert.equal(result.details?.error, "chain too long");
  });

  // ── Orchestration (stubbed step runner — no real tmux panes) ──

  it("runs steps in order, defaulting names, and appends each output to the next task", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const calls: any[] = [];
    const launched: any[] = [];
    const original = testApi.chainHooks.runStep;
    testApi.chainHooks.runStep = async (
      step: any,
      _ctx: any,
      parentArtifactDir: any,
      _pi: any,
      _signal: AbortSignal,
      hooks: any,
    ) => {
      const fake = makeFakeRunning(step.name);
      hooks.onLaunched(fake);
      launched.push(fake);
      calls.push({ agent: step.agent, task: step.task, name: step.name });
      registerName(parentArtifactDir, step.name, {
        sessionFile: join(sessionDir, `sub-${step.name}.jsonl`),
        sessionId: null,
      });
      return {
        name: step.name,
        summary: `SUMMARY-${calls.length}`,
        exitCode: 0,
        elapsed: 2,
        sessionFile: join(sessionDir, `sub-${step.name}.jsonl`),
      };
    };
    try {
      const ack = await subagentTool.execute(
        "call-1",
        {
          name: "test-chain",
          chain: [
            { agent: "worker", task: "implement X" },
            { agent: "reviewer", task: "review it" },
            { agent: "worker", task: "apply the feedback" },
          ],
        },
        undefined,
        undefined,
        mockCtx(),
      );
      assert.equal(ack.details?.status, "chain-started");
      assert.equal(ack.details?.chainName, "test-chain");
      assert.match(ack.content[0].text, /Chain "test-chain" started: 3 steps \(worker → reviewer → worker\)/);
      assert.match(ack.content[0].text, /automatically appended/i);

      // The chain drives itself; let it finish (stub resolves immediately).
      for (let i = 0; i < 20; i++) {
        if (sentMessages.length > 0) break;
        await chainSleep(10);
      }

      assert.equal(calls.length, 3, "all three steps should have run");
      assert.deepEqual(
        calls.map((c) => c.agent),
        ["worker", "reviewer", "worker"],
        "steps run in the requested order",
      );
      assert.deepEqual(
        calls.map((c) => c.name),
        ["worker", "reviewer", "worker-2"],
        "default step names are auto-suffixed on collision",
      );

      // The live running object each step reports as launched gets the 1-based
      // step counter attached via onLaunched (what the widget's "1/3" column
      // reads off the runningSubagents map).
      assert.equal(launched.length, 3, "onLaunched was invoked for every step");
      launched.forEach((fake: any, i: number) => {
        assert.equal(fake.chainStep, i + 1, `step ${i + 1} gets its 1-based index`);
        assert.equal(fake.chainStepTotal, 3, `step ${i + 1} gets the total step count`);
      });

      // Automatic hand-off: each task starts with its own task and ends with
      // the previous step's output — no placeholder, no manual pasting.
      assert.ok(calls[1].task.startsWith("review it"));
      assert.ok(calls[1].task.includes("## Output from previous step (step 1: worker)"));
      assert.ok(calls[1].task.endsWith("SUMMARY-1"));
      assert.ok(calls[2].task.startsWith("apply the feedback"));
      assert.ok(calls[2].task.includes("## Output from previous step (step 2: reviewer)"));
      assert.ok(calls[2].task.endsWith("SUMMARY-2"));
      assert.ok(!calls[0].task.includes("Output from previous step"), "first step gets no appended context");

      // Exactly ONE steer: the aggregate chain result (no per-step steers).
      assert.equal(sentMessages.length, 1, "only the aggregate chain steer is sent");
      const steer = sentMessages[0].message;
      assert.equal(steer.customType, "subagent_result");
      assert.equal(steer.details.chain, true);
      assert.equal(steer.details.name, "test-chain");
      assert.equal(steer.details.exitCode, 0);
      assert.equal(steer.details.steps.length, 3);
      assert.deepEqual(
        steer.details.steps.map((s: any) => s.status),
        ["completed", "completed", "completed"],
      );
      assert.match(steer.content, /Chain "test-chain" completed: 3\/3 steps/);
      assert.match(steer.content, /## Step 1\/3: worker \(worker\) — completed/);
      assert.match(steer.content, /## Step 2\/3: reviewer \(reviewer\) — completed/);
      assert.match(steer.content, /## Step 3\/3: worker \(worker-2\) — completed/);
      assert.match(steer.content, /SUMMARY-1/);
      assert.match(steer.content, /SUMMARY-2/);
      assert.match(steer.content, /SUMMARY-3/);
      assert.match(steer.content, /subagent_message\(\{ name: "worker-2"/);
      assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
    } finally {
      testApi.chainHooks.runStep = original;
    }
  });

  it("stops the chain when a step fails and reports what was and was not run", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const calls: any[] = [];
    const original = testApi.chainHooks.runStep;
    testApi.chainHooks.runStep = async (step: any, _ctx: any, parentArtifactDir: any) => {
      calls.push(step.agent);
      registerName(parentArtifactDir, step.name, { sessionFile: join(sessionDir, `sub.jsonl`), sessionId: null });
      if (step.agent === "reviewer") {
        return { name: step.name, summary: "reviewing…", exitCode: 1, elapsed: 1, errorMessage: "provider overloaded" };
      }
      return { name: step.name, summary: `SUMMARY-${calls.length}`, exitCode: 0, elapsed: 2, sessionFile: join(sessionDir, `sub.jsonl`) };
    };
    try {
      await subagentTool.execute(
        "call-1",
        {
          name: "fail-chain",
          chain: [
            { agent: "worker", task: "implement X" },
            { agent: "reviewer", task: "review it" },
            { agent: "worker", task: "apply the feedback" },
          ],
        },
        undefined,
        undefined,
        mockCtx(),
      );

      for (let i = 0; i < 20; i++) {
        if (sentMessages.length > 0) break;
        await chainSleep(10);
      }

      assert.deepEqual(calls, ["worker", "reviewer"], "the step after the failure must not run");
      assert.equal(sentMessages.length, 1);
      const steer = sentMessages[0].message;
      assert.equal(steer.details.chain, true);
      assert.equal(steer.details.exitCode, 1);
      assert.deepEqual(
        steer.details.steps.map((s: any) => s.status),
        ["completed", "failed", "skipped"],
      );
      assert.match(steer.content, /stopped at step 2\/3 \(reviewer\) — provider\/agent error: provider overloaded/);
      assert.match(steer.content, /Not run \(chain stopped early\): worker/);
      assert.match(steer.content, /SUMMARY-1/, "completed steps' outputs are still included");
    } finally {
      testApi.chainHooks.runStep = original;
    }
  });

  it("marks the chain cancelled when aborted mid-step and skips the rest", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const calls: any[] = [];
    let releaseGate: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const original = testApi.chainHooks.runStep;
    testApi.chainHooks.runStep = async (step: any, _ctx: any, parentArtifactDir: any, _pi: any, signal: AbortSignal, hooks: any) => {
      hooks.onLaunched(makeFakeRunning(step.name));
      calls.push(step.agent);
      registerName(parentArtifactDir, step.name, { sessionFile: join(sessionDir, `sub.jsonl`), sessionId: null });
      if (calls.length === 1) {
        await Promise.race([
          gate,
          new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })),
        ]);
        if (signal.aborted) {
          return { name: step.name, summary: "Subagent cancelled.", exitCode: 1, elapsed: 1 };
        }
      }
      return { name: step.name, summary: `SUMMARY-${calls.length}`, exitCode: 0, elapsed: 2 };
    };
    try {
      await subagentTool.execute(
        "call-1",
        {
          name: "abort-chain",
          chain: [
            { agent: "worker", task: "implement X" },
            { agent: "reviewer", task: "review it" },
          ],
        },
        undefined,
        undefined,
        mockCtx(),
      );

      // Wait until step 1 is running, then abort the chain.
      const chains = testApi.getChainMapForSession(sessionId);
      const chain = chains.get("abort-chain");
      assert.ok(chain, "chain should be tracked for this session");
      for (let i = 0; i < 50 && chain.currentStep === 0; i++) await chainSleep(10);
      assert.equal(chain.currentStep, 1, "step 1 should be running");
      chain.aborted = true;
      chain.abortController.abort();

      for (let i = 0; i < 20; i++) {
        if (sentMessages.length > 0) break;
        await chainSleep(10);
      }

      assert.deepEqual(calls, ["worker"], "step 2 must not run after abort");
      assert.equal(sentMessages.length, 1);
      const steer = sentMessages[0].message;
      assert.equal(steer.details.cancelled, true);
      assert.equal(steer.details.exitCode, 1);
      assert.deepEqual(
        steer.details.steps.map((s: any) => s.status),
        ["cancelled", "skipped"],
      );
      assert.match(steer.content, /was cancelled \(parent session shut down\)/);
    } finally {
      releaseGate?.();
      testApi.chainHooks.runStep = original;
    }
  });

  // ── subagent_message addressing of chains ──

  it("reports a finished chain by name and points at its steps", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");

    const original = testApi.chainHooks.runStep;
    testApi.chainHooks.runStep = async (step: any, _ctx: any, parentArtifactDir: any) => {
      registerName(parentArtifactDir, step.name, { sessionFile: join(sessionDir, `sub.jsonl`), sessionId: null });
      return { name: step.name, summary: `SUMMARY-${step.agent}`, exitCode: 0, elapsed: 1 };
    };
    try {
      await subagentTool.execute(
        "call-1",
        {
          name: "msg-chain",
          chain: [
            { agent: "worker", task: "implement X" },
            { agent: "reviewer", task: "review it" },
          ],
        },
        undefined,
        undefined,
        mockCtx(),
      );
      // Let the chain finish.
      const chains = testApi.getChainMapForSession(sessionId);
      const chain = chains.get("msg-chain");
      for (let i = 0; i < 50 && !chain.finished; i++) await chainSleep(10);
      assert.ok(chain.finished, "chain should have finished");

      const result = await messageTool.execute("call-2", { name: "msg-chain", message: "keep going" }, undefined, undefined, mockCtx());
      assert.equal(result.details?.error, "chain finished");
      assert.match(result.content[0].text, /has already finished/);
      assert.match(result.content[0].text, /worker/);
      assert.match(result.content[0].text, /reviewer/);
    } finally {
      testApi.chainHooks.runStep = original;
    }
  });

  it("delivers a message for an active chain to its currently running step", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");

    let releaseGate: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const original = testApi.chainHooks.runStep;
    testApi.chainHooks.runStep = async (step: any, _ctx: any, parentArtifactDir: any, _pi: any, signal: AbortSignal, hooks: any) => {
      const fake = makeFakeRunning(step.name);
      hooks.onLaunched(fake);
      testApi.runningSubagents.set(fake.id, fake);
      registerName(parentArtifactDir, step.name, { sessionFile: fake.sessionFile, sessionId: null });
      await Promise.race([
        gate,
        new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })),
      ]);
      testApi.runningSubagents.delete(fake.id);
      if (signal.aborted) return { name: step.name, summary: "Subagent cancelled.", exitCode: 1, elapsed: 1 };
      return { name: step.name, summary: `SUMMARY-${step.agent}`, exitCode: 0, elapsed: 1 };
    };
    try {
      await subagentTool.execute(
        "call-1",
        {
          name: "steer-chain",
          chain: [
            { agent: "worker", task: "implement X" },
            { agent: "reviewer", task: "review it" },
          ],
        },
        undefined,
        undefined,
        mockCtx(),
      );
      const chain = testApi.getChainMapForSession(sessionId).get("steer-chain");
      for (let i = 0; i < 50 && chain.currentStep === 0; i++) await chainSleep(10);
      assert.equal(chain.currentStep, 1);

      // The chain name resolves to the running step. (Delivery to the fake
      // "%stub" surface fails in this environment — that's fine: the point is
      // that the chain branch routed the message to the step, not that the
      // name was unknown or the chain finished.)
      const result = await messageTool.execute("call-2", { name: "steer-chain", message: "hurry up" }, undefined, undefined, mockCtx());
      assert.match(result.content[0].text, /Failed to deliver message to subagent "worker" via tmux/);

      // Abort + release so the chain cleans up.
      chain.aborted = true;
      chain.abortController.abort();
      releaseGate();
      await chainSleep(30);
    } finally {
      releaseGate?.();
      testApi.chainHooks.runStep = original;
      testApi.runningSubagents.clear();
    }
  });

  // ── Real runStep (launch/watch stubbed) — widget refresh across steps ──

  it("re-arms the widget refresh for every chain step (bar must not vanish after step 1)", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const setWidgetCalls: Array<any> = [];
    // Recording UI: updateWidget() early-returns without hasUI, so a fake
    // ctx is needed to observe the widget being cleared/re-shown.
    testApi.setLatestCtxForTest({
      hasUI: true,
      ui: { setWidget: (key: string, value: any) => setWidgetCalls.push(value) },
    });

    let releaseStep1: () => void;
    const step1Gate = new Promise<void>((r) => (releaseStep1 = r));
    let releaseStep2: () => void;
    const step2Gate = new Promise<void>((r) => (releaseStep2 = r));
    let launchCalls = 0;
    let watchCalls = 0;
    const origLaunch = testApi.subagentOps.launch;
    const origWatch = testApi.subagentOps.watch;
    testApi.subagentOps.launch = async (params: any) => {
      launchCalls++;
      // Hold step 2 back so the test can observe the empty-map state between steps.
      if (launchCalls > 1) await step2Gate;
      const fake = makeFakeRunning(params.name);
      testApi.runningSubagents.set(fake.id, fake);
      return fake;
    };
    testApi.subagentOps.watch = async (running: any) => {
      watchCalls++;
      // Note: no refresh assertions inside this stub — a throw here would be
      // swallowed into step.errorMessage by runChain's try/catch and surface
      // later with a misleading message. The asserts below are the check.
      if (watchCalls === 1) {
        await step1Gate;
      } else {
        // Linger briefly so the test can observe step 2 mid-run (the real
        // watcher stays for the step's whole duration).
        await new Promise((r) => setTimeout(r, 300));
      }
      testApi.runningSubagents.delete(running.id);
      return { name: running.name, task: running.task, summary: watchCalls === 1 ? "S1" : "S2", exitCode: 0, elapsed: 1 };
    };
    try {
      await subagentTool.execute(
        "call-1",
        { name: "reg-chain", chain: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }] },
        undefined,
        undefined,
        mockCtx(),
      );

      // (a) Step 1 running: refresh armed.
      for (let i = 0; i < 50 && testApi.runningSubagents.size !== 1; i++) await chainSleep(10);
      assert.equal(testApi.runningSubagents.size, 1, "step 1 should be running");
      assert.equal(testApi.widgetRefreshActive(), true, "refresh armed while step 1 runs");

      // (b) Release step 1; once it leaves the map the pre-fix state is
      // reached: refresh cleared, widget removed.
      releaseStep1();
      for (let i = 0; i < 50 && testApi.runningSubagents.size !== 0; i++) await chainSleep(10);
      assert.equal(testApi.runningSubagents.size, 0, "step 1 should be done");
      assert.equal(testApi.widgetRefreshActive(), false, "refresh cleared with an empty map");
      assert.equal(setWidgetCalls[setWidgetCalls.length - 1], undefined, "widget cleared after step 1");
      const clearedAt = setWidgetCalls.length - 1;

      // (c) Step 2 running: refresh re-armed (the fix) and widget re-shown.
      releaseStep2();
      for (let i = 0; i < 50 && testApi.runningSubagents.size !== 1; i++) await chainSleep(10);
      assert.equal(testApi.runningSubagents.size, 1, "step 2 should be running");
      assert.equal(testApi.widgetRefreshActive(), true, "refresh re-armed for step 2");
      assert.ok(
        setWidgetCalls.slice(clearedAt + 1).some((v) => typeof v === "function"),
        "widget re-shown for step 2 after the step 1 clear",
      );

      // (d) After the aggregate steer: chain truly finished, widget gone.
      for (let i = 0; i < 100 && !sentMessages.some((m) => m.message?.details?.chain === true); i++)
        await chainSleep(10);
      assert.ok(sentMessages.some((m) => m.message?.details?.chain === true), "aggregate chain steer sent");
      assert.equal(testApi.runningSubagents.size, 0, "no running subagents after the chain");
      assert.equal(testApi.widgetRefreshActive(), false, "refresh cleared when the chain finishes");
      assert.equal(setWidgetCalls[setWidgetCalls.length - 1], undefined, "widget cleared after the final step");
    } finally {
      releaseStep1?.();
      releaseStep2?.();
      // If an assertion above failed, the chain may still be running. Abort
      // it (still while the stubs are installed) so an in-flight step's real
      // watchSubagent bails on the aborted signal instead of polling tmux on
      // the fake "%stub" surface. On the green path the chain is already
      // finished and this is a no-op.
      const leftover = testApi.getChainMapForSession(sessionId).get("reg-chain");
      if (leftover && !leftover.finished) {
        leftover.aborted = true;
        leftover.abortController.abort();
      }
      testApi.subagentOps.launch = origLaunch;
      testApi.subagentOps.watch = origWatch;
      testApi.setLatestCtxForTest(null);
      testApi.runningSubagents.clear();
    }
  });

  it("hands every chain step its position at launch, and nothing to a one-step chain", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");

    const origLaunch = testApi.subagentOps.launch;
    const origWatch = testApi.subagentOps.watch;
    const launched: Array<{ params: any; options: any }> = [];
    testApi.subagentOps.launch = async (params: any, _ctx: any, options: any) => {
      const fake = makeFakeRunning(params.name);
      launched.push({ params, options, running: fake });
      testApi.runningSubagents.set(fake.id, fake);
      return fake;
    };
    testApi.subagentOps.watch = async (running: any) => {
      testApi.runningSubagents.delete(running.id);
      return { name: running.name, task: running.task, summary: "done", exitCode: 0, elapsed: 1 };
    };
    try {
      await subagentTool.execute(
        "call-1",
        {
          name: "pos-chain",
          chain: [
            { agent: "worker", task: "a" },
            { agent: "reviewer", task: "b" },
            { agent: "worker", task: "c" },
          ],
        },
        undefined,
        undefined,
        mockCtx(),
      );
      for (let i = 0; i < 100 && sentMessages.length === 0; i++) await chainSleep(10);

      assert.equal(launched.length, 3, "every step launched");
      launched.forEach((l, i) => {
        assert.deepEqual(
          l.options?.chainContext,
          {
            chainName: "pos-chain",
            stepIndex: i + 1,
            stepTotal: 3,
            sequence: "worker → reviewer → worker",
          },
          `step ${i + 1} receives its own position`,
        );
        // System prompt only — the block never leaks into the task text.
        assert.ok(!l.params.task.includes("## Chain context"), `step ${i + 1} task stays clean`);
        // Widget position for the same step.
        assert.equal(l.running.chainStep, i + 1, `step ${i + 1} reports its position to the widget`);
        assert.equal(l.running.chainStepTotal, 3);
      });

      // What a step receives is exactly what becomes its env vars.
      assert.deepEqual(testApi.buildChainEnvParts(launched[1].options.chainContext), [
        `PI_SUBAGENT_CHAIN_NAME=${shellEscape("pos-chain")}`,
        "PI_SUBAGENT_CHAIN_STEP=2",
        "PI_SUBAGENT_CHAIN_STEP_TOTAL=3",
        `PI_SUBAGENT_CHAIN_SEQUENCE=${shellEscape("worker → reviewer → worker")}`,
      ]);

      // A one-step chain is not a chain: the step launches with no chain
      // context at all, so it gets neither the block nor the env vars — exactly
      // like an ordinary single spawn (which never passes options either).
      launched.length = 0;
      await subagentTool.execute(
        "call-2",
        { name: "solo-chain", chain: [{ agent: "worker", task: "a" }] },
        undefined,
        undefined,
        mockCtx(),
      );
      for (let i = 0; i < 100 && sentMessages.length < 2; i++) await chainSleep(10);

      assert.equal(launched.length, 1, "the one-step chain launched");
      assert.equal(launched[0].options, undefined, "no chain context for a one-step chain");
      assert.equal(launched[0].running.chainStep, undefined, "and no widget position either");
      assert.deepEqual(testApi.buildChainEnvParts(launched[0].options?.chainContext), []);
      assert.equal(testApi.buildChainContextBlock({ chainName: "solo-chain", stepIndex: 1, stepTotal: 1, agent: "worker", sequence: "worker" }), "");
    } finally {
      const leftover = testApi.getChainMapForSession(sessionId).get("solo-chain");
      if (leftover && !leftover.finished) {
        leftover.aborted = true;
        leftover.abortController.abort();
      }
      testApi.subagentOps.launch = origLaunch;
      testApi.subagentOps.watch = origWatch;
      testApi.runningSubagents.clear();
    }
  });
});

// ── Sub-agent spawn guards ──
//
// Three guards are invisible to every suite above, because they only fire for a
// process that IS itself a sub-agent:
//   • startChain() rejects a chain that contains a step spawning the CURRENT
//     agent — read per call from PI_SUBAGENT_AGENT — and it must do so before
//     registering the chain, so nothing can half-run;
//   • the single-spawn path has the same self-spawn guard for agent + task;
//   • PI_SUBAGENT_ALLOWED, snapshotted into the module-level SUBAGENT_ALLOWLIST
//     at load, restricts both paths to the pinned agent set.
// The first two are read per call, so they are testable on the imported module
// by setting the env var in the test body. The third one is not: the snapshot
// already happened during import, which is why loadModuleWithEnv() below loads a
// second, throwaway module instance with the env it wants.
describe("subagent spawn guards", () => {
  const testApi = (subagentsModule as any).__test__;

  // Ambient values are scrubbed at import (./hermetic-env.ts); each test opts
  // into a sub-agent identity explicitly and hands back whatever the
  // environment held, so nothing leaks into the suites that run after this one.
  const saved = {
    agent: process.env.PI_SUBAGENT_AGENT,
    allowed: process.env.PI_SUBAGENT_ALLOWED,
  };

  let sessionDir: string;
  let sessionId: string;

  beforeEach(() => {
    sessionDir = createTestDir();
    sessionId = `guard-${Math.random().toString(36).slice(2)}`;
    delete process.env.PI_SUBAGENT_AGENT;
    delete process.env.PI_SUBAGENT_ALLOWED;
  });

  afterEach(() => {
    restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
    restoreEnvVar("PI_SUBAGENT_ALLOWED", saved.allowed);
    testApi.stopTimersForTest();
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {}
  });

  function mockCtx(overrides: { getSessionFile?: () => string | null } = {}) {
    return {
      sessionManager: {
        getSessionFile: overrides.getSessionFile ?? (() => join(sessionDir, "session.jsonl")),
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
      },
      cwd: sessionDir,
    } as any;
  }

  /**
   * A ctx whose session file is missing. Validation passes and the call stops
   * at the session-file check instead of launching anything — the deterministic
   * way to prove a guard did NOT fire without touching tmux.
   */
  function mockCtxNoSession() {
    return mockCtx({ getSessionFile: () => null });
  }

  /** Stub a chain step runner so a rejection can be proven to launch nothing. */
  function stubRunStep(api: any = testApi) {
    const original = api.chainHooks.runStep;
    const calls = { count: 0 };
    api.chainHooks.runStep = async () => {
      calls.count++;
    };
    return {
      calls,
      restore: () => {
        api.chainHooks.runStep = original;
      },
    };
  }

  /**
   * Stub the launch path so a rejection can be proven to launch nothing. NOTE:
   * this seam only covers the CHAIN path (chainHooks.runStep -> subagentOps.launch,
   * index.ts:997). The single-spawn path calls launchSubagent() directly
   * (index.ts:2742), so for single-spawn tests this counter is only a
   * belt-and-braces check — those tests must instead rely on mockCtxNoSession()
   * to stop before any pane is opened.
   */
  function stubLaunch(api: any = testApi) {
    const origLaunch = api.subagentOps.launch;
    const origWatch = api.subagentOps.watch;
    const calls = { count: 0 };
    api.subagentOps.launch = async () => {
      calls.count++;
      throw new Error("launchSubagent must not be reached");
    };
    api.subagentOps.watch = async () => {
      calls.count++;
      throw new Error("watchSubagent must not be reached");
    };
    return {
      calls,
      restore: () => {
        api.subagentOps.launch = origLaunch;
        api.subagentOps.watch = origWatch;
      },
    };
  }

  // Loading a second instance of the extension touches process-global
  // singletons (see the top of pi-extension/subagents/index.ts): it clears the
  // previous widget/status intervals and aborts the previous poll controller.
  // Park them around the import and hand the main instance's hooks back
  // afterwards, so the throwaway instance cannot disturb the rest of the suite.
  const GLOBAL_KEYS = {
    widget: Symbol.for("pi-subagents/widget-interval"),
    status: Symbol.for("pi-subagents/status-interval"),
    poll: Symbol.for("pi-subagents/poll-abort-controller"),
    children: Symbol.for("pi-subagents/running-children-count"),
  };

  /**
   * Import a FRESH instance of the extension with `env` set at load time.
   * SUBAGENT_ALLOWLIST is a module-level const seeded from the environment, so
   * the statically imported instance can never observe a non-null allowlist.
   * A query string on the module URL makes this a distinct module record — the
   * key encodes the env, so the same request reuses the same cached instance.
   * Nothing is started by importing or by default(api) (every handler goes
   * through the mocked api.on()), so the instance owns no timers or watchers.
   * Only index.ts is re-evaluated — session.ts/tmux.ts/status.ts stay the
   * already-loaded modules, so their module state remains SHARED with the main
   * instance (the notEqual checks below therefore prove index-level isolation).
   * Note: in a fresh checkout or a /tmp copy of the repo this import pulls in
   * status.ts, which throws at module load when neither config.json nor
   * config.json.example exists next to the package root (status.ts:11).
   */
  async function loadModuleWithEnv(env: Record<string, string | undefined>): Promise<any> {
    const g = globalThis as any;
    const parked = {
      widget: g[GLOBAL_KEYS.widget],
      status: g[GLOBAL_KEYS.status],
      poll: g[GLOBAL_KEYS.poll],
      children: g[GLOBAL_KEYS.children],
      registry: g.__pi_interactive_subagents,
    };
    // Hide the live intervals from the new load: it would clearInterval() them
    // while the main instance still holds the handles and thinks they are armed.
    g[GLOBAL_KEYS.widget] = null;
    g[GLOBAL_KEYS.status] = null;

    const previous: Array<[string, string | undefined]> = [];
    for (const [name, value] of Object.entries(env)) {
      previous.push([name, process.env[name]]);
      restoreEnvVar(name, value);
    }
    let fresh: any;
    try {
      const key = encodeURIComponent(
        Object.entries(env)
          .map(([name, value]) => `${name}=${value ?? ""}`)
          .join("&"),
      );
      fresh = await import(`../pi-extension/subagents/index.ts?env=${key}`);
    } finally {
      for (const [name, value] of previous.reverse()) restoreEnvVar(name, value);
      g[GLOBAL_KEYS.widget] = parked.widget;
      g[GLOBAL_KEYS.status] = parked.status;
      g[GLOBAL_KEYS.children] = parked.children;
      g.__pi_interactive_subagents = parked.registry;
      // The import aborted the shared poll controller; hand back a live one so
      // watchers in the main instance keep behaving as before. In practice the
      // import already installed a fresh controller in this slot, so the
      // `aborted` branch rarely fires — but the main instance's ORIGINAL
      // controller stays aborted either way (index.ts aborts it on module load),
      // which would matter only if a watcher were in flight across the import.
      g[GLOBAL_KEYS.poll] = parked.poll?.signal.aborted ? new AbortController() : parked.poll;
    }
    return fresh;
  }

  // ── Self-spawn guard: chain mode (PI_SUBAGENT_AGENT is read per call) ──

  it("rejects a chain whose first step would spawn the current agent", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const steps = stubRunStep();
    process.env.PI_SUBAGENT_AGENT = "worker";
    try {
      const result = await subagentTool.execute(
        "call-1",
        { chain: [{ agent: "worker", task: "a" }, { agent: "reviewer", task: "b" }] },
        undefined,
        undefined,
        mockCtx(),
      );
      assert.equal(result.details?.error, "self-spawn blocked");
      assert.equal(result.details?.step, 1);
      assert.equal(
        result.content[0].text,
        "You are the worker agent — a chain cannot include another worker. " +
          "You were spawned to do that work yourself.",
      );
    } finally {
      steps.restore();
    }
    assert.equal(steps.calls.count, 0, "no step should have launched");
    assert.equal(sentMessages.length, 0, "no chain steer should have been sent");
    assert.equal(testApi.getChainMapForSession(sessionId).size, 0, "the chain must not be registered");
  });

  it("rejects a chain that only self-spawns in a later step, with nothing half-run", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const steps = stubRunStep();
    process.env.PI_SUBAGENT_AGENT = "planner";
    try {
      const result = await subagentTool.execute(
        "call-1",
        { chain: [{ agent: "scout", task: "a" }, { agent: "planner", task: "b" }] },
        undefined,
        undefined,
        mockCtx(),
      );
      assert.equal(result.details?.error, "self-spawn blocked");
      assert.equal(result.details?.step, 2, "the offending step is reported");
      assert.match(result.content[0].text, /^You are the planner agent — a chain cannot include another planner\./);
    } finally {
      steps.restore();
    }
    assert.equal(steps.calls.count, 0, "step 1 must not run either — the whole chain is rejected");
    assert.equal(sentMessages.length, 0, "no chain steer should have been sent");
    assert.equal(testApi.getChainMapForSession(sessionId).size, 0, "the chain must not be registered");
  });

  it("accepts the same chain when the caller is not a sub-agent (the guard is env-driven)", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const steps = stubRunStep();
    // No PI_SUBAGENT_AGENT: this is a top-level session, so spawning "worker"
    // is legitimate. The ctx has no session file, so the call stops at the
    // prerequisite check instead of launching anything.
    try {
      const result = await subagentTool.execute(
        "call-1",
        { chain: [{ agent: "worker", task: "a" }] },
        undefined,
        undefined,
        mockCtxNoSession(),
      );
      assert.notEqual(result.details?.error, "self-spawn blocked", "a top-level session may spawn any agent");
      assert.match(String(result.details?.error), /no session file|tmux not available/);
    } finally {
      steps.restore();
    }
    assert.equal(steps.calls.count, 0, "nothing should have launched");
    assert.equal(testApi.getChainMapForSession(sessionId).size, 0, "the chain must not be registered");
  });

  // ── Self-spawn guard: single-spawn mode ──

  it("rejects a single self-spawn of the current agent", async () => {
    const { api, registeredTools, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const launch = stubLaunch();
    process.env.PI_SUBAGENT_AGENT = "planner";
    try {
      const result = await subagentTool.execute(
        "call-1",
        { agent: "planner", task: "plan something" },
        undefined,
        undefined,
        // The guard fires before the session-file check, so a ctx with no
        // session file still proves it fired — and it guarantees that a
        // neutered guard stops at "no session file" instead of opening a real
        // pane (the single-spawn path bypasses the stubLaunch seam).
        mockCtxNoSession(),
      );
      assert.equal(result.details?.error, "self-spawn blocked");
      assert.equal(
        result.content[0].text,
        "You are the planner agent — do not start another planner. " +
          "You were spawned to do this work yourself. Complete the task directly.",
      );
      assert.equal(launch.calls.count, 0, "no pane should have been launched");
      assert.equal(sentMessages.length, 0, "no steer should have been sent");
    } finally {
      launch.restore();
    }
  });

  it("lets a sub-agent single-spawn a different agent (the guard is env-driven, not blanket)", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const launch = stubLaunch();
    process.env.PI_SUBAGENT_AGENT = "planner";
    try {
      const result = await subagentTool.execute(
        "call-1",
        { agent: "scout", task: "look around" },
        undefined,
        undefined,
        mockCtxNoSession(),
      );
      assert.notEqual(result.details?.error, "self-spawn blocked", "another agent is a legitimate spawn");
      assert.match(String(result.details?.error), /no session file|tmux not available/);
      assert.equal(launch.calls.count, 0, "stopped at the prerequisite check, before any pane");
    } finally {
      launch.restore();
    }
  });

  // ── Allowlist branch (PI_SUBAGENT_ALLOWED, seeded into SUBAGENT_ALLOWLIST at load) ──

  describe("PI_SUBAGENT_ALLOWED", () => {
    const ALLOWED = "scout,planner";

    /** Set up a fresh module instance whose load-time allowlist is ALLOWED. */
    async function setupAllowlisted(agentEnv?: string) {
      // The module URL encodes the env, so all four tests below share ONE cached
      // instance and its mutable chainsBySession — the random sessionId from
      // beforeEach is what makes the "chain must not be registered" checks
      // meaningful rather than accidentally empty.
      const mock = createMockExtensionApi();
      const fresh = await loadModuleWithEnv({
        PI_SUBAGENT_ALLOWED: ALLOWED,
        // The load-time model-override snapshot is seeded the same way; pin it
        // off so a leftover ambient value cannot leak into this instance.
        PI_SUBAGENT_MODEL_OVERRIDES: undefined,
      });
      const freshApi = (fresh as any).__test__;
      // Sanity: this really is a second instance with its own state, and the
      // main instance is untouched (its allowlist stayed null).
      assert.notEqual(fresh, subagentsModule, "expected a distinct module instance");
      assert.notEqual(freshApi.chainsBySession, testApi.chainsBySession, "the fresh instance owns its chain maps");
      assert.notEqual(freshApi.chainHooks, testApi.chainHooks, "the fresh instance owns its step runner");
      assert.ok(
        testApi.discoverAgentDefinitions().some((a: any) => a.name === "worker"),
        "the imported instance must stay unrestricted",
      );
      (fresh as any).default(mock.api);
      if (agentEnv === undefined) delete process.env.PI_SUBAGENT_AGENT;
      else process.env.PI_SUBAGENT_AGENT = agentEnv;
      return { mock, fresh, freshApi };
    }

    it("restricts the discoverable agent set to the allowlist", async () => {
      const { freshApi } = await setupAllowlisted();
      const names = freshApi.discoverAgentDefinitions().map((a: any) => a.name).sort();
      assert.ok(names.includes("planner") && names.includes("scout"), `allowed agents are listed: ${names}`);
      assert.ok(!names.includes("worker"), `a non-allowed agent must not be listed: ${names}`);
      // Exactly "what an unrestricted session sees", intersected with the pin.
      const unrestricted = testApi.discoverAgentDefinitions().map((a: any) => a.name);
      assert.deepEqual(names, unrestricted.filter((n: string) => ALLOWED.split(",").includes(n)).sort());
      assert.equal(freshApi.widgetRefreshActive(), false, "importing and registering must not arm a timer");
    });

    it("rejects a single spawn outside the allowlist, before launching anything", async () => {
      const { mock, freshApi } = await setupAllowlisted();
      const subagentTool = mock.registeredTools.find((tool) => tool.name === "subagent");
      const launch = stubLaunch(freshApi);
      try {
        const result = await subagentTool.execute(
          "call-1",
          { agent: "worker", task: "do it" },
          undefined,
          undefined,
          // See the note above: the allowlist guard also fires before the
          // session-file check, and the single-spawn path bypasses the
          // stubLaunch seam — so keep the ctx session-less.
          mockCtxNoSession(),
        );
        assert.equal(result.details?.error, "agent not in allowlist");
        assert.equal(
          result.content[0].text,
          'You may not spawn the "worker" agent — it is not in your allowlist. Available agents: scout, planner.',
        );
        assert.equal(launch.calls.count, 0, "no pane should have been launched");
        assert.equal(mock.sentMessages.length, 0, "no steer should have been sent");
      } finally {
        launch.restore();
      }
    });

    it("rejects a chain step outside the allowlist, before registering the chain", async () => {
      const { mock, freshApi } = await setupAllowlisted();
      const subagentTool = mock.registeredTools.find((tool) => tool.name === "subagent");
      const steps = stubRunStep(freshApi);
      try {
        const result = await subagentTool.execute(
          "call-1",
          { chain: [{ agent: "scout", task: "a" }, { agent: "worker", task: "b" }] },
          undefined,
          undefined,
          mockCtx(),
        );
        assert.equal(result.details?.error, "chain agent not in allowlist");
        assert.equal(result.details?.step, 2);
        assert.equal(
          result.content[0].text,
          'Chain step 2 may not spawn the "worker" agent — it is not in your allowlist. ' +
            "Available agents: scout, planner.",
        );
      } finally {
        steps.restore();
      }
      assert.equal(steps.calls.count, 0, "no step should have launched");
      assert.equal(mock.sentMessages.length, 0, "no chain steer should have been sent");
      assert.equal(freshApi.getChainMapForSession(sessionId).size, 0, "the chain must not be registered");
      assert.equal(freshApi.widgetRefreshActive(), false, "a rejected chain must not arm a refresh timer");
      // The main instance must not have picked up the fresh instance's chain.
      assert.equal(testApi.getChainMapForSession(sessionId).size, 0, "the main instance saw nothing");
    });

    it("still applies the self-spawn guard to an allowlisted agent", async () => {
      // "planner" passes the allowlist check, so this proves the two guards are
      // independent: the rejection must come from the self-spawn guard, not the
      // allowlist one, and it must still land before registration.
      const { mock, freshApi } = await setupAllowlisted("planner");
      const subagentTool = mock.registeredTools.find((tool) => tool.name === "subagent");
      const steps = stubRunStep(freshApi);
      try {
        const result = await subagentTool.execute(
          "call-1",
          { chain: [{ agent: "planner", task: "plan it" }] },
          undefined,
          undefined,
          mockCtx(),
        );
        assert.equal(result.details?.error, "self-spawn blocked");
        assert.equal(result.details?.step, 1);
        assert.match(result.content[0].text, /a chain cannot include another planner/);
      } finally {
        steps.restore();
      }
      assert.equal(steps.calls.count, 0, "no step should have launched");
      assert.equal(freshApi.getChainMapForSession(sessionId).size, 0, "the chain must not be registered");
    });
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_message and not the old interrupt/resume tools", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_message"), true);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });

  it("resolves a running subagent by exact name and reports ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byName = testApi.resolveRunningByName("Scout");
      assert.equal(byName.running.id, "c3");

      const ambiguous = testApi.resolveRunningByName("Worker");
      assert.match(ambiguous.error, /Ambiguous subagent name/);

      const missing = testApi.resolveRunningByName("Ghost");
      assert.match(missing.error, /No running subagent named "Ghost"/);
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName suffixes defaulted names that collide with running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // No collision: base name is returned untouched.
      assert.equal(testApi.uniqueRunningName("worker"), "worker");

      runningMap.set("a1", makeRunning({ id: "a1", name: "worker", surface: "a1" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-2");

      runningMap.set("b2", makeRunning({ id: "b2", name: "worker-2", surface: "b2" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-3");

      // A distinct base is unaffected by the worker collisions.
      assert.equal(testApi.uniqueRunningName("scout"), "scout");
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName also avoids names already taken in the persistent registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // A finished subagent's name lives in the registry even though nothing is
      // running — a fresh default must skip it so names stay unique session-wide.
      const registryNames = new Set(["worker", "worker-2"]);
      assert.equal(testApi.uniqueRunningName("worker", registryNames), "worker-3");
      // A name not in the registry (or running/reserved) is unaffected.
      assert.equal(testApi.uniqueRunningName("scout", registryNames), "scout");
      // An empty registry behaves like before.
      assert.equal(testApi.uniqueRunningName("worker", new Set()), "worker");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("uniqueRunningName also avoids names reserved by in-flight parallel spawns", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Simulate the first parallel spawn reserving its default name before it
      // has registered in runningSubagents.
      reserved.add(testApi.uniqueRunningName("scout")); // "scout"
      // The second spawn, running concurrently, must not reuse it.
      assert.equal(testApi.uniqueRunningName("scout"), "scout-2");
      reserved.add("scout-2");
      assert.equal(testApi.uniqueRunningName("scout"), "scout-3");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("steers a running subagent by typing into its pane (newlines flattened)", () => {
    const testApi = (subagentsModule as any).__test__;
    let sentSurface = "";
    let sentText = "";
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "do this\nthen that", (surface: string, text: string) => {
      sentSurface = surface;
      sentText = text;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(sentText, "do this then that");
  });

  it("returns an explicit error when steering delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "hi", () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to deliver message/);
  });

  it("deliverSubagentSteer: .ask present → writes the reply file, reports 'reply', types nothing", () => {
    const testApi = (subagentsModule as any).__test__;
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "s.jsonl");
      const running = makeRunning({ sessionFile });
      writeFileSync(
        `${sessionFile}.ask`,
        JSON.stringify({ name: "Worker", agent: "scout", question: "q?", askedAt: 7 }),
      );
      const sent: string[] = [];

      const result = testApi.deliverSubagentSteer(running, "the reply", (surface: string, text: string) => {
        sent.push(text);
      });

      assert.deepEqual(result, { mode: "reply" });
      assert.deepEqual(sent, [], "nothing is typed into the pane");
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.ask-reply`, "utf8")),
        { askedAt: 7, text: "the reply" },
        "the reply is JSON echoing the .ask file's askedAt for correlation",
      );
      assert.ok(existsSync(`${sessionFile}.ask`), ".ask is left for the child to clean up");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deliverSubagentSteer: .ask absent → types into the pane, reports 'typed', writes no file", () => {
    const testApi = (subagentsModule as any).__test__;
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "s.jsonl");
      const running = makeRunning({ sessionFile });
      const sent: string[] = [];

      const result = testApi.deliverSubagentSteer(running, "hello", (surface: string, text: string) => {
        sent.push(text);
      });

      assert.deepEqual(result, { mode: "typed" });
      assert.deepEqual(sent, ["hello"]);
      assert.ok(!existsSync(`${sessionFile}.ask-reply`), "no reply file written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deliverSubagentSteer: typing failure surfaces an error", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();

    const result = testApi.deliverSubagentSteer(running, "hi", () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to deliver message/);
  });

  it("handleSubagentSteer: pending .ask routes the message to the reply file, not the pane", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const dir = createTestDir();
    let sentText = "";
    runningMap.clear();

    try {
      const sessionFile = join(dir, "s.jsonl");
      runningMap.set("a1", makeRunning({ sessionFile }));
      writeFileSync(`${sessionFile}.ask`, JSON.stringify({ name: "Worker", agent: "scout", question: "q?" }));

      const result = testApi.handleSubagentSteer({ name: "Worker", message: "the answer" }, (surface: string, text: string) => {
        sentText = text;
      });

      assert.equal(sentText, "", "nothing typed into the pane");
      assert.ok(result.content[0].text.includes('Reply delivered to subagent "Worker"'), "reply-mode ack is returned");
      assert.ok(result.content[0].text.includes("ask_question"), "the ack names the blocked call");
      assert.ok(!result.content[0].text.includes("turn boundary"), "the ack must not claim a turn-boundary pickup in reply mode");
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      assert.equal(readFileSync(`${sessionFile}.ask-reply`, "utf8"), "the answer");
      assert.ok(existsSync(`${sessionFile}.ask`), ".ask is left for the child to clean up");
    } finally {
      runningMap.clear();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("after an aborted wait, the next subagent_message is typed into the pane, not swallowed", async () => {
    // The critical regression: an aborted ask_question used to leave `.ask`
    // in place, so the orchestrator's next subagent_message — naturally the
    // reply to the question just asked — was written into `.ask-reply` and
    // silently lost (the parent still acked "Message delivered"). The abort
    // path must unlink `.ask` first, so steers fall back to pane-typing.
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const dir = createTestDir();
    const sessionFile = join(dir, "s.jsonl");
    runningMap.clear();

    // Child side: register ask_question against this session file.
    const savedSession = process.env.PI_SUBAGENT_SESSION;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    const childTools: any[] = [];
    const childApi = {
      on() {},
      registerTool(t: any) { childTools.push(t); },
      registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
      sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
    } as any;
    subagentDoneExtension(childApi);
    const askTool = childTools.find((t) => t.name === "ask_question");

    const savedPoll = subagentDoneTest.askQuestion.pollMs;
    const savedTimeout = subagentDoneTest.askQuestion.timeoutMs;
    subagentDoneTest.askQuestion.pollMs = 25;
    subagentDoneTest.askQuestion.timeoutMs = 500;
    const ac = new AbortController();
    const sent: string[] = [];

    try {
      const pending = askTool.execute("c1", { question: "q?" }, ac.signal, undefined, { shutdown() {} })
        .then(() => assert.fail("execute should throw on abort"), (err: any) => err);
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(existsSync(`${sessionFile}.ask`), ".ask present while blocked");
      ac.abort();
      const err = await pending;
      assert.match(err.message, /Interrupted while waiting for the orchestrator reply/);
      assert.ok(!existsSync(`${sessionFile}.ask`), "the abort path unlinks .ask");

      // The orchestrator's reply — the next subagent_message — must now be
      // typed into the pane as a normal steer, not swallowed into the sidecar.
      runningMap.set("a1", makeRunning({ sessionFile }));
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "the answer" }, (surface: string, text: string) => {
        sent.push(text);
      });
      assert.deepEqual(sent, ["the answer"], "steer typed into the pane");
      assert.ok(!existsSync(`${sessionFile}.ask-reply`), "no reply sidecar written");
      assert.match(result.content[0].text, /Message delivered to running subagent "Worker"/, "typed-mode ack");
    } finally {
      subagentDoneTest.askQuestion.pollMs = savedPoll;
      subagentDoneTest.askQuestion.timeoutMs = savedTimeout;
      restoreEnvVar("PI_SUBAGENT_SESSION", savedSession);
      runningMap.clear();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reply-mode steer leaves statusState as the activity observer left it (no interrupt force)", () => {
    // forceStatusAfterInterrupt is only for pane-typed steers: a sidecar
    // reply doesn't interrupt the child's TUI, so its status must be exactly
    // what the activity observation produced.
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const dir = createTestDir();
    runningMap.clear();
    const makeActive = () =>
      observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        {
          snapshot: "present",
          updatedAt: 5_000,
          sequence: 1,
          phase: "active",
          active: true,
          activeScope: "tool",
          activeSince: 5_000,
          activityLabel: "bash",
        },
        5_000,
      );
    // Baseline: what observeRunningSubagent alone does to this state.
    const baseline = makeRunning({ statusState: makeActive() });
    withMockedNow(20_000, () => testApi.observeRunningSubagent(baseline, 20_000));

    try {
      const sessionFile = join(dir, "s.jsonl");
      const running = makeRunning({ sessionFile, statusState: makeActive() });
      runningMap.set("a1", running);
      writeFileSync(`${sessionFile}.ask`, JSON.stringify({ name: "Worker", agent: "scout", question: "q?" }));
      let typed = "";
      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "the answer" }, (surface: string, text: string) => {
          typed = text;
        }),
      );
      assert.equal(typed, "", "nothing typed into the pane");
      assert.match(result.content[0].text, /Reply delivered to subagent "Worker"/);
      assert.deepEqual(
        running.statusState,
        baseline.statusState,
        "reply mode applies no interrupt force — observation only",
      );
      assert.notEqual(running.statusState.activityLabel, "interrupted");
    } finally {
      runningMap.clear();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deliverSubagentSteer: reply-write failure surfaces an error (no silent swallow)", () => {
    const testApi = (subagentsModule as any).__test__;
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "s.jsonl");
      const replyFile = `${sessionFile}.ask-reply`;
      mkdirSync(replyFile); // a directory where the reply file must land → rename fails
      writeFileSync(
        `${sessionFile}.ask`,
        JSON.stringify({ name: "Worker", agent: "scout", question: "q?", askedAt: 1 }),
      );
      const running = makeRunning({ sessionFile });

      const result = testApi.deliverSubagentSteer(running, "the reply", (surface: string, text: string) => {
        throw new Error("must not type into the pane while a reply is pending");
      });

      assert.match(result.error, /Failed to write the ask_question reply file/);
      const leftovers = readdirSync(dir).filter((f) => f.startsWith(`${sessionFile}.ask-reply.tmp-`));
      assert.deepEqual(leftovers, [], "temp file cleaned up after the failed write");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stale .ask with a non-asking child does not misroute the steer (typed into the pane)", () => {
    // The child is working (latest activity: a tool result, not the
    // ask_question event), yet a stale .ask sits on its session file. The
    // activity cross-check must keep the steer out of the reply sidecar.
    const testApi = (subagentsModule as any).__test__;
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "s.jsonl");
      const activityFile = join(dir, "activity.json");
      writeFileSync(
        activityFile,
        JSON.stringify({
          version: 1,
          runningChildId: "a1",
          createdAt: 1_000,
          updatedAt: 2_000,
          sequence: 3,
          latestEvent: "tool_execution_end",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: false,
        }),
      );
      writeFileSync(
        `${sessionFile}.ask`,
        JSON.stringify({ name: "Worker", agent: "scout", question: "q?", askedAt: 1 }),
      );
      const running = makeRunning({ sessionFile, activityFile });
      const sent: string[] = [];

      const result = testApi.deliverSubagentSteer(running, "keep going", (surface: string, text: string) => {
        sent.push(text);
      });

      assert.deepEqual(result, { mode: "typed" }, "a non-asking child is steered, not replied");
      assert.deepEqual(sent, ["keep going"], "typed into the pane, not the sidecar");
      assert.ok(!existsSync(`${sessionFile}.ask-reply`), "no reply sidecar written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a child actively blocked in ask_question still gets the reply routed to the sidecar", () => {
    // Positive control for the activity cross-check: the child's activity
    // shows the ask_question park → the message IS the reply.
    const testApi = (subagentsModule as any).__test__;
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "s.jsonl");
      const activityFile = join(dir, "activity.json");
      writeFileSync(
        activityFile,
        JSON.stringify({
          version: 1,
          runningChildId: "a1",
          createdAt: 1_000,
          updatedAt: 2_000,
          sequence: 4,
          latestEvent: "ask_question",
          phase: "waiting",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: false,
          waitingSince: 2_000,
        }),
      );
      writeFileSync(
        `${sessionFile}.ask`,
        JSON.stringify({ name: "Worker", agent: "scout", question: "q?", askedAt: 9 }),
      );
      const running = makeRunning({ sessionFile, activityFile });
      const sent: string[] = [];

      const result = testApi.deliverSubagentSteer(running, "the answer", (surface: string, text: string) => {
        sent.push(text);
      });

      assert.deepEqual(result, { mode: "reply" }, "a blocked child gets the sidecar reply");
      assert.deepEqual(sent, [], "nothing typed into the pane");
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.ask-reply`, "utf8")),
        { askedAt: 9, text: "the answer" },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers a steer message and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    let sentText = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, (surface: string, text: string) => {
          sentSurface = surface;
          sentText = text;
        }),
      );

      assert.equal(sentSurface, "pane-1");
      assert.equal(sentText, "keep going");
      assert.equal(result.content[0].text.includes('Message delivered to running subagent "Worker"'), true);
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("requires a message when steering", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning());
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "  " }, () => {});
      assert.match(result.content[0].text, /`message` is required/);
    } finally {
      runningMap.clear();
    }
  });

  it("leaves status unchanged when steering delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "go" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to deliver message/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-abc",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    // Follow-ups reference the name (not the session id).
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-xyz",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });

  it("shows a current/total step counter next to the agent tag for chain steps", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      for (const step of [1, 2, 3]) {
        const lines = testApi.renderSubagentWidgetLines(
          [
            {
              id: "c1",
              name: "finalize-fit-redesign",
              agent: "worker",
              chainStep: step,
              chainStepTotal: 3,
              task: "",
              surface: "s1",
              startTime: 1_000_000 - 44_000,
              sessionFile: "sess1",
              statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 44_000 }),
            },
          ],
          100,
        );

        const row = stripAnsi(lines[1]);
        assert.ok(
          row.includes(`finalize-fit-redesign (worker) ${step}/3 `),
          `expected "${step}/3" next to the agent tag, got: ${row}`,
        );
      }
    } finally {
      Date.now = originalNow;
    }
  });

  it("renders non-chain rows exactly as before (no counter, no stray spaces)", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const startTime = 1_000_000 - 44_000;
      const state = createStatusState({ source: "pi", startTimeMs: startTime });
      const snapshot = classifyStatus(state, 1_000_000);
      const icon = stripAnsi(testApi.widgetIcon(snapshot.kind));
      const right = testApi.formatWidgetRightLabel(snapshot);

      // With an agent tag: the row must match the pre-counter layout exactly.
      const tagged = {
        id: "a1",
        name: "worker-1",
        agent: "worker",
        task: "",
        surface: "s1",
        startTime,
        sessionFile: "sess1",
        statusState: state,
      };
      const taggedRow = stripAnsi(testApi.renderSubagentWidgetLines([tagged], 80)[1]);
      const expectedTagged = stripAnsi(
        testApi.borderLine(` ${icon} 00:44  worker-1 (worker) `, right, 80),
      );
      assert.equal(taggedRow, expectedTagged);
      assert.ok(!/\d+\/\d+/.test(taggedRow), `expected no step counter, got: ${taggedRow}`);

      // Without an agent tag: same, and no stray spaces where a tag would be.
      const untagged = { ...tagged, id: "a2", name: "solo", agent: undefined, surface: "s2", sessionFile: "sess2" };
      const untaggedRow = stripAnsi(testApi.renderSubagentWidgetLines([untagged], 80)[1]);
      const expectedUntagged = stripAnsi(
        testApi.borderLine(` ${icon} 00:44  solo `, right, 80),
      );
      assert.equal(untaggedRow, expectedUntagged);
      assert.ok(!/\d+\/\d+/.test(untaggedRow), `expected no step counter, got: ${untaggedRow}`);
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps chain-step rows within the width limit when the counter is present", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const startTime = 1_000_000 - 44_000;
      const agent = {
        id: "c1",
        name: "finalize-fit-redesign",
        agent: "worker",
        chainStep: 1,
        chainStepTotal: 3,
        task: "",
        surface: "s1",
        startTime,
        sessionFile: "sess1",
        statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
      };

      // Narrow widths truncate the left content (counter included) rather than
      // overflow; wide widths keep the counter intact.
      for (const width of [0, 1, 2, 16, 20, 24, 40, 60]) {
        const lines = testApi.renderSubagentWidgetLines([agent], width);
        for (const line of lines) {
          assert.ok(
            visibleWidth(line) <= width,
            `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
          );
        }
      }

      const wideRow = stripAnsi(testApi.renderSubagentWidgetLines([agent], 100)[1]);
      assert.ok(wideRow.includes("finalize-fit-redesign (worker) 1/3 "), wideRow);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("subagent display helpers", () => {
  const testApi = (subagentsModule as any).__test__;

  describe("formatTokens", () => {
    it("renders raw counts below 1k, 1 decimal below 10k, rounded k above", () => {
      assert.equal(testApi.formatTokens(850), "850");
      assert.equal(testApi.formatTokens(3200), "3.2k");
      assert.equal(testApi.formatTokens(45000), "45k");
    });
  });

  describe("contextWindowFor", () => {
    it("maps known model families and returns undefined otherwise", () => {
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6"), 200_000);
      assert.equal(testApi.contextWindowFor("gemini-2.5-pro"), 1_000_000);
      assert.equal(testApi.contextWindowFor("some-unknown-model"), undefined);
      assert.equal(testApi.contextWindowFor(null), undefined);
    });

    /**
     * Minimal ModelRegistryLike over a fixed model list — the same idiom as the
     * fake `modelRegistry.getAvailable` ctx used by the command tests, but with
     * the synchronous getAll()/find() the gauge uses. `withFind: false` yields a
     * registry that only exposes getAll() (the /agent_model-style minimal fake).
     */
    function fakeRegistry(
      models: Array<{ id: string; provider?: string; contextWindow?: number }>,
      opts: { withFind?: boolean } = {},
    ) {
      const registry: any = { getAll: () => models };
      if (opts.withFind !== false) {
        registry.find = (provider: string, modelId: string) =>
          models.find((m) => m.provider === provider && m.id === modelId);
      }
      return registry;
    }

    it("prefers a registry hit over the name table", () => {
      const registry = fakeRegistry([
        { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 400_000 },
      ]);
      // The name table would say 200k for anything containing "claude".
      assert.equal(testApi.contextWindowFor("anthropic/claude-sonnet-4-6", registry), 400_000);
      // A bare id that matches exactly one registry entry resolves too.
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6", registry), 400_000);
    });

    it("falls back to the name table when the registry has no match", () => {
      const registry = fakeRegistry([{ provider: "vllm", id: "qwen3.8-flash-next", contextWindow: 250_000 }]);
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6", registry), 200_000);
      assert.equal(testApi.contextWindowFor("openai/gpt-4.1", registry), 128_000);
      assert.equal(testApi.contextWindowFor("some-unknown-model", registry), undefined);
    });

    it("resolves a model the name table cannot know from a unique bare id", () => {
      // The reported bug: vllm/qwen3.8-flash-next rendered as "37k ctx", no gauge.
      const registry = fakeRegistry([
        { provider: "vllm", id: "qwen3.8-flash-next", contextWindow: 250_000 },
        { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 200_000 },
      ]);
      assert.equal(testApi.contextWindowFor("qwen3.8-flash-next", registry), 250_000);
      assert.equal(
        testApi.formatContextUsage(45_000, testApi.contextWindowFor("vllm/qwen3.8-flash-next", registry)),
        "18.0%/250k",
      );
    });

    it("never guesses an ambiguous bare id, but a provider argument resolves it", () => {
      // Same id under two providers with different windows (the user's real
      // models.json): bare-id matching must not pick one.
      const registry = fakeRegistry([
        { provider: "vllm", id: "qwen3.8-27b", contextWindow: 250_000 },
        { provider: "llama.cpp", id: "qwen3.8-27b", contextWindow: 32_000 },
      ]);
      assert.equal(testApi.contextWindowFor("qwen3.8-27b", registry), undefined);
      assert.equal(testApi.contextWindowFor("qwen3.8-27b", registry, "llama.cpp"), 32_000);
      assert.equal(testApi.contextWindowFor("qwen3.8-27b", registry, "vllm"), 250_000);
      assert.equal(testApi.contextWindowFor("llama.cpp/qwen3.8-27b", registry), 32_000);
      // Ambiguous + a name-table family falls back to the table, not a registry guess.
      const ambiguousClaude = fakeRegistry([
        { provider: "vllm", id: "claude-ish", contextWindow: 400_000 },
        { provider: "llama.cpp", id: "claude-ish", contextWindow: 8_000 },
      ]);
      assert.equal(testApi.contextWindowFor("claude-ish", ambiguousClaude), 200_000);
    });

    it("matches provider + id exactly, with or without a find() method", () => {
      const models = [
        { provider: "vllm", id: "moe-9b", contextWindow: 64_000 },
        { provider: "llama.cpp", id: "moe-9b", contextWindow: 16_000 },
      ];
      assert.equal(testApi.contextWindowFor("llama.cpp/moe-9b", fakeRegistry(models)), 16_000);
      // A registry that only exposes getAll() must still resolve provider+id.
      assert.equal(
        testApi.contextWindowFor("llama.cpp/moe-9b", fakeRegistry(models, { withFind: false })),
        16_000,
      );
      assert.equal(testApi.contextWindowFor("vllm/moe-9b", fakeRegistry(models, { withFind: false })), 64_000);
      // Unknown provider never matches on id alone.
      assert.equal(testApi.contextWindowFor("ollama/moe-9b", fakeRegistry(models)), undefined);
    });

    it("treats a zero or missing registry contextWindow as a miss", () => {
      const zero = fakeRegistry([{ provider: "vllm", id: "qwen3.8-flash-next", contextWindow: 0 }]);
      assert.equal(testApi.contextWindowFor("vllm/qwen3.8-flash-next", zero), undefined);
      assert.equal(testApi.contextWindowFor("qwen3.8-flash-next", zero), undefined);
      const absent = fakeRegistry([{ provider: "vllm", id: "claude-sonnet-4-6" }]);
      assert.equal(testApi.contextWindowFor("vllm/claude-sonnet-4-6", absent), 200_000);
    });

    it("survives a registry that throws or is empty", () => {
      const boom: any = { getAll: () => { throw new Error("models.json failed to load"); } };
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6", boom), 200_000);
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6", fakeRegistry([])), 200_000);
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6", null), 200_000);
    });

    it("uses the session_start registry snapshot and stats.provider when rendering", () => {
      // End-to-end wiring: the subagent_result renderer has no ExtensionContext,
      // so it reads the ctx captured at session_start (index.ts latestCtx) and
      // pairs the registry with the provider that summarizeSessionStats recorded
      // next to the model. Without that pairing an id that exists under two
      // providers would render with no gauge at all.
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const renderers: Array<{ name: string; renderer: any }> = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool() {},
        registerCommand() {},
        registerShortcut() {},
        registerMessageRenderer(name: string, renderer: any) {
          renderers.push({ name, renderer });
        },
        sendUserMessage() {},
        sendMessage() {},
        getAllTools() {
          return [];
        },
      } as any;
      (subagentsModule as any).default(api);
      const entry = renderers.find((r) => r.name === "subagent_result");
      assert.ok(entry, "expected the subagent_result renderer to be registered");
      const emit = (event: string, ...args: any[]) =>
        (handlers.get(event) ?? []).forEach((h) => h(...args));

      const models = [
        { provider: "vllm", id: "qwen3.8-27b", contextWindow: 250_000 },
        { provider: "llama.cpp", id: "qwen3.8-27b", contextWindow: 32_000 },
      ];
      const registry = { getAll: () => models, find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id), getAvailable: () => [] };
      // hasUI false keeps the widget path a no-op, and the registry is emptied
      // afterwards so no later test sees this one.
      const quietCtx: any = { hasUI: false, ui: {}, modelRegistry: fakeRegistry([]), sessionManager: {} };
      const theme: any = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
      const render = (provider: string | null) =>
        entry
          .renderer(
            {
              role: "user",
              content: 'Sub-agent "Scout" completed (1m).\n\nDone.',
              details: {
                name: "Scout",
                agent: "scout",
                exitCode: 0,
                elapsed: 60_000,
                stats: {
                  model: "qwen3.8-27b",
                  provider,
                  toolCount: 2,
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  contextTokens: 45_000,
                  cost: 0.01,
                },
              },
            },
            { expanded: true },
            theme,
          )
          .render(120)
          .join("\n");

      try {
        emit("session_start", {}, { ...quietCtx, modelRegistry: registry });
        // The provider decides which of the two same-id models the gauge uses.
        assert.match(render("vllm"), /18\.0%\/250k/);
        assert.match(render("llama.cpp"), /140\.6%\/32k/);
        // No provider -> ambiguous bare id -> never guessed: window-less label.
        assert.match(render(null), /45k ctx/);
      } finally {
        emit("session_start", {}, quietCtx);
      }
    });
  });

  describe("formatContextUsage", () => {
    it("shows a percent gauge when the window is known", () => {
      assert.equal(testApi.formatContextUsage(36_000, 200_000), "18.0%/200k");
      assert.equal(testApi.formatContextUsage(500_000, 1_000_000), "50.0%/1.0M");
    });

    it("falls back to a window-less ctx label when unknown", () => {
      assert.equal(testApi.formatContextUsage(37_000, undefined), "37k ctx");
    });
  });

  describe("formatUsageSegments", () => {
    it("emits arrow/cache/cost segments, skipping zero fields", () => {
      const segs = testApi.formatUsageSegments({
        model: "claude-sonnet-4-6",
        toolCount: 3,
        inputTokens: 3200,
        outputTokens: 890,
        cacheReadTokens: 45000,
        cacheWriteTokens: 0,
        contextTokens: 7000,
        cost: 0.042,
      });
      assert.deepEqual(segs, ["↑3.2k", "↓890", "R45k", "$0.042"]);
    });

    it("returns an empty list when there is no usage", () => {
      assert.deepEqual(
        testApi.formatUsageSegments({
          model: null,
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: 0,
          cost: 0,
        }),
        [],
      );
    });
  });

  describe("widgetIcon", () => {
    it("maps active/running to a glyph and waiting/starting to another", () => {
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(strip(testApi.widgetIcon("active")), "⟳");
      assert.equal(strip(testApi.widgetIcon("running")), "⟳");
      assert.equal(strip(testApi.widgetIcon("stalled")), "⟳");
      assert.equal(strip(testApi.widgetIcon("waiting")), "○");
      assert.equal(strip(testApi.widgetIcon("starting")), "○");
    });
  });
});

describe("tmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });
});

describe("web tools (web_search / web_fetch)", () => {
  const sampleData = {
    query: "pi coding agent",
    results: [
      { title: "Pi Coding Agent", url: "https://pi.dev/", snippet: "  Pi is a minimal\nagent harness.\n" },
      { title: "GitHub - pi", url: "https://github.com/earendil-works/pi", snippet: "" },
    ],
    answers: [],
    unresponsiveEngines: [],
  };

  const jsonFetch = (payload: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

  describe("web_search", () => {
    it("builds the SearXNG request and maps results", async () => {
      let seenUrl: URL | null = null;
      const fetchImpl = (async (input: any) => {
        seenUrl = new URL(input);
        return new Response(
          JSON.stringify({ query: "q", results: sampleData.results.map((r) => ({ title: r.title, url: r.url, content: r.snippet })), answers: [], unresponsive_engines: [] }),
          { status: 200 },
        );
      }) as typeof fetch;
      const data = await searchSearxng("pi coding agent", 5, {
        fetchImpl,
        baseUrl: "http://sx.local/",
      });
      assert.ok(seenUrl);
      assert.equal(seenUrl.origin, "http://sx.local");
      assert.equal(seenUrl.pathname, "/search");
      assert.equal(seenUrl.searchParams.get("q"), "pi coding agent");
      assert.equal(seenUrl.searchParams.get("format"), "json");
      assert.equal(data.results.length, 2);
      assert.equal(data.results[0].url, "https://pi.dev/");
      assert.equal(data.unresponsiveEngines.length, 0);
    });

    it("clamps count to 1..10", async () => {
      const many = Array.from({ length: 15 }, (_, i) => ({
        title: `t${i}`,
        url: `https://e.com/${i}`,
        content: `s${i}`,
      }));
      const data = await searchSearxng("q", 99, {
        fetchImpl: jsonFetch({ results: many }),
      });
      assert.equal(data.results.length, 10);
      const one = await searchSearxng("q", 0, {
        fetchImpl: jsonFetch({ results: many }),
      });
      assert.equal(one.results.length, 1);
    });

    it("uses SEARXNG_URL env for the endpoint", async () => {
      const prev = process.env.SEARXNG_URL;
      process.env.SEARXNG_URL = "http://custom:9999/";
      try {
        let seenUrl: URL | null = null;
        const fetchImpl = (async (input: any) => {
          seenUrl = new URL(input);
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }) as typeof fetch;
        await searchSearxng("q", 3, { fetchImpl });
        assert.equal(seenUrl!.origin, "http://custom:9999");
      } finally {
        if (prev === undefined) delete process.env.SEARXNG_URL;
        else process.env.SEARXNG_URL = prev;
      }
    });

    it("defaults to the docker-bridge SearXNG URL when no env is set", () => {
      assert.equal(DEFAULT_SEARXNG_URL, "http://host.docker.internal:8088");
    });

    it("formats numbered results, answers, and engine notes", () => {
      const { text } = formatSearchResults(sampleData);
      assert.match(text, /1\. Pi Coding Agent\n   https:\/\/pi\.dev\//);
      assert.match(text, /2\. GitHub - pi/);
      assert.match(text, /Pi is a minimal agent harness\./); // flattened snippet
      const withNotes = formatSearchResults({
        ...sampleData,
        answers: ["Pi is a coding agent."],
        unresponsiveEngines: ["brave", "google"],
      });
      assert.match(withNotes.text, /Answers:\n- Pi is a coding agent\./);
      assert.match(withNotes.text, /upstream engines were temporarily unavailable — brave, google/);
    });

    it("distinguishes 'no results' from 'engines down' when empty", () => {
      const empty = formatSearchResults({ ...sampleData, results: [] });
      assert.match(empty.text, /No results found for "pi coding agent"\./);
      const down = formatSearchResults({
        ...sampleData,
        results: [],
        unresponsiveEngines: ["google"],
      });
      assert.match(down.text, /upstream engines are temporarily unavailable \(google\)/);
      assert.match(down.text, /Retry in a minute/);
    });

    it("throws a helpful error when the instance is unreachable", async () => {
      const fetchImpl = (async () => {
        throw new Error("fetch failed");
      }) as typeof fetch;
      await assert.rejects(
        searchSearxng("q", 3, { fetchImpl }),
        /SearXNG unreachable at http:\/\/host\.docker\.internal:8088: fetch failed/,
      );
    });

    it("throws on HTTP errors and non-JSON responses", async () => {
      const httpErr = (async () =>
        new Response("Forbidden", { status: 403 })) as typeof fetch;
      await assert.rejects(searchSearxng("q", 3, { fetchImpl: httpErr }), /HTTP 403/);
      const notJson = (async () =>
        new Response("<html>nope</html>", { status: 200 })) as typeof fetch;
      await assert.rejects(
        searchSearxng("q", 3, { fetchImpl: notJson }),
        /non-JSON/,
      );
    });

    describe("cross-process rate limiter", () => {
      let dir: string;
      let prevIntervalEnv: string | undefined;
      let prevDirEnv: string | undefined;
      before(() => {
        dir = mkdtempSync(join(tmpdir(), "websearch-rl-"));
        prevIntervalEnv = process.env.WEB_SEARCH_MIN_INTERVAL_S;
        prevDirEnv = process.env.WEB_SEARCH_RL_DIR;
      });
      after(() => {
        rmSync(dir, { recursive: true, force: true });
        if (prevIntervalEnv === undefined) delete process.env.WEB_SEARCH_MIN_INTERVAL_S;
        else process.env.WEB_SEARCH_MIN_INTERVAL_S = prevIntervalEnv;
        if (prevDirEnv === undefined) delete process.env.WEB_SEARCH_RL_DIR;
        else process.env.WEB_SEARCH_RL_DIR = prevDirEnv;
      });
      beforeEach(() => {
        process.env.WEB_SEARCH_RL_DIR = dir;
      });

      const stateFile = (tag: string) => join(dir, `state-${tag}.json`);

      it("is disabled when the interval is 0", async () => {
        const sf = stateFile("off");
        const waited = await waitForSearchSlot("http://sx", { intervalMs: 0, stateFile: sf });
        assert.equal(waited, 0);
        assert.ok(!existsSync(sf), "no state file should be written when disabled");
      });

      it("paces a second call to the full interval", async () => {
        const sf = stateFile("pace");
        const INTERVAL = 2000;
        const t0 = Date.now();
        const first = await waitForSearchSlot("http://sx", { intervalMs: INTERVAL, stateFile: sf });
        assert.ok(first < 300, `first call should not wait (waited ${first}ms)`);

        const t1 = Date.now();
        const second = await waitForSearchSlot("http://sx", { intervalMs: INTERVAL, stateFile: sf });
        const elapsedBetween = Date.now() - t1;
        assert.ok(second >= INTERVAL - 300, `second call should wait ~interval (waited ${second}ms)`);
        // The state file should now record a lastRequest ~interval after the first.
        const data = JSON.parse(readFileSync(sf, "utf8"));
        assert.ok(typeof data.lastRequest === "number");
      });

      it("aborts while waiting for the slot", async () => {
        const sf = stateFile("abort");
        const INTERVAL = 60000;
        // Prime the slot so the next call must wait.
        await waitForSearchSlot("http://sx", { intervalMs: INTERVAL, stateFile: sf });
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 200);
        await assert.rejects(
          waitForSearchSlot("http://sx", { intervalMs: INTERVAL, stateFile: sf, signal: ac.signal }),
          /rate limit/,
        );
      });

      it("keys state per SearXNG URL", () => {
        process.env.WEB_SEARCH_RL_DIR = dir;
        assert.notEqual(rlStateFile("http://a"), rlStateFile("http://b"));
      });

      it("recovers from a stale lock", async () => {
        const sf = stateFile("stale");
        const lock = sf + ".lock";
        const INTERVAL = 2000;
        // Old lastRequest so no interval wait is due — the ONLY obstacle is the stale lock.
        writeFileSync(sf, JSON.stringify({ lastRequest: Date.now() - 10 * 60 * 1000 }));
        writeFileSync(lock, "999999");
        const old = new Date(Date.now() - 5 * 60 * 1000);
        utimesSync(lock, old, old);
        const t0 = Date.now();
        await waitForSearchSlot("http://sx", { intervalMs: INTERVAL, stateFile: sf });
        assert.ok(
          Date.now() - t0 < 1000,
          `should proceed without waiting when only a stale lock is present (took ${Date.now() - t0}ms)`,
        );
        assert.ok(!existsSync(lock), "stale lock should be cleaned up");
      });

      it("reads the interval from WEB_SEARCH_MIN_INTERVAL_S", () => {
        process.env.WEB_SEARCH_MIN_INTERVAL_S = "0";
        assert.equal(getMinIntervalMs(), 0);
        process.env.WEB_SEARCH_MIN_INTERVAL_S = "2.5";
        assert.equal(getMinIntervalMs(), 2500);
        process.env.WEB_SEARCH_MIN_INTERVAL_S = "not-a-number";
        assert.equal(getMinIntervalMs(), 61000);
        delete process.env.WEB_SEARCH_MIN_INTERVAL_S;
        assert.equal(getMinIntervalMs(), 61000);
      });
    });
  });

  describe("web_fetch", () => {
    let origFetch: typeof fetch;
    before(() => {
      origFetch = globalThis.fetch;
    });
    after(() => {
      globalThis.fetch = origFetch;
    });

    it("rejects invalid URLs without touching the network", async () => {
      globalThis.fetch = (async () => {
        throw new Error("should not be called");
      }) as typeof fetch;
      const r = await webFetchTest.fetchAndExtract("not a url");
      assert.equal(r.error, "Invalid URL");
    });

    it("extracts a readable HTML page to markdown", async () => {
      const html = [
        "<html><head><title>Test Page Title</title></head><body>",
        "<article>",
        "<h1>Test Page Heading</h1>",
        ...Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i} with some content to make readability happy about this page. The text goes on and on, well past any minimum threshold, so extraction succeeds.</p>`),
        "</article></body></html>",
      ].join("");
      globalThis.fetch = (async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as typeof fetch;
      const r = await webFetchTest.fetchAndExtract("https://example.com/page");
      assert.equal(r.error, null);
      assert.equal(r.title, "Test Page Title"); // <title> wins over h1
      assert.match(r.content, /# Test Page Heading/);
      assert.match(r.content, /Paragraph 5/);
    });

    it("fails locally on HTTP errors — no external fallback calls", async () => {
      let calls = 0;
      globalThis.fetch = (async (input: any) => {
        calls++;
        const url = String(input);
        assert.doesNotMatch(url, /jina/);
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      }) as typeof fetch;
      const r = await webFetchTest.fetchAndExtract("https://example.com/missing");
      assert.match(r.error ?? "", /HTTP 404/);
      assert.match(r.error ?? "", /may be JavaScript-rendered or otherwise unfetchable/);
      assert.equal(calls, 1, "must not phone out to any fallback service");
    });

    it("flags likely JS-rendered pages", () => {
      const jsPage = "<html><body><div id='root'></div>" +
        "<script>var a=1;</script><script>var b=2;</script><script>var c=3;</script><script>var d=4;</script>" +
        "</body></html>";
      assert.equal(webFetchTest.isLikelyJSRendered(jsPage), true);
      const textPage =
        "<html><body><p>" + "real text content ".repeat(40) + "</p></body></html>";
      assert.equal(webFetchTest.isLikelyJSRendered(textPage), false);
    });

    it("detects PDFs by content type and URL suffix", () => {
      assert.equal(webFetchTest.isPDF("https://x.com/a.pdf"), true);
      assert.equal(webFetchTest.isPDF("https://x.com/a", "application/pdf"), true);
      assert.equal(webFetchTest.isPDF("https://x.com/a", "text/html"), false);
    });
  });
});
