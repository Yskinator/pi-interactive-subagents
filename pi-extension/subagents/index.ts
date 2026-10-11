import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendCommand,
  sendLongCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  readScreen,
  isSurfaceAlive,
} from "./tmux.ts";

import {
  countSessionEntryLines,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  summarizeSessionStats,
  writeSubagentLoadout,
  type SessionStats,
  type SubagentChainContext,
  type SubagentLoadout,
} from "./session.ts";
import { registerAgentModelCommand } from "./agent-model-command.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  let controller = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  // A teardown can leave the shared controller aborted (one that cannot attribute
  // its session stops everything it can see). A watcher started after that must
  // not be born dead, so replace an aborted controller here: the watchers meant
  // to die already hold the old signal, so this aborts nothing that should live.
  if (!controller || controller.signal.aborted) {
    controller = new AbortController();
    (globalThis as any)[POLL_ABORT_KEY] = controller;
  }
  return controller.signal;
}

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
        "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents. " +
        "Required in single mode; omit it when using `chain`.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "Task/prompt for the sub-agent. Required in single mode; omit it when using `chain`. " +
        "In chain mode each step has its own task, and the previous step's output is appended to it automatically.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Optional cosmetic label for the subagent's pane and widget row. Defaults to the agent name " +
        "(auto-suffixed on collision, e.g. `worker-2`). Has no effect on which agent runs — use `agent` for that. " +
        "A name YOU supply must be free WITHIN THIS SESSION: if a running sub-agent, an in-flight spawn, a chain, " +
        "a step name another chain has reserved, or this session's registry already holds it the call is " +
        "REJECTED (it is not renamed) — pick another name. " +
        "What another session in the same process runs never blocks a name here. In chain mode this names the CHAIN (its steps " +
        "get their own names) under exactly the same rule: a chain name you supply is rejected on collision, and only " +
        "a name the system generated because you omitted `name` is auto-suffixed.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  chain: Type.Optional(
    Type.Array(
      Type.Object({
        agent: Type.String({
          description: "Which agent to spawn for this step (e.g. 'worker', 'reviewer', 'scout').",
        }),
        task: Type.String({
          description:
            "Task for this step. The previous step's final output is APPENDED to it automatically — " +
            "do not include any {previous} placeholder or paste prior output yourself.",
        }),
        name: Type.Optional(
          Type.String({
            description:
              "Optional cosmetic label for this step's pane. Defaults to the agent name (auto-suffixed when the " +
              "system generates it). A name you supply must be free WITHIN THIS SESSION — of its running sub-agents, " +
              "in-flight spawns, registry, every chain handle (including this chain's own name), and the step " +
              "names other chains of this session have reserved for their not-yet-run steps. Every one of those is checked at this tool call: a " +
              "clash is rejected immediately and the chain never starts, with `details.step` saying which step. Your own step names are then reserved for the " +
              "chain until that step starts, and released when it runs or the chain ends. The only late name failure " +
              "possible is one " +
              "taken AFTER the chain started by something in this session (a parallel spawn, or an earlier step that " +
              "registered it), which no up-front check could know about — that stops the chain at that step.",
          }),
        ),
        model: Type.Optional(Type.String({ description: "Model override for this step (overrides agent default)" })),
        cwd: Type.Optional(
          Type.String({ description: "Working directory for this step's agent process" }),
        ),
      }),
      {
        description:
          "Run a sequence of subagents one after another (a chain), e.g. worker → reviewer → worker. " +
          "Each step's final output is automatically appended to the next step's task, so follow-up steps " +
          "always receive the prior step's report/summary. Use this INSTEAD of agent+task. " +
          "The chain runs in the background; the aggregate result for the whole chain is delivered as a " +
          "steer message when the last step finishes (or the chain stops early on a failed step).",
      },
    ),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * An agent is granted these (and this extension is loaded into its child
 * process) only when its frontmatter declares a non-empty `subagent_agents`.
 */
const SPAWNING_TOOLS = [
  "subagent",
  "subagent_message",
  "subagents_list",
] as const;

/** Built-in tools pi provides natively — no extension needs to be loaded. */
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ── Runtime tool-extension registration ─────────────────────────────────────
// `getToolExtensionPath` otherwise only knows a closed set of tool names. Other
// pi extensions that bundle a tool for subagents (e.g. a project-local
// extension exposing a bespoke tool) register its name → extension-file path
// here at load/session_start time so a child process can be launched with
// `--no-extensions` + an explicit `-e <path>` for it. Mirrors the legacy
// `subagents` extension's `registerToolExtension` hook.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Used to build the child's `--extension` whitelist after
 * `--no-extensions` disables global discovery. Returns undefined for built-in
 * tools and for unknown names (which simply won't be granted).
 */
function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  // The four spawning tools are registered by THIS extension.
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(import.meta.url);
  }
  const extBase = join(getAgentConfigDir(), "extensions");
  const map: Record<string, string> = {
    web_search: join(SUBAGENTS_DIR, "tools", "web-search", "index.ts"),
    web_fetch: join(SUBAGENTS_DIR, "tools", "web-fetch", "index.ts"),
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts"),
  };
  // Prefer the built-in path, but fall back to a runtime-registered extension
  // when that path no longer exists on disk (e.g. a built-in tool extension
  // was disabled/removed but a project-local extension re-registered it).
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  return EXTRA_TOOL_EXTENSIONS.get(tool);
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session, or an unrestricted child).
 */
const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
})();

/**
 * /agent_model overrides per spawner session: sessionId -> agent name ->
 * qualified model ref ("provider/id"). In-memory only — like pi's /model,
 * overrides apply to subagents spawned after they were set and reset on
 * restart.
 */
const modelOverridesBySession = new Map<string, Map<string, string>>();

function getAgentModelOverrideMap(sessionId: string | undefined): Map<string, string> {
  if (!sessionId) return new Map();
  let m = modelOverridesBySession.get(sessionId);
  if (!m) {
    m = new Map();
    modelOverridesBySession.set(sessionId, m);
  }
  return m;
}

/**
 * Parse the PI_SUBAGENT_MODEL_OVERRIDES env var (a JSON object of agent name
 * -> qualified model ref) into a map, or undefined when unset/empty. Malformed
 * JSON is ignored: inherited overrides are a convenience for nested spawns,
 * never a launch blocker.
 */
export function parseModelOverridesEnv(
  raw: string | undefined,
): Map<string, string> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out.set(k, v);
  }
  return out.size > 0 ? out : undefined;
}

// Overrides inherited from the spawner, seeded at module load (mirroring the
// SUBAGENT_ALLOWLIST seeding above). Subagent processes inherit the spawner's
// overrides as a snapshot taken at spawn time: a subagent spawned before an
// override was set keeps the older snapshot (inherent to in-memory state),
// and a subagent spawned after sees the new one.
let inheritedModelOverrides: Map<string, string> | undefined = parseModelOverridesEnv(
  process.env.PI_SUBAGENT_MODEL_OVERRIDES,
);

/** Test hook: replace the module-load inherited override snapshot. */
function setInheritedModelOverrides(m: Map<string, string> | undefined): void {
  inheritedModelOverrides = m;
}

/** Test hook: drop all per-session overrides. */
function resetAgentModelOverrides(): void {
  modelOverridesBySession.clear();
}

/**
 * Resolve the /agent_model override for an agent: the calling session's own
 * override wins, then the spawner-inherited snapshot (nested spawn), then
 * undefined (caller falls back to the agent file default).
 */
export function getAgentModelOverride(
  sessionId: string | undefined,
  agentName: string | undefined,
): string | undefined {
  if (!agentName) return undefined;
  return (
    getAgentModelOverrideMap(sessionId).get(agentName) ??
    inheritedModelOverrides?.get(agentName)
  );
}

/**
 * Set (or clear with "default") this session's override for an agent. `modelRef`
 * must be a qualified "provider/id" string — the caller validates against
 * ctx.modelRegistry before calling. "default" removes the per-session entry so
 * resolution falls back to the inherited snapshot, then the agent default.
 */
export function setAgentModelOverride(
  sessionId: string | undefined,
  agentName: string,
  modelRef: string,
): void {
  const m = getAgentModelOverrideMap(sessionId);
  if (modelRef === "default" || modelRef === "reset") {
    m.delete(agentName);
  } else {
    m.set(agentName, modelRef);
  }
}

/**
 * Merged override map for the session (inherited snapshot + per-session
 * entries, per-session winning) — what spawn/resume emit as
 * PI_SUBAGENT_MODEL_OVERRIDES so nested spawns resolve the same models.
 */
export function getMergedModelOverrides(sessionId: string | undefined): Record<string, string> {
  const merged: Record<string, string> = {};
  if (inheritedModelOverrides) {
    for (const [k, v] of inheritedModelOverrides) merged[k] = v;
  }
  for (const [k, v] of getAgentModelOverrideMap(sessionId)) merged[k] = v;
  return merged;
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  // When this process is itself a restricted subagent, only expose the agents
  // it is permitted to spawn (PI_SUBAGENT_ALLOWED). Top-level sessions see all.
  const all = [...agents.values()];
  return SUBAGENT_ALLOWLIST ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name)) : all;
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
function resolveEffectiveInteractive(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** The slice of a registry model the gauge needs (structurally compatible with pi's `Model`). */
type RegistryModelLike = { id: string; provider?: string; contextWindow?: number };

/**
 * Structural view of pi's `ModelRegistry` — only the synchronous lookups the
 * gauge uses. Deliberately not `ModelRegistry` itself so tests can pass a fake
 * and so the render path never depends on the concrete class.
 */
type ModelRegistryLike = {
  getAll(): RegistryModelLike[];
  find?(provider: string, modelId: string): RegistryModelLike | undefined;
};

function positiveWindow(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Look the model up in the registry. Never guesses:
 *  - "provider/id" (or a separate provider) is unambiguous, so use the exact
 *    `find(provider, id)` lookup, falling back to filtering `getAll()`;
 *  - a bare id is only trusted when EXACTLY one registry model has that id —
 *    the same id can exist under two providers with different windows (e.g.
 *    `qwen3.8-27b` under both `vllm` and `llama.cpp`).
 * Returns undefined for a miss or an ambiguous entry, so the caller can fall
 * back to the name table.
 */
function registryContextWindow(
  model: string,
  registry: ModelRegistryLike,
  provider?: string | null,
): number | undefined {
  let all: RegistryModelLike[];
  try {
    all = registry.getAll() ?? [];
  } catch {
    return undefined;
  }
  const slash = model.indexOf("/");
  const providerPart = slash > 0 ? model.slice(0, slash) : provider ?? undefined;
  const idPart = slash > 0 ? model.slice(slash + 1) : model;

  if (providerPart) {
    const found = registry.find ? registry.find(providerPart, idPart) : undefined;
    const hit =
      positiveWindow(found?.contextWindow) !== undefined
        ? found
        : all.find((m) => m.provider === providerPart && m.id === idPart);
    return positiveWindow(hit?.contextWindow);
  }

  const matches = all.filter((m) => m.id === idPart);
  return matches.length === 1 ? positiveWindow(matches[0].contextWindow) : undefined;
}

/**
 * Context-window size for the usage gauge. Resolution order: the model registry
 * (when supplied) first — a declared `contextWindow` is authoritative for models
 * the name table cannot guess (vllm/qwen, llama.cpp builds, …) — then the name
 * table below, then undefined (rendered as a window-less "Nk ctx" label).
 *
 * The render path has no `ExtensionContext`, so callers pass the `latestCtx`
 * snapshot captured at `session_start` — the same ctx-less precedent as the
 * `agent_model` argument completion. Without a registry the function stays
 * pure and name-table only.
 *
 * CAVEAT: pi's provider-composer defaults a models.json entry that omits
 * `contextWindow` to 128000, so a registry hit can be a plausible-but-defaulted
 * number rather than one the user actually declared.
 */
function contextWindowFor(
  model: string | null | undefined,
  registry?: ModelRegistryLike | null,
  provider?: string | null,
): number | undefined {
  if (!model) return undefined;
  if (registry) {
    const fromRegistry = registryContextWindow(model, registry, provider);
    if (fromRegistry !== undefined) return fromRegistry;
  }
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require tmux. ${muxSetupHint()}`,
      },
    ],
    details: { error: "tmux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/**
 * Slug a display name for use inside an artifact filename (empty when the name
 * has nothing filename-safe in it — callers supply a fallback).
 */
function artifactNameSlug(name: string | undefined | null): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
    .replace(/\s+/g, "-") // spaces to hyphens
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
}

/**
 * Artifact path for one piece of per-launch hand-off text (task brief, system
 * prompt / chain-context block, resume message):
 * `<slug>[-<kind>]-<timestamp>-<id>.md`.
 *
 * The launch `id` is part of the name ON PURPOSE. A name+timestamp path is only
 * unique per name-per-second, so two launches of the same agent+name in the same
 * wall-clock second — exactly what two parallel `subagent({ name: "test" })`
 * calls are — computed the SAME path, and the second write silently clobbered
 * the first launch's brief before it was ever read: both sub-agents got the same
 * task and replied identically. `id` is already unique per launch (it keys
 * `runningSubagents` and the activity file), so uniqueness holds per launch even
 * for legitimately distinct launches that share a name or a millisecond. The
 * readable name+timestamp prefix is kept so the files stay greppable.
 */
function launchArtifactPath(
  artifactDir: string,
  opts: { dir: string; name?: string; id?: string; kind?: string; fallback?: string },
): string {
  const slug = artifactNameSlug(opts.name) || opts.fallback || "subagent";
  const kind = opts.kind ? `-${opts.kind}` : "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Callers always pass the launch id; the random fallback only keeps a
  // hand-written call (tests) from producing a shared path.
  const id = opts.id || Math.random().toString(16).slice(2, 10);
  return join(artifactDir, opts.dir, `${slug}${kind}-${timestamp}-${id}.md`);
}

/**
 * Write an artifact WITHOUT ever replacing one that already exists, and return
 * the path actually written. With a per-launch `id` in the name a collision is
 * unreachable by construction; the numbered fallbacks (and the final throw) are
 * there so a collision can never degrade into a silent overwrite.
 */
function writeArtifactExclusive(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const writeExclusive = (target: string): "ok" | "exists" => {
    try {
      writeFileSync(target, text, { encoding: "utf8", flag: "wx" });
      return "ok";
    } catch (err: any) {
      if (err?.code === "EEXIST") return "exists";
      throw err;
    }
  };
  if (writeExclusive(path) === "ok") return path;
  const stem = path.replace(/\.md$/, "");
  for (let n = 2; n <= 100; n++) {
    if (writeExclusive(`${stem}-${n}.md`) === "ok") return `${stem}-${n}.md`;
  }
  throw new Error(
    `Could not write subagent artifact ${path}: it already exists, as do all numbered alternatives. ` +
      `Per-launch artifact paths must be unique — refusing to overwrite.`,
  );
}

const statusConfig = loadStatusConfig();

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

/**
 * WHO just finished, in a form that can be rendered into model-visible text.
 *
 * A steer message only puts its `content` string in front of the model —
 * `details` goes to the renderers — so an identifier that lives only in
 * `details` is invisible to the very agent that has to act on it. With two
 * `worker` steps of a chain finishing minutes apart, a bare
 * `Sub-agent "worker" completed` is not enough to know which one woke the
 * session up. Hence: name + agent type + chain position belong in the sentence.
 */
type ResultIdentity = {
  name: string;
  agent?: string;
  chain?: { name?: string; stepIndex?: number; stepTotal?: number };
};

/** Cap (chars) on a chain label echoed into a single message/widget line. */
const MAX_CHAIN_NAME_LENGTH = 60;

/**
 * Sanitize a chain label for display. Chain names originate as caller text and,
 * on the resume path, arrive straight from an on-disk `.loadout.json` — so the
 * rule is the one normalizeChain() applies to the numbers: never let untrusted
 * text through. Control characters and newline runs collapse, an over-long
 * label is cut, and anything unusable becomes "" (= no chain part).
 */
function displayChainName(raw: unknown): string {
  const collapsed = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  return collapsed.length > MAX_CHAIN_NAME_LENGTH ? collapsed.slice(0, MAX_CHAIN_NAME_LENGTH) : collapsed;
}

/**
 * The identifier suffix for a completion/question line: ` (agent: worker; chain
 * "c-1" step 2/3)`, joining only the parts that exist, and "" when there is
 * nothing to report — which keeps the pre-existing wording byte-identical for
 * callers that do not know the identity. The chain part goes through the same
 * gate as the block, the env vars and the widget (normalizeChain: one step is
 * not a chain), so a stale or hand-made object can never invent a chain.
 */
function formatResultIdentity(ref: ResultIdentity): string {
  const parts: string[] = [];
  const agent = ref.agent?.trim();
  if (agent) parts.push(`agent: ${agent}`);
  const chain = normalizeChain({
    chainName: ref.chain?.name ?? "",
    stepIndex: ref.chain?.stepIndex ?? 0,
    stepTotal: ref.chain?.stepTotal ?? 0,
    sequence: "",
  });
  const label = chain ? displayChainName(chain.chainName) : "";
  if (chain && label) parts.push(`chain "${label}" step ${chain.stepIndex}/${chain.stepTotal}`);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/**
 * Derive the identity from a live `RunningSubagent`. Its chain fields are set
 * together by chainWidgetPosition(), but they are re-checked here through the
 * shared gate rather than trusted — a half-cleared object must read as an
 * ordinary spawn, not as a chain step of a chain that no longer exists.
 */
function resultIdentityFor(
  running: Pick<RunningSubagent, "name" | "agent" | "chainName" | "chainStep" | "chainStepTotal">,
): ResultIdentity {
  return {
    name: running.name,
    ...(running.agent ? { agent: running.agent } : {}),
    chain: { name: running.chainName, stepIndex: running.chainStep, stepTotal: running.chainStepTotal },
  };
}

/**
 * The one header line every notification about a run leads with: the display
 * name plus whatever identifies the run. Kept in one place so a completion, an
 * `ask_question` and a watcher that THREW all name the same run — the renderer
 * strips exactly one leading line, so all of it must live here.
 */
function resultLabel(ref: string | ResultIdentity): string {
  const identity: ResultIdentity = typeof ref === "string" ? { name: ref } : ref;
  return `Sub-agent "${identity.name}"${formatResultIdentity(identity)}`;
}

/**
 * A watcher that rejected (pane vanished, polling blew up) still has to say
 * which run it was watching — hence the same header as the completion paths,
 * used by BOTH watcher catch blocks (spawn and resume).
 */
function formatWatcherError(ref: string | ResultIdentity, err: any): string {
  return `${resultLabel(ref)} error: ${err?.message ?? String(err)}`;
}

/**
 * The subject of a status/transition line: the display name plus enough chain
 * identity to say WHICH run it is (a session running two chains otherwise gets
 * two indistinguishable "worker stalled" lines). Appended here rather than
 * inside formatTransitionLine(), which normalizes and truncates the name it is
 * given — and it goes through the same chain gate as every other channel, so a
 * one-step chain stays worded exactly as before.
 */
function statusSubjectName(
  running: Pick<RunningSubagent, "name" | "chainName" | "chainStep" | "chainStepTotal">,
): string {
  const chain = normalizeChain({
    chainName: running.chainName ?? "",
    stepIndex: running.chainStep ?? 0,
    stepTotal: running.chainStepTotal ?? 0,
    sequence: "",
  });
  const label = chain ? displayChainName(chain.chainName) : "";
  return chain && label ? `${running.name} [${label} ${chain.stepIndex}/${chain.stepTotal}]` : running.name;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  >,
  ref: string | ResultIdentity,
): string {
  // A bare name is still a valid reference — it just means "identity unknown",
  // which renders the old text exactly.
  const identity: ResultIdentity = typeof ref === "string" ? { name: ref } : ref;
  const name = identity.name;
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it. The agent/chain
  // parts identify THIS run, so they stay out of the follow-up line.
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;
  // One header line, identical in all three branches: the display name plus
  // whatever identifies the run. The message renderer strips exactly one
  // leading line, so every part of the identity must live on that line.
  const label = resultLabel(identity);

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `${label} failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `${label} failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `${label} completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  /**
   * Name of the parent chain (chain steps only). Without it the widget and the
   * completion text can say "2/3" but not of which chain — and a session that
   * runs two chains concurrently has two "2/3" rows. Set with the two numbers
   * by chainWidgetPosition(), so all three appear or none do.
   */
  chainName?: string;
  /** 1-based index of the running step within the parent chain (chain steps only). */
  chainStep?: number;
  /** Total number of steps in the parent chain (chain steps only). */
  chainStepTotal?: number;
  surface: string;
  startTime: number;
  sessionFile: string;
  /**
   * The SPAWNER session this row belongs to — never the sub-agent's own id
   * (that one is the header of `sessionFile`). `runningSubagents` is one flat
   * process-global map and a single pi process can host several sessions, so a
   * session's teardown must know whose watcher each row is: aborting by map
   * position would abort a stranger's sub-agent and wipe its widget row. Set at
   * launch; optional because rows from an older module load carry none, and
   * `parentSessionOf()` then falls back to the artifact path.
   */
  parentSessionId?: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /**
   * Content key (askedAt|question) of the last delivered `ask_question`
   * notification. The `.ask` file lingers until the child consumes the
   * reply — or is left behind when the child is killed mid-wait — so
   * dedupe is keyed on the payload content: an unchanged file does not
   * re-notify, while a new question (or a re-ask) notifies again. See
   * deliverPendingQuestion.
   */
  lastNotifiedAsk?: string;
  /**
   * Consecutive parse failures of the `.ask` file (reset on a successful
   * parse). After ASK_PARSE_GIVE_UP_AFTER in a row the watcher unlinks the
   * file instead of re-reading it every tick forever.
   */
  askParseFailures?: number;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

/**
 * Which spawner session owns this row — the question `session_shutdown` must
 * answer before aborting anything, since one pi process can serve several
 * sessions while this map stays process-global.
 *
 * The launch-time id is authoritative. Otherwise the artifact path still says:
 * every row created here gets its activity file under
 * `<sessionDir>/artifacts/<spawnerSessionId>/subagent-activity/<id>.json`, so
 * even a row from a code path that never set `parentSessionId` identifies its
 * owner. Null means genuinely unattributable — and teardown treats that as
 * "ours" (abort it) rather than as a stranger's.
 */
function parentSessionOf(running: RunningSubagent): string | null {
  if (running.parentSessionId) return running.parentSessionId;
  return running.activityFile?.match(/[\\/]artifacts[\\/]([^\\/]+)[\\/]/)?.[1] ?? null;
}

/**
 * Does this row's NAME count as taken for `sessionId` — and does the row answer
 * to a lookup from that session? The running map is process-global while every
 * other name store (the registry, the chain map, the step-name reservations) is
 * per-session, so a name scan has to pick a scope or the two halves disagree:
 * session A's chain would promise a name that session B is happily handed, and A
 * would then fail mid-chain on the name its own caller chose.
 *
 * A row with NO owner is visible to every session — the conservative reading, and
 * the one `isOurs` and the auto-exit count already use: an unattributable row may
 * never be stolen (which would orphan it), only honoured. With no session id the
 * caller cannot be attributed, so the whole process is honoured — exactly what the
 * `reservedNames` and step-name-lock checks do in the same situation.
 */
function nameRowVisibleTo(running: RunningSubagent, sessionId: string | undefined | null): boolean {
  if (!sessionId) return true;
  const owner = parentSessionOf(running);
  return owner === null || owner === sessionId;
}

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
// Pass the asking session's id to count only ITS children. `runningSubagents` is
// process-global, so an unscoped count lets another session's sub-agents pin this
// one's auto-exit forever — the same cross-session leak `session_shutdown` avoids.
// A row with no owner at all is still counted: it might be this session's, and
// exiting while a child is live would strand it (exactly what this guards).
// With no id the caller cannot be scoped, so the whole map is counted (the
// historical behaviour, and the right reading for a single-session process).
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = (sessionId?: string | null) => {
  if (!sessionId) return runningSubagents.size;
  let count = 0;
  for (const row of runningSubagents.values()) {
    const owner = parentSessionOf(row);
    if (owner === sessionId || owner === null) count++;
  }
  return count;
};

// ── Chains ──────────────────────────────────────────────────────────────────
// `chain` mode of the subagent tool: run subagents one after another
// (e.g. worker → reviewer → worker) and automatically append each step's
// final output to the next step's task. The hand-off is driven by this
// extension, not by the model, so the previous step's output can never be
// forgotten (no `{previous}` placeholder for the caller to add on its own).
//
// Like every other subagent operation here, a chain is fire-and-forget from
// the tool call's point of view: `subagent({ chain: [...] })` returns an
// immediate acknowledgement, the steps run sequentially in the background
// (each in its own pane, tracked by the widget), and ONE aggregate result
// for the whole chain is delivered as a steer message when the last step
// finishes — or when the chain stops early because a step failed.

const MAX_CHAIN_STEPS = 10;
/** Cap (chars) for non-final step outputs in the final steer content. */
const CHAIN_STEP_OUTPUT_CAP = 16_000;

type ChainStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

interface ChainStepRecord {
  index: number;
  agent: string;
  /** The original (un-appended) task requested for this step. */
  task: string;
  /** Running subagent name; defaulted to the agent name at launch. */
  name?: string;
  model?: string;
  cwd?: string;
  status: ChainStepStatus;
  exitCode?: number;
  elapsed?: number;
  /** This step's final assistant message — the text handed to the next step. */
  output?: string;
  summary?: string;
  errorMessage?: string;
  sessionFile?: string;
  sessionId?: string;
}

interface ActiveChain {
  name: string;
  steps: ChainStepRecord[];
  /** 1-based index of the currently running step; 0 when between steps. */
  currentStep: number;
  currentRunning: RunningSubagent | null;
  startTime: number;
  finished: boolean;
  finishedAt?: number;
  /** True when aborted because the parent session shut down. */
  aborted: boolean;
  /** True when a step's pane was closed from outside. */
  surfaceLost: boolean;
  abortController: AbortController;
}

/**
 * Build the task for a chain step: the requested task plus, for every step
 * after the first, the previous step's final output, APPENDED. The append is
 * automatic — the caller never has to (and should not try to) embed a
 * `{previous}` placeholder itself.
 */
export function buildChainStepTask(
  task: string,
  previous: { agent: string; stepIndex: number; output: string } | null,
): string {
  if (!previous || !previous.output.trim()) return task;
  return (
    `${task}\n\n` +
    `## Output from previous step (step ${previous.stepIndex}: ${previous.agent})\n\n` +
    previous.output
  );
}

function truncateChainOutput(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const omitted = text.length - cap;
  return `${text.slice(0, cap)}\n\n[truncated — ${omitted} more characters; full output in the step's session file]`;
}

/**
 * The `## Chain context` block injected into a chain step's system prompt.
 *
 * Chain steps used to receive zero chain context: step 1 had no idea it was
 * part of a sequence. So the block reports where the step sits in the chain, its
 * own role, the full sequence, and the automatic hand-off — any earlier steps
 * have already run and any later steps run on their own and receive this step's
 * final message. Both clauses are conditional on purpose: step 1 has no earlier
 * peers and the last step has no later ones. It ends with one practical
 * consequence of that hand-off: the orchestrator that started the chain sees
 * only the final step's final message, so a step carries forward whatever it got
 * from earlier steps that the orchestrator should know about.
 *
 * DESCRIPTIVE by design: apart from that single consequence, the block carries
 * no prohibitions and no spawn restrictions of any kind. A step infers what to
 * do from knowing who its peers are. Nothing in this feature limits what a step
 * may spawn: the PI_SUBAGENT_ALLOWED allowlist and the spawn paths are
 * untouched. Returns "" for a single-step chain: one step is not a chain, so it
 * gets no extra noise.
 */
export function buildChainContextBlock(info: {
  chainName: string;
  stepIndex: number;
  stepTotal: number;
  agent: string;
  sequence: string;
}): string {
  if (!info || info.stepTotal < 2) return "";
  const agent = info.agent?.trim() || "subagent";
  const sequence = info.sequence?.trim() || agent;
  return [
    `## Chain context`,
    ``,
    `You are step ${info.stepIndex} of ${info.stepTotal} in the sub-agent chain \`${info.chainName}\`.`,
    `Your agent role is \`${agent}\`; the chain sequence is \`${sequence}\`.`,
    `Any earlier steps have already run; any later steps run automatically after you and receive your final message.`,
    `The orchestrator that started this chain sees only the final step's final message, so pass along anything the orchestrator should know from earlier steps.`,
  ].join("\n");
}

/**
 * Sanitize a persisted chain step number. At resume these come straight from the
 * on-disk `.loadout.json` snapshot, and they are emitted into a shell command
 * line, so they must never be able to carry text through — anything that is not
 * a positive integer collapses to 0, which the caller reads as "not a chain
 * step".
 */
function chainStepNumber(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * The single validity gate for a chain position, shared by every channel that
 * reports it — the system-prompt block, the PI_SUBAGENT_CHAIN_* env vars, and
 * the widget. Numbers are sanitized (at resume they arrive straight from an
 * on-disk `.loadout.json`, where they may be text), and anything that is not a
 * real position in a chain of two or more steps yields null, which every caller
 * reads as "not a chain step". Without one shared gate the three channels could
 * disagree about the very question of whether a launch was a chain step at all.
 */
function normalizeChain(
  chain: SubagentChainContext | null | undefined,
): { chainName: string; stepIndex: number; stepTotal: number; sequence: string } | null {
  if (!chain) return null;
  const stepIndex = chainStepNumber(chain.stepIndex);
  const stepTotal = chainStepNumber(chain.stepTotal);
  if (stepTotal < 2 || stepIndex < 1) return null;
  return {
    chainName: String(chain.chainName ?? ""),
    stepIndex,
    stepTotal,
    sequence: String(chain.sequence ?? ""),
  };
}

/**
 * The PI_SUBAGENT_CHAIN_* env prefix for a chain step (empty for ordinary
 * spawns). Shared by the launch and resume paths so the two can never drift.
 * Strings follow the shellEscape convention of the other PI_SUBAGENT_* vars;
 * the two numbers are sanitized integers, so they need no quoting.
 */
function buildChainEnvParts(chain: SubagentChainContext | null | undefined): string[] {
  const c = normalizeChain(chain);
  if (!c) return [];
  return [
    `PI_SUBAGENT_CHAIN_NAME=${shellEscape(c.chainName)}`,
    `PI_SUBAGENT_CHAIN_STEP=${c.stepIndex}`,
    `PI_SUBAGENT_CHAIN_STEP_TOTAL=${c.stepTotal}`,
    `PI_SUBAGENT_CHAIN_SEQUENCE=${shellEscape(c.sequence)}`,
  ];
}

/** The chain block for a persisted loadout — identical text at launch and resume. */
function chainBlockForLoadout(loadout: SubagentLoadout): string {
  const c = normalizeChain(loadout.chain);
  if (!c) return "";
  return buildChainContextBlock({ ...c, agent: loadout.agent ?? "" });
}

/**
 * The widget fields for a chain position, via the same gate as the block and
 * the env vars. Crucial on the resume path, where these come from disk: raw
 * on-disk text must never reach renderSubagentWidgetLines(), which interpolates
 * them straight into a TUI line (and a corrupt snapshot would otherwise also
 * make the widget disagree with a block and env vars that correctly opted out).
 */
function chainWidgetPosition(
  chain: SubagentChainContext | null | undefined,
): { chainName?: string; chainStep?: number; chainStepTotal?: number } {
  const c = normalizeChain(chain);
  if (!c) return {};
  const chainName = displayChainName(c.chainName);
  return {
    ...(chainName ? { chainName } : {}),
    chainStep: c.stepIndex,
    chainStepTotal: c.stepTotal,
  };
}

/**
 * The pieces of one system prompt, joined into the SINGLE value handed to one
 * --append-system-prompt / --system-prompt flag: the agent identity (when it
 * lives in the system prompt) followed by the chain-context block. Both the pi
 * path (via applySandboxToParts) and the Claude CLI path compose here, which is
 * what keeps the block from ever being delivered by two separate calls.
 */
function composeSystemPromptText(identity: string | null | undefined, chainBlock: string): string {
  return [identity, chainBlock].filter((part) => typeof part === "string" && part.trim().length > 0).join("\n\n");
}

/** The `details.steps` payload shared by the steer message and the renderer. */
function chainStepDetails(steps: ChainStepRecord[]): Array<Record<string, unknown>> {
  return steps.map((s) => ({
    index: s.index,
    agent: s.agent,
    ...(s.name ? { name: s.name } : {}),
    status: s.status,
    ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    ...(s.elapsed !== undefined ? { elapsed: s.elapsed } : {}),
    ...(s.output ? { output: s.output } : {}),
    ...(s.summary ? { summary: s.summary } : {}),
    ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
    ...(s.sessionFile ? { sessionFile: s.sessionFile } : {}),
  }));
}

/** Plain-text presentation of a finished chain — what the model reads. */
function formatChainPresentation(chain: ActiveChain): string {
  const totalSeconds = Math.max(0, Math.floor(((chain.finishedAt ?? Date.now()) - chain.startTime) / 1000));
  const total = chain.steps.length;
  const completed = chain.steps.filter((s) => s.status === "completed").length;
  const failedStep = chain.steps.find((s) => s.status === "failed");

  let head: string;
  if (chain.aborted) {
    head = `Chain "${chain.name}" was cancelled (parent session shut down). ${completed}/${total} steps completed.`;
  } else if (failedStep) {
    const reason = chain.surfaceLost
      ? "the step's pane was closed"
      : failedStep.errorMessage
        ? `provider/agent error: ${failedStep.errorMessage}`
        : `exit code ${failedStep.exitCode ?? "?"}`;
    head =
      `Chain "${chain.name}" stopped at step ${failedStep.index}/${total} (${failedStep.agent}) — ${reason}. ` +
      `${completed}/${total} steps completed in ${formatElapsed(totalSeconds)}; remaining steps were not run.`;
  } else {
    head = `Chain "${chain.name}" completed: ${completed}/${total} steps in ${formatElapsed(totalSeconds)}.`;
  }

  const ranSteps = chain.steps.filter((s) => s.status === "completed" || s.status === "failed" || s.status === "cancelled");
  const sections = ranSteps.map((s, i) => {
    const isLast = i === ranSteps.length - 1;
    const statusLine =
      s.status === "completed"
        ? `completed in ${formatElapsed(s.elapsed ?? 0)}`
        : s.status === "failed"
          ? `FAILED${s.errorMessage ? " (provider/agent error)" : ` (exit ${s.exitCode ?? "?"})`}`
          : "cancelled";
    const body = (s.output ?? s.summary ?? s.errorMessage ?? "(no output)").trim();
    const text = isLast ? body : truncateChainOutput(body, CHAIN_STEP_OUTPUT_CAP);
    return `## Step ${s.index}/${total}: ${s.agent}${s.name ? ` (${s.name})` : ""} — ${statusLine}\n\n${text}`;
  });

  const skipped = chain.steps.filter((s) => s.status === "skipped").map((s) => s.agent);
  const tail: string[] = [];
  if (skipped.length > 0) tail.push(`Not run (chain stopped early): ${skipped.join(", ")}.`);
  const stepNames = chain.steps
    .filter((s) => s.name && s.sessionFile)
    .map((s) => `subagent_message({ name: "${s.name}", message: "…" })`);
  if (stepNames.length > 0) tail.push(`Follow up on any step with ${stepNames.join(" or ")}.`);

  return [head, ...sections].join("\n\n---\n\n").concat(tail.length ? `\n\n${tail.join("\n")}` : "");
}

/**
 * The note appended when one name answers to BOTH a running subagent and an
 * active chain. Resolution order is running → chain, so the message went to the
 * subagent and the chain is unreachable under that name — but "the message went
 * to the subagent" is only true when the steer actually landed:
 * handleSubagentSteer reports a failed pane write (or an ambiguous running
 * match) in `details.error`, and promising delivery then would be false. Hence
 * `delivered`, decided by the caller off exactly that field.
 */
function chainShadowNote(chain: ActiveChain, delivered: boolean): string {
  // Never print "step 0/N": currentStep is 0 before the first step launches (and
  // is reset on finish), and 0 with a running step cannot happen at all — either
  // way it reads as "between steps", the wording the chain-delivery path uses for
  // a chain whose steps are not running.
  const position = chain.currentRunning && chain.currentStep >= 1
    ? `step ${chain.currentStep}/${chain.steps.length} is running`
    : "it is between steps";
  const current = chain.currentRunning?.name ?? chain.steps[chain.currentStep - 1]?.name;
  const stepNames = [...new Set(chain.steps.map((s) => s.name).filter(Boolean))].join(", ");
  const where = current
    ? `Reach that step by its own name instead: subagent_message({ name: "${current}", message: "…" }).`
    : stepNames
      ? `Its steps are addressable by their own names: ${stepNames}.`
      : "Its steps are not named yet — wait for the aggregate chain steer.";
  const outcome = delivered
    ? "This message went to the running subagent of that name, not to the chain."
    : "This message reached neither the running subagent (the steer above failed) nor the chain — a name " +
      "that matches a running subagent is never resolved to a chain.";
  return (
    `Ambiguous subagent name "${chain.name}" — it is also an active chain ` +
    `(${chain.steps.length} steps, ${position}). ${outcome} ${where}`
  );
}

interface ChainStepRunResult {
  name: string;
  sessionFile?: string;
  sessionId?: string;
  summary: string;
  exitCode: number;
  elapsed: number;
  errorMessage?: string;
}

type ChainStepRunner = (
  step: { agent: string; task: string; name: string; model?: string; cwd?: string },
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  parentArtifactDir: string,
  pi: ExtensionAPI,
  signal: AbortSignal,
  hooks: {
    onLaunched: (running: RunningSubagent) => void;
    onSurfaceLost: () => void;
  },
  /**
   * Where this step sits in the chain, so the step can be told (system prompt +
   * PI_SUBAGENT_CHAIN_* env). Optional so a stubbed runner — and any non-chain
   * launch — stays unaffected.
   */
  chainContext?: SubagentChainContext,
) => Promise<ChainStepRunResult>;

/** Launch/watch behind a seam so the real runStep can be unit-tested
 * without tmux (same isolation convention as chainHooks). */
const subagentOps: { launch: typeof launchSubagent; watch: typeof watchSubagent } = {
  launch: launchSubagent,
  watch: watchSubagent,
};

/**
 * Per-step runner for chains: launch a pane, register the name, watch until
 * the step exits. Isolated behind a hook so unit tests can replace it
 * (spawning real tmux panes is integration-test territory).
 */
const chainHooks: { runStep: ChainStepRunner } = {
  runStep: async (step, ctx, parentArtifactDir, pi, signal, { onLaunched, onSurfaceLost }, chainContext) => {
    const running = await subagentOps.launch(
      {
        agent: step.agent,
        task: step.task,
        name: step.name,
        ...(step.model ? { model: step.model } : {}),
        ...(step.cwd ? { cwd: step.cwd } : {}),
      },
      ctx,
      chainContext ? { chainContext } : undefined,
    );
    // The previous step's completion cleared the refresh timers while
    // runningSubagents was empty; without re-arming them, this step's row
    // never renders (or renders once with a frozen elapsed timer).
    startWidgetRefresh();
    startStatusRefresh(pi);
    onLaunched(running);
    registerName(parentArtifactDir, running.name, {
      sessionFile: running.sessionFile,
      sessionId: getSessionId(running.sessionFile),
    });
    const result = await subagentOps.watch(running, signal, {
      onTick: () => {
        if (!isSurfaceAlive(running.surface)) onSurfaceLost();
      },
    });
    updateWidget();
    return {
      name: running.name,
      ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      summary: result.summary,
      exitCode: result.exitCode,
      elapsed: result.elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  },
};

/**
 * Drive a chain to completion, one step after another.
 *
 * Each step's final output is appended to the next step's task via
 * buildChainStepTask(). When a step fails (non-zero exit, provider error,
 * lost pane, or abort) the chain stops and the aggregate result — including
 * everything completed so far — is delivered as a single steer message.
 */
async function runChain(
  chain: ActiveChain,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  parentArtifactDir: string,
  pi: ExtensionAPI,
): Promise<void> {
  let previous: { agent: string; stepIndex: number; output: string } | null = null;
  // The chain's agent roles in order — what every step is told the sequence is,
  // and what gets persisted in its loadout for a faithful resume.
  const sequence = chain.steps.map((s) => s.agent).join(" → ");

  for (const step of chain.steps) {
    if (chain.aborted || chain.abortController.signal.aborted) {
      // An aborted chain never reaches the release below, so a step skipped here
      // keeps its reservation until the loop ends — which every abort does, since
      // this branch runs for the rest of the steps and then falls through to the
      // chain-end `releaseStepNameLocks(chain)`. In the window before that the lock
      // already reads as stale (abort is checked first in `stepNameLockIsStale`), so
      // the name is free to anyone who asks even while the entry still exists.
      step.status = "skipped";
      continue;
    }

    // This step is about to start, so its promised name becomes its own handle:
    // give the reservation up FIRST and explicitly — before the name below is
    // checked or generated, because a chain must never be rejected against a name it
    // is itself about to take. From the check onward the name is held by
    // `reservedNames`, then by the running row / the registry. Nothing awaits in
    // between, so no name is ever momentarily unowned. The chain's LATER steps stay
    // locked, so a generated name for this step still steps aside for them.
    releaseStepNameLocks(chain, step.index);

    step.status = "running";
    chain.currentStep = step.index;

    // Default the step's name to the agent name, uniquified against running
    // subagents, in-flight reservations, this session's chain handles and the names
    // not-yet-started steps have reserved (a step may not answer to its own chain's
    // name, nor to a name a later step of any chain already promises), and the
    // session's persistent registry (earlier chain steps live there). Reserve it
    // synchronously (before any await) so parallel spawns can't collide.
    //
    // Only a name THIS chain reserved may be released below: an explicit step
    // name was never ours to reserve, and `step.name` is later reassigned to
    // whatever the launch actually used — releasing that could hand a name a
    // concurrent spawn is holding to someone else. An explicit name is checked
    // for collisions both here and in `startChain`, and that is not a duplicate:
    // `startChain` rejects what is knowable at the tool call, while steps run one
    // after another over minutes, so a name that was free then can be taken by a
    // parallel spawn (or registered by one of this chain's own finished steps)
    // before this step starts. This check is that race's backstop.
    let reservedStepName: string | null = null;
    let stepNameConflict: string | null = null;
    // Chain-side names of this session: this chain's own name and its siblings'. A
    // step may not answer to one of those in either direction — a generated name
    // steps aside, an explicit one is rejected — or the chain would be unreachable
    // through the handle its caller chose once this step is running. The names
    // pending steps promise are NOT listed here: the helpers below consult the
    // reservations themselves, which is why a step cannot forget them.
    const stepSessionId = ctx.sessionManager.getSessionId();
    const stepSessionChains = getChainMapForSession(stepSessionId);
    if (!step.name) {
      const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
      step.name = uniqueRunningName(step.agent, registryNames, stepSessionChains.keys(), stepSessionId);
      reservedStepName = step.name;
      reservedNames.add(reservedStepName, stepSessionId);
    } else {
      step.name = step.name.trim();
      const conflict =
        findChainNameConflict(step.name, stepSessionChains, "chain step") ??
        findNameConflict(step.name, parentArtifactDir, "chain step", stepSessionId);
      if (conflict) {
        stepNameConflict = conflict.message;
      } else {
        reservedStepName = step.name;
        reservedNames.add(reservedStepName, stepSessionId);
      }
    }

    try {
      if (stepNameConflict) {
        // The CHECK stays — a name free when the chain was accepted can be taken
        // before this step runs — but it says nothing beyond the standard collision
        // sentence. Which step failed is carried by the step's own state, not the text.
        throw new Error(stepNameConflict);
      }
      const taskForStep = buildChainStepTask(step.task, previous);
      // A single-step chain is not a chain: no context is threaded, so the step
      // launches exactly like an ordinary spawn (no block, no env vars).
      const chainContext: SubagentChainContext | undefined =
        chain.steps.length >= 2
          ? { chainName: chain.name, stepIndex: step.index, stepTotal: chain.steps.length, sequence }
          : undefined;
      const result = await chainHooks.runStep(
        {
          agent: step.agent,
          task: taskForStep,
          name: step.name,
          ...(step.model ? { model: step.model } : {}),
          ...(step.cwd ? { cwd: step.cwd } : {}),
        },
        ctx,
        parentArtifactDir,
        pi,
        chain.abortController.signal,
        {
          onLaunched: (running) => {
            chain.currentRunning = running;
            // Widget position — chainWidgetPosition opts out (assigns nothing)
            // for a one-step chain, matching what the resume path derives from a
            // persisted one-step loadout.
            Object.assign(running, chainWidgetPosition(chainContext));
          },
          onSurfaceLost: () => {
            chain.surfaceLost = true;
            chain.abortController.abort();
          },
        },
        chainContext,
      );

      step.name = result.name;
      step.sessionFile = result.sessionFile;
      step.sessionId = result.sessionId;
      step.exitCode = result.exitCode;
      step.elapsed = result.elapsed;
      step.summary = result.summary;
      if (chain.abortController.signal.aborted) {
        step.status = chain.aborted ? "cancelled" : "failed";
        if (result.errorMessage) step.errorMessage = result.errorMessage;
      } else if (result.exitCode !== 0 || result.errorMessage) {
        step.status = "failed";
        if (result.errorMessage) step.errorMessage = result.errorMessage;
      } else {
        step.status = "completed";
        step.output = result.summary;
        previous = { agent: step.agent, stepIndex: step.index, output: result.summary };
      }
    } catch (err) {
      step.status = "failed";
      step.errorMessage = err?.message ?? String(err);
    } finally {
      // Released FOR THIS SESSION only — another session may be holding the very
      // same name in its own launch, and its claim is not ours to cancel.
      if (reservedStepName) reservedNames.delete(reservedStepName, stepSessionId);
    }

    if (step.status !== "completed") {
      // The chain stopped: mark the remaining steps so the presentation and
      // the renderer can show exactly what never ran.
      for (const rest of chain.steps.slice(chain.steps.indexOf(step) + 1)) {
        if (rest.status === "pending") rest.status = "skipped";
      }
      break;
    }
  }

  chain.currentStep = 0;
  chain.currentRunning = null;
  chain.finished = true;
  chain.finishedAt = Date.now();
  // The chain is over — completed, stopped early on a failed step, or aborted — so
  // every name its remaining steps promised is released here, in one place, on the
  // path that every terminal outcome goes through. A name must never stay spent
  // because a chain ended.
  releaseStepNameLocks(chain);

  const allCompleted = chain.steps.every((s) => s.status === "completed");
  try {
    pi.sendMessage(
      {
        customType: "subagent_result",
        content: formatChainPresentation(chain),
        display: true,
        details: {
          name: chain.name,
          chain: true,
          exitCode: allCompleted ? 0 : 1,
          elapsed: Math.max(0, Math.floor((chain.finishedAt - chain.startTime) / 1000)),
          ...(chain.aborted ? { cancelled: true } : {}),
          ...(chain.surfaceLost ? { surfaceLost: true } : {}),
          steps: chainStepDetails(chain.steps),
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch {
    // The session may already be gone (shutdown mid-chain); nothing to do.
  }
}

/**
 * Validate a `chain` spawn and kick it off. Returns the tool result: either
 * a validation error (nothing launched) or an acknowledgement (the chain
 * runs in the background and reports via a steer message).
 */
function startChain(
  params: { chain?: Array<{ agent?: string; task?: string; name?: string; model?: string; cwd?: string }>; name?: string },
  permittedSet: Set<string>,
  permittedList: string,
  currentAgent: string | undefined,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  pi: ExtensionAPI,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const chainSteps = params.chain ?? [];

  if (chainSteps.length > MAX_CHAIN_STEPS) {
    return {
      content: [{ type: "text", text: `Too many chain steps (${chainSteps.length}). Max is ${MAX_CHAIN_STEPS}.` }],
      details: { error: "chain too long" },
    };
  }

  // Validate every step up front so a bad step never leaves a partial chain running.
  for (let i = 0; i < chainSteps.length; i++) {
    const step = chainSteps[i];
    if (!step?.agent || !String(step.agent).trim()) {
      return {
        content: [{ type: "text", text: `Chain step ${i + 1} is missing an agent.` }],
        details: { error: "chain step missing agent", step: i + 1 },
      };
    }
    if (!step?.task || !String(step.task).trim()) {
      return {
        content: [{ type: "text", text: `Chain step ${i + 1} is missing a task.` }],
        details: { error: "chain step missing task", step: i + 1 },
      };
    }
    if (!permittedSet.has(step.agent)) {
      return {
        content: [
          {
            type: "text",
            text:
              `Chain step ${i + 1} may not spawn the "${step.agent}" agent — it is not ` +
              `${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. Available agents: ${permittedList}.`,
          },
        ],
        details: { error: SUBAGENT_ALLOWLIST ? "chain agent not in allowlist" : "unknown chain agent", step: i + 1 },
      };
    }
    if (currentAgent && step.agent === currentAgent) {
      return {
        content: [
          {
            type: "text",
            text: `You are the ${currentAgent} agent — a chain cannot include another ${currentAgent}. You were spawned to do that work yourself.`,
          },
        ],
        details: { error: "self-spawn blocked", step: i + 1 },
      };
    }
  }

  if (!isMuxAvailable()) {
    return {
      content: [{ type: "text", text: `Subagents require tmux. ${muxSetupHint()}` }],
      details: { error: "tmux not available" },
    };
  }

  if (!ctx.sessionManager.getSessionFile()) {
    return {
      content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." }],
      details: { error: "no session file" },
    };
  }

  // This spawner session's artifact dir hosts the name registry; chain steps
  // are registered there like ordinary spawns so subagent_message can address them.
  const parentArtifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionChains = getChainMapForSession(sessionId);
  const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
  // Names held by other chains' steps that have not started. They are not in the
  // running/reserved/registry sets yet (a step only claims its name when it
  // launches), so without them a chain could be handed a name a sibling chain has
  // already promised to a later step of its own. Read through the same reservations
  // the central naming helpers consult — one source of truth, not a recomputation.
  const promisedStepNames = lockedStepNames(sessionId);
  // Every name a subagent of this session already answers to: the running ones,
  // the ones claimed by parallel in-flight spawns, and the persistent registry.
  // subagent_message resolves running subagents BEFORE chains, so a chain handed
  // such a name would be permanently unreachable through its own name — an
  // explicit one is now rejected outright and a defaulted one steps aside.
  const nameTaken = (candidate: string): boolean =>
    sessionChains.has(candidate) ||
    promisedStepNames.has(candidate) ||
    registryNames.has(candidate) ||
    reservedNames.has(candidate, sessionId) ||
    Array.from(runningSubagents.values()).some((r) => nameRowVisibleTo(r, sessionId) && r.name === candidate);

  // The chain's own handle. A name the CALLER supplied must be unique — the same
  // policy as a spawn name or a step name — so a collision is REJECTED instead of
  // silently suffixed: the caller would get a handle different from the one they
  // type into subagent_message, and chains are matched by exact name. A name the
  // SYSTEM generated because `name` was omitted keeps auto-suffixing (`chain`,
  // `chain-2`, …) because parallel chains must never error. Every check below is
  // followed immediately by the registration at the bottom of this function with
  // no `await` in between — `startChain` is synchronous to that point, which is
  // what makes two parallel chain calls safe.
  const explicitChainName = params.name?.trim();
  let chainName: string;
  if (explicitChainName) {
    const conflict =
      findChainNameConflict(explicitChainName, sessionChains) ??
      findNameConflict(explicitChainName, parentArtifactDir, "chain", sessionId);
    if (conflict) {
      return {
        content: [{ type: "text", text: conflict.message }],
        details: {
          error: conflict.message,
          name: explicitChainName,
          kind: conflict.kind,
          holder: conflict.holder,
        },
      };
    }
    chainName = explicitChainName;
  } else {
    // A DEFAULTED chain handle also avoids the names this chain's own steps would
    // auto-generate (their explicit names, or their agents' names) — a chain that
    // shared a handle with one of its own steps would be unreachable through it,
    // since subagent_message resolves running subagents before chains. The other
    // half of that invariant lives in `runChain`: a step's GENERATED name is
    // uniquified against every chain handle, so neither side can take the other's.
    const ownStepNames = new Set(
      chainSteps.map((s) => (s.name?.trim() || String(s.agent ?? "").trim()).trim()).filter(Boolean),
    );
    chainName = "chain";
    let suffix = 2;
    while (nameTaken(chainName) || ownStepNames.has(chainName)) chainName = `chain-${suffix++}`;
  }

  // Caller-supplied STEP names are checked here against the FULL conflict set —
  // running sub-agents, in-flight reservations, this session's registry, every
  // chain handle (including this chain's own), and the names other chains have
  // promised to their pending steps — because every one of those is knowable at
  // this instant, and this function registers nothing before it returns. So a
  // chain call either starts and runs, or is rejected here with the name, its kind,
  // and the step it belongs to — the step index lives in `details.step`, never in
  // the sentence. It never lands in the chain map, the registry or
  // `reservedNames`, and never produces a chain that stops on its own name. A step named after its own chain (or after
  // any other chain, or after another chain's pending step) would shadow that
  // handle once it launched, and a step named after a sub-agent would take a
  // handle that already addresses someone else.
  //
  // What this covers is exactly what is true NOW. Chain steps run one after
  // another over minutes, so a name free here can be taken by a later spawn (or
  // by one of this chain's own finished steps registering it) before step N runs;
  // the identical check therefore also runs at each step's start — see `runChain`
  // — as the race backstop, not as a duplicate of this one. That late collision is
  // the only name failure a chain that was accepted can still have.
  const explicitStepNames = new Set<string>();
  for (let i = 0; i < chainSteps.length; i++) {
    const stepName = chainSteps[i]?.name?.trim();
    if (!stepName) continue;
    const duplicate = explicitStepNames.has(stepName);
    explicitStepNames.add(stepName);
    const conflict: { kind: string; holder?: string; message?: string } | null = duplicate
      ? { kind: "duplicate-step", holder: stepName }
      : stepName === chainName
        ? { kind: "own-chain-handle", holder: stepName }
        : (findChainNameConflict(stepName, sessionChains, "chain step") ??
            findNameConflict(stepName, parentArtifactDir, "chain step", sessionId));
    if (conflict) {
      // The text names only the KIND of name, the name, and that it is in use; WHICH
      // step is at fault is for renderers and tests to read from `details.step`, not
      // something to fish out of the sentence.
      const message = nameInUseMessage(stepName, "chain step");
      return {
        content: [{ type: "text", text: message }],
        details: {
          error: message,
          step: i + 1,
          kind: conflict.kind,
          ...(conflict.holder ? { holder: conflict.holder } : {}),
        },
      };
    }
  }

  const chain: ActiveChain = {
    name: chainName,
    steps: chainSteps.map((s, i) => ({
      index: i + 1,
      agent: s.agent as string,
      task: s.task as string,
      ...(s.name?.trim() ? { name: s.name.trim() } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      status: "pending" as const,
    })),
    currentStep: 0,
    currentRunning: null,
    startTime: Date.now(),
    finished: false,
    aborted: false,
    surfaceLost: false,
    abortController: new AbortController(),
  };
  sessionChains.set(chain.name, chain);
  // Registering the chain and reserving its not-yet-started steps' explicit names
  // happen in the same synchronous block, so a chain that exists has already made
  // its future names untakeable — nothing has to remember to ask for them, and a
  // rejected chain call (which returns above) locks nothing. Generated step names
  // are deliberately NOT reserved: they are decided at launch and must keep
  // auto-suffixing silently.
  lockPendingStepNames(sessionId, chain);

  // The kick-off is guarded because it happens AFTER the chain is registered and
  // its names are locked: `runChain` itself cannot throw synchronously (it is an
  // async function, so a throw inside it lands in the `catch` below), but the two
  // timer starters above run before it and a throw there would leave a chain that
  // never runs at all — never `finished`, never aborted, its steps forever
  // `pending`, so even the read-time staleness check would call its locks live and
  // spend those names for the process. Releasing here is the only thing that can
  // stop that, and it is the reason `chain.finished` is set before rethrowing.
  try {
    startWidgetRefresh();
    startStatusRefresh(pi);

    // Fire-and-forget: the chain drives itself and reports via a steer message.
    runChain(chain, ctx, parentArtifactDir, pi).catch((err) => {
      // runChain handles step failures internally; this is a last resort.
      if (!chain.finished) {
        chain.finished = true;
        chain.finishedAt = Date.now();
      }
      // Released UNCONDITIONALLY, not inside the `if`: a chain that is over must not
      // keep names, and trusting `finished` alone would leak if anything ever set
      // that flag on a path that skipped the release at the end of `runChain`.
      // `releaseStepNameLocks` is identity-matched and idempotent, so releasing a
      // chain that already released is a no-op for everyone else's entries.
      releaseStepNameLocks(chain);
      try {
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: `Chain "${chain.name}" error: ${err?.message ?? String(err)}`,
            display: true,
            details: {
              name: chain.name,
              chain: true,
              exitCode: 1,
              steps: chainStepDetails(chain.steps),
            },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      } catch {
        /* session may be gone */
      }
    });
  } catch (err) {
    // Reached only if a timer starter throws before `runChain` was ever called — the
    // one way a registered chain can end up with locks it will never release on its
    // own. Close the chain out and free the names, then let the error go on exactly
    // as it did before this guard existed.
    chain.finished = true;
    chain.finishedAt = Date.now();
    releaseStepNameLocks(chain);
    throw err;
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Chain "${chain.name}" started: ${chain.steps.length} steps (${chain.steps.map((s) => s.agent).join(" → ")}). ` +
          `It runs in the background, one step after another — each step's final output is automatically appended to the next step's task ` +
          `(no {previous} placeholder needed). Do NOT poll, sleep, or try to track it manually. ` +
          `The aggregate result for the whole chain arrives as a steer message when the last step finishes, ` +
          `or when the chain stops early because a step failed. ` +
          `To reach the currently running step: subagent_message({ name: "${chain.name}", message: "…" }) or the step's own name.`,
      },
    ],
    details: {
      status: "chain-started",
      chainName: chain.name,
      steps: chain.steps.map((s) => ({ index: s.index, agent: s.agent })),
    },
  };
}

/** Active chains, keyed by spawner session id, then chain name. */
const chainsBySession = new Map<string, Map<string, ActiveChain>>();

function getChainMapForSession(sessionId: string): Map<string, ActiveChain> {
  let m = chainsBySession.get(sessionId);
  if (!m) {
    m = new Map();
    chainsBySession.set(sessionId, m);
  }
  return m;
}

// ── Widget management ──

/**
 * Latest ExtensionContext from session_start, used for widget updates, and the
 * latest ExtensionAPI, used to deliver `ask_question` notifications from the
 * watcher.
 *
 * Known limitation, deliberately left process-global: pi can host more than one
 * session per process, and these two — unlike every name, chain and shutdown
 * store above, which is keyed by spawner session — follow whichever runtime
 * registered LAST. So the status widget lists every session's rows on ONE
 * session's screen, and a child's `subagent_question` can be steered into a
 * different session than the one that spawned it (the text still names its own
 * sub-agent, and `subagent_message` resolves that name in the session that acts
 * on it, so nothing is ever delivered to the wrong sub-agent — only the notification
 * can land on the wrong screen). Making these per-session means keying the widget
 * and the notification path by `parentSessionOf(row)`, which is item 5 of the
 * session-scoping pass and is NOT done here.
 */
let latestCtx: ExtensionContext | null = null;
let latestPi: ExtensionAPI | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    // Brackets keep the chain label from reading as part of the name; borderLine
    // truncates this whole left side when the box is narrow, so an over-long
    // chain name can never push the right-aligned status out of the box.
    const chainTag =
      agent.chainStep != null && agent.chainStepTotal != null
        ? `${agent.chainName ? ` [${agent.chainName}]` : ""} ${agent.chainStep}/${agent.chainStepTotal}`
        : "";
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag}${chainTag} `;
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call ask_question.
 */
function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;

  // No explicit tool restriction and no spawning grant → don't pass --tools at
  // all (the child keeps its default toolset).
  if (requested.length === 0 && !grantSpawning) return null;

  const allow = new Set(requested);
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Apply a loadout snapshot's sandbox to a pi command's `parts` array: model,
 * identity (system prompt), and the default-deny tool/extension restriction
 * (`--no-extensions` + `--tools` + one `-e` per tool-backing extension).
 *
 * This is the single source of truth for reconstructing a subagent's sandbox,
 * used both by the initial `launchSubagent` and by the `subagent_message`
 * resume path so the two can never drift. Env vars (PI_SUBAGENT_AGENT /
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR / PI_SUBAGENT_CHAIN_*) and cwd are
 * the caller's responsibility since they differ slightly between launch and
 * resume. The chain-context system-prompt block is NOT: it rides on the
 * loadout's persisted chain position so every launch mode injects it exactly
 * once through the same channel used for the agent identity.
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string; id?: string },
): void {
  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  const promptFileSuffix = (opts.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Per-launch unique path (the launch id is in the filename) — see
  // launchArtifactPath(): a name+second path let a parallel launch overwrite
  // this launch's system prompt before it was read.
  const writePromptFile = (kind: string, text: string): string =>
    writeArtifactExclusive(
      launchArtifactPath(opts.artifactDir, {
        dir: "context",
        name: promptFileSuffix,
        kind,
        id: opts.id,
      }),
      text,
    );

  // Chain position block (chain steps only). It rides on the identity's own
  // system-prompt call: when an identity exists it is appended to that text so
  // the block and the identity travel in ONE call — pushing a second
  // --append-system-prompt as well would risk double delivery — and when there
  // is no identity to carry it (agentless/fork spawns, agents without
  // `system-prompt:` frontmatter whose identity went into the task's roleBlock
  // instead) it is delivered on its own. Either way exactly one call, in every
  // launch mode, never in the task text.
  const chainBlock = chainBlockForLoadout(loadout);
  // Guard on the COMPOSED text, not on the raw fields: a truthy-but-blank
  // identity must not cause an empty prompt file to be written and passed.
  const identity = loadout.identity?.trim() ? loadout.identity : "";
  const promptText = composeSystemPromptText(identity, chainBlock);
  if (promptText) {
    // Only a real identity may replace the system prompt; a block-only delivery
    // always appends, so it can never drop pi's own prompt.
    const flag = identity && loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    parts.push(flag, shellEscape(writePromptFile(identity ? "sysprompt" : "chain-context", promptText)));
  }

  // Default-deny: disable global extension discovery and re-enable only the
  // extensions backing the whitelisted tools. A null allowlist means the spawn
  // was intentionally unrestricted (e.g. a fork clone) and is replayed as-is.
  if (loadout.toolAllowlist) {
    parts.push("--no-extensions");
    parts.push("--tools", shellEscape(loadout.toolAllowlist));

    const extPaths = new Set<string>();
    for (const tool of loadout.toolAllowlist.split(",")) {
      const extPath = getToolExtensionPath(tool);
      if (extPath && existsSync(extPath)) extPaths.add(extPath);
    }
    for (const extPath of extPaths) {
      parts.push("-e", shellEscape(extPath));
    }
  }
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };
  // Pre-existing typing quirk: the negative side of this union does not narrow
  // under the project's non-strict tsconfig, so spell the failure side out once
  // instead of reading read.reason/read.error off the un-narrowed union.
  const readFailure: Extract<ActivityReadResult, { ok: false }> | null = read.ok
    ? null
    : (read as Extract<ActivityReadResult, { ok: false }>);

  running.activityRead = readFailure
    ? { ok: false, reason: readFailure.reason, error: readFailure.error }
    : { ok: true };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: readFailure?.reason,
    snapshotError: readFailure?.error,
  }, observedAt);
}

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 *
 * The claim is remembered PER SPAWNER SESSION, like every other name store here:
 * a launch in flight in session B must not reject a name in session A, nor make a
 * generated name in A suffix. A reservation is held for the whole launch — pane
 * creation included — so an unscoped set was a real cross-session false rejection,
 * not just a theoretical one. An entry with no session (only a test can make one;
 * every production `add` passes its id) is honoured by every session, the same
 * conservative rule `nameRowVisibleTo` uses: an unattributable claim may be
 * honoured, never stolen. Iteration stays process-wide so the widget/tests can
 * still see everything; READERS pass a session id.
 *
 * Claims are stored as SESSION -> its claimed names, never as one owner slot per
 * name. Session scoping makes two sessions reserving the SAME name concurrently
 * legal, and a single slot would be overwritten by whichever reserved second —
 * after which the first session's own next parallel spawn would read its own
 * in-flight claim as free and take that name a second time: two same-named rows in
 * one session, and `subagent_message` answering "Ambiguous subagent name" to a
 * handle that was unique when it was chosen. Releasing is per session for the same
 * reason: A's launch finishing must not silently cancel B's claim beside it.
 */
class SessionReservedNames extends Set<string> {
  /** spawner session id (null = unattributed) -> the names that session claims. */
  private claims = new Map<string | null, Set<string>>();

  private claimSet(sessionId: string | null): Set<string> {
    let names = this.claims.get(sessionId);
    if (!names) {
      names = new Set();
      this.claims.set(sessionId, names);
    }
    return names;
  }

  /** Which sessions currently claim `name` (null = an unattributed claim). */
  private claimants(name: string): Array<string | null> {
    const holders: Array<string | null> = [];
    for (const [sessionId, names] of this.claims) if (names.has(name)) holders.push(sessionId);
    return holders;
  }

  override add(name: string, sessionId?: string | null): this {
    this.claimSet(sessionId ?? null).add(name);
    return super.add(name);
  }

  /**
   * Is this claim in force for `sessionId`? Only THIS session's claims and claims
   * nobody can attribute are; another session's launch is not a conflict here (and
   * with no `sessionId` the caller cannot be attributed, so every claim counts).
   */
  override has(name: string, sessionId?: string | null): boolean {
    if (!super.has(name)) return false;
    if (!sessionId) return true;
    if (this.claims.get(null)?.has(name)) return true;
    if (this.claims.get(sessionId)?.has(name)) return true;
    // A union entry no session claims has no owner to scope it by — honoured, not
    // stolen, exactly like a running row whose `parentSessionId` is missing.
    return this.claimants(name).length === 0;
  }

  /**
   * Release a claim. WITH a session id only that session's claim goes, and the
   * name leaves the union only when no session holds it any more; WITHOUT one the
   * caller cannot attribute the release, so the name is released everywhere (which
   * is what the tests clean up with).
   */
  override delete(name: string, sessionId?: string | null): boolean {
    if (sessionId === undefined) {
      let removed = false;
      for (const names of this.claims.values()) {
        if (names.delete(name)) removed = true;
      }
      return super.delete(name) || removed;
    }
    const removed = this.claims.get(sessionId ?? null)?.delete(name) ?? false;
    if (this.claimants(name).length === 0) super.delete(name);
    return removed;
  }

  override clear(): void {
    this.claims.clear();
    super.clear();
  }
}

const reservedNames = new SessionReservedNames();

// ── Chain step-name reservations (the ONLY place step promises are consulted) ──

/**
 * A name a chain has PROMISED but not yet CLAIMED.
 *
 * A chain records its steps' explicit names the moment it starts, but a step only
 * takes its name when it launches — minutes later. In between that name answers to
 * nothing in `runningSubagents`, `reservedNames` or the registry, so the ordinary
 * checks would call it free, and a newcomer that took it would make the chain's
 * later step fail on the very name its caller chose. The promise therefore holds
 * the name as a RESERVATION, and the two central naming helpers —
 * `findNameConflict` (explicit names) and `uniqueRunningName` (generated names) —
 * are its only readers. Naming call sites pass nothing chain-shaped and cannot
 * forget to ask: asking happens inside the helpers.
 *
 * The map is keyed by SPAWNER SESSION ID, exactly like the chain map, and NOT put
 * into the process-global `reservedNames`: a chain of session A must not spend a
 * name in session B. Every production naming path passes its session id — the six
 * call sites of `findNameConflict`/`uniqueRunningName` all do — and
 * `unscopedStepNameLockReads` counts the times one did not, so a future site that
 * forgets fails a test instead of silently going process-wide. A lookup with no
 * session id cannot attribute the caller, and then assumes the whole process — the
 * same assumption its running and in-flight-reservation checks already make.
 *
 * Leaks matter more than the rare steal: a leaked reservation spends a name for
 * the process forever. So every lock carries the chain it belongs to, is released
 * on every terminal path (step start, chain finish, early stop, abort, session
 * shutdown), and is verified on READ — a lock whose chain is finished, aborted, or
 * no longer sitting on a `pending` step is stale, so it is dropped and the name is
 * free. A lock can therefore only ever outlive its usefulness for one lookup.
 */
type StepNameLock = { chain: ActiveChain; stepIndex: number };

const stepNameLocks = new Map<string, Map<string, StepNameLock>>();

/**
 * How many times a reservation was consulted WITHOUT a session id. Every naming
 * path in the extension knows its spawner session (all six call sites pass
 * `ctx.sessionManager.getSessionId()`), so production must leave this at zero; an
 * unscoped lookup is the one case where the check stops being session-scoped and
 * honours the whole process, exactly like the running/`reservedNames` checks beside
 * it. Exported only so a test can prove production never takes that branch.
 */
let unscopedStepNameLockReads = 0;

function stepNameLockMapForSession(sessionId: string): Map<string, StepNameLock> {
  let m = stepNameLocks.get(sessionId);
  if (!m) {
    m = new Map();
    stepNameLocks.set(sessionId, m);
  }
  return m;
}

/**
 * Reserve the explicit names of every step this chain has not started. Generated
 * names are NOT locked: they are decided at launch time and must keep
 * auto-suffixing silently. Call this only once a chain is really registered, so a
 * rejected chain call never locks anything.
 */
function lockPendingStepNames(sessionId: string, chain: ActiveChain): void {
  const map = stepNameLockMapForSession(sessionId);
  for (const step of chain.steps ?? []) {
    if (step.name && step.status === "pending") {
      map.set(step.name, { chain, stepIndex: step.index });
    }
  }
}

/**
 * Release this chain's reservations — all of them, or just one step's. Matched by
 * chain IDENTITY, not by session id, so a caller that only has the chain (a
 * teardown path, a `catch` that lost its ctx) can never miss, and so an entry a
 * later chain took over under the same name is never dropped by mistake.
 */
function releaseStepNameLocks(chain: ActiveChain, stepIndex?: number): void {
  for (const map of stepNameLocks.values()) {
    for (const [name, lock] of map) {
      if (lock.chain === chain && (stepIndex === undefined || lock.stepIndex === stepIndex)) {
        map.delete(name);
      }
    }
  }
}

/** Drop every reservation belonging to one session (used by `session_shutdown`). */
function releaseStepNameLocksForSession(sessionId: string | null): void {
  if (sessionId === null) stepNameLocks.clear();
  else stepNameLocks.delete(sessionId);
}

/** A lock whose promise can no longer be kept: its chain never reaches the step. */
function stepNameLockIsStale(lock: StepNameLock): boolean {
  const chain = lock.chain;
  if (!chain || chain.finished || chain.aborted || chain.abortController?.signal.aborted) return true;
  const step = chain.steps?.find((s) => s.index === lock.stepIndex);
  // Reaching the step transfers the name to the running row / the registry, and
  // skipping it means the promise is off — either way the lock is spent.
  return !step || step.status !== "pending";
}

/**
 * The names currently held by a reservation, pruning stale entries as it reads.
 * A `sessionId` of `undefined` means "whoever they are" — see
 * `unscopedStepNameLockReads` for why production must never ask that.
 */
function lockedStepNames(sessionId: string | undefined): Set<string> {
  if (sessionId === undefined) unscopedStepNameLockReads++;
  const names = new Set<string>();
  for (const [sid, map] of stepNameLocks) {
    if (sessionId && sid !== sessionId) continue;
    for (const [name, lock] of map) {
      if (stepNameLockIsStale(lock)) map.delete(name);
      else names.add(name);
    }
  }
  return names;
}

/**
 * The one sentence every name collision produces. An orchestrator needs the KIND
 * of name, the name, and that it is in use — nothing else. Who holds it, why, and
 * how to address it are `details` (kind/holder/step/error), which renderers and
 * tests read; prose is not where that nuance belongs.
 *
 * `subject` is what the thing being named is called: "spawn" (a sub-agent name),
 * "chain" (a chain handle) or "chain step" (a step's name).
 */
function nameInUseMessage(name: string, subject = "spawn"): string {
  const kind =
    subject === "chain" ? "Sub-agent chain name" : subject === "chain step" ? "Sub-agent chain step name" : "Sub-agent name";
  return `${kind} "${name}" is already in use. Choose a different name.`;
}

/** A held name as a rejection message, or null when nothing reserves it. */
function findStepNameLockConflict(
  name: string,
  sessionId: string | undefined,
  subject = "spawn",
): { kind: "pending-step"; holder: string; message: string } | null {
  if (sessionId === undefined) unscopedStepNameLockReads++;
  const requested = name.trim();
  if (!requested) return null;
  for (const [sid, map] of stepNameLocks) {
    if (sessionId && sid !== sessionId) continue;
    const lock = map.get(requested);
    if (!lock) continue;
    if (stepNameLockIsStale(lock)) {
      map.delete(requested);
      continue;
    }
    return {
      kind: "pending-step",
      holder: lock.chain.name,
      message: nameInUseMessage(requested, subject),
    };
  }
  return null;
}

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet). `extraTaken` adds whatever else
 * the caller knows is spent — for chain steps and for spawns, this session's chain
 * handles (a generated name that took one would shadow the chain: resolution tries
 * running subagents first).
 *
 * Names held by a chain's not-yet-started steps are added HERE, not by the caller:
 * every generated name in the extension steps aside for a promise without knowing
 * that reservations exist. `sessionId` scopes that lookup to one spawner session;
 * omitted means every session (see `lockedStepNames`).
 */
function uniqueRunningName(
  base: string,
  registryNames?: Set<string>,
  extraTaken?: Iterable<string>,
  sessionId?: string,
): string {
  // Session-scoped like every other name store here: another session's sub-agent
  // must not make a GENERATED name here suffix (see `nameRowVisibleTo`).
  const taken = new Set(
    Array.from(runningSubagents.values()).filter((r) => nameRowVisibleTo(r, sessionId)).map((r) => r.name),
  );
  for (const reserved of reservedNames) {
    if (reservedNames.has(reserved, sessionId)) taken.add(reserved);
  }
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (extraTaken) for (const n of extraTaken) taken.add(n);
  for (const n of lockedStepNames(sessionId)) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Is an EXPLICITLY chosen name already taken? Returns the reason it is not
 * usable, or null when it is free.
 *
 * Policy: a name the caller typed is the caller's handle, so a collision is
 * REJECTED rather than silently auto-suffixed (auto-suffixing would hand back a
 * different handle than the one the caller will use with `subagent_message`, and
 * `registerName` would quietly overwrite the previous holder's registry entry,
 * costing that sub-agent its name-addressability). Only DEFAULTED names are
 * suffixed — see `uniqueRunningName`.
 *
 * Three sources, in order of how urgent they are to report: a running
 * sub-agent, a name claimed by a parallel spawn that is still mid-launch, a name a
 * chain has promised to a step it has not reached, and this session's persistent
 * registry (a finished sub-agent, reachable by name).
 *
 * `sessionId` scopes ALL FOUR of those to one spawner session, the way the chain
 * map and the step-name reservations are scoped: two sessions in one process may
 * each run a `worker`, and neither may be told its name is taken by the other.
 * A row or reservation with no attributable owner is honoured by every session
 * (see `nameRowVisibleTo`); with no `sessionId` the caller cannot be attributed,
 * so the whole process is honoured — the same assumption the rest of the naming
 * code makes.
 *
 * The chain reservation check lives HERE, not at the call sites: an explicit name
 * is protected from a chain's promise wherever it comes from, and a call site that
 * has never heard of chains cannot skip it. `sessionId` scopes that check the way
 * the chain map is scoped; omitted means every session (see `lockedStepNames`).
 *
 * `subject` is what the error should call the thing being named ("spawn", "chain",
 * "chain step") so the advice reads correctly; the caller-supplied-name policy is
 * identical for all of them.
 */
function findNameConflict(
  name: string,
  parentArtifactDir: string,
  subject = "spawn",
  sessionId?: string,
): { kind: "running" | "reserved" | "pending-step" | "registry"; holder?: string; message: string } | null {
  const requested = name.trim();
  if (!requested) return null;

  const running = Array.from(runningSubagents.values()).filter(
    (r) => r.name === requested && nameRowVisibleTo(r, sessionId),
  );
  if (running.length) {
    return {
      kind: "running",
      holder: running[0].id,
      message: nameInUseMessage(requested, subject),
    };
  }

  if (reservedNames.has(requested, sessionId)) {
    return {
      kind: "reserved",
      message: nameInUseMessage(requested, subject),
    };
  }

  const heldByChain = findStepNameLockConflict(requested, sessionId, subject);
  if (heldByChain) return heldByChain;

  if (resolveNameInRegistry(parentArtifactDir, requested)) {
    return {
      kind: "registry",
      message: nameInUseMessage(requested, subject),
    };
  }

  return null;
}

/**
 * Is a name already spent as a CHAIN handle in this session? Same policy as
 * `findNameConflict` — a caller-supplied name is rejected, never renamed — but
 * the source is the session's chain map rather than the sub-agent side. Chains
 * are never pruned from that map, so a FINISHED chain's name stays spent: a
 * later chain may not take it, and `subagent_message` keeps resolving it to the
 * chain that had it (which answers with its steps, not with a new chain).
 */
function findChainNameConflict(
  name: string,
  sessionChains: Map<string, ActiveChain>,
  subject = "chain",
): { kind: "chain"; holder: string; message: string } | null {
  const requested = name.trim();
  const chain = sessionChains.get(requested);
  if (!chain) return null;
  return {
    kind: "chain",
    holder: chain.name,
    message: nameInUseMessage(requested, subject),
  };
}

/**
 * The names PROMISED but not yet claimed now live as reservations — see
 * `stepNameLocks` above — because a mechanism every naming path has to remember to
 * call is a mechanism a future call site can forget. `lockedStepNames` and
 * `findStepNameLockConflict` are the readers, and both are called from inside
 * `uniqueRunningName` / `findNameConflict`.
 */

function resolveRunningByName(name: string, sessionId?: string | null):
  | { running: RunningSubagent }
  | { error: string; ambiguous?: boolean } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  // Session-scoped, like every name store in this extension: `runningSubagents` is
  // process-global but names are only unique WITHIN a session, so two sessions that
  // each run a `worker` must not make every lookup ambiguous. Ambiguity is still a
  // hard error when this session really does have two rows under one name.
  const visible = Array.from(runningSubagents.values()).filter((r) => nameRowVisibleTo(r, sessionId));
  const matches = visible.filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = visible.map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  // `ambiguous` lets a caller tell "several rows answer to this name" apart from
  // "none does" without string-matching the message: the first is a hard stop,
  // the second is a reason to try the chain/registry paths.
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`, ambiguous: true };
}

/**
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
  try {
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via tmux: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

/**
 * Deliver a message to a running subagent.
 *
 * If the subagent is currently blocked in `ask_question` — its
 * `${sessionFile}.ask` signal file exists AND its latest activity is the
 * `ask_question` event (childIsAsking) — the message IS the orchestrator's
 * reply: it is written atomically (temp file + rename) to
 * `${sessionFile}.ask-reply` as JSON `{ askedAt, text }`, the `askedAt`
 * echoed from the `.ask` file so the child can reject a reply from a
 * different question cycle. Nothing is typed into the pane. Otherwise the
 * message is typed into the live pane as a plain steer.
 *
 * Routing keys off the `.ask` file's existence (the parent cannot see the
 * child's in-memory state), so a `.ask` that outlives the wait would
 * misroute the next steer into the sidecar. That case is handled at the
 * source: the child unlinks `.ask` on abort/timeout/consumption, the
 * watcher unlinks both sidecars when the child's pane dies, and a resume
 * unlinks them before relaunching — with the activity cross-check as a
 * second line of defence for a live child that is not waiting.
 */
let askReplyTmpSeq = 0;

/**
 * Cross-check the `.ask` signal against the child's latest activity: a
 * child blocked in `ask_question` has parked its activity at
 * `latestEvent: "ask_question"`. A stale `.ask` (the child is no longer
 * waiting) must not turn a plain steer into a swallowed reply. When the
 * activity is unknown (file missing/unreadable) the `.ask` file itself —
 * which the child writes immediately before blocking — is trusted.
 */
function childIsAsking(running: RunningSubagent): boolean {
  const activityFile = running.activityFile;
  if (!activityFile) return true; // unknown → trust the .ask signal
  const read = readSubagentActivityFile(activityFile, running.id);
  if (!read.ok) return true; // unknown → trust the .ask signal
  return read.activity.latestEvent === "ask_question";
}

function deliverSubagentSteer(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { mode: "reply" } | { mode: "typed" } | { error: string } {
  const askFile = `${running.sessionFile}.ask`;
  if (existsSync(askFile) && childIsAsking(running)) {
    // Echo the pending question's askedAt into the reply so the child can
    // correlate it; the `.ask` file is authoritative for this cycle. A
    // malformed file degrades to a plain-text reply (no askedAt), which
    // the child accepts.
    let askedAt: number | undefined;
    try {
      const payload = JSON.parse(readFileSync(askFile, "utf8"));
      if (typeof payload?.askedAt === "number") askedAt = payload.askedAt;
    } catch {}
    const replyFile = `${running.sessionFile}.ask-reply`;
    // The seq suffix keeps the temp name unique even for two
    // subagent_message calls in the same millisecond (pid + ms alone
    // would collide and the last rename would win, losing a reply).
    const tmpFile = `${replyFile}.tmp-${process.pid}-${Date.now()}-${++askReplyTmpSeq}`;
    const replyBody =
      typeof askedAt === "number" ? JSON.stringify({ askedAt, text: message }) : message;
    try {
      writeFileSync(tmpFile, replyBody, "utf8");
      renameSync(tmpFile, replyFile);
    } catch (error: any) {
      try {
        unlinkSync(tmpFile);
      } catch {}
      return {
        error:
          `Failed to write the ask_question reply file for subagent "${running.name}": ` +
          `${error?.message ?? String(error)}`,
      };
    }
    return { mode: "reply" };
  }

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) return { error: steer.error };
  return { mode: "typed" };
}

function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendCommand,
  sessionId?: string | null,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "", sessionId);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();
  observeRunningSubagent(running, now);

  const delivered = deliverSubagentSteer(running, message, send);
  if ("error" in delivered) {
    return {
      content: [{ type: "text" as const, text: delivered.error }],
      details: { error: delivered.error, id: running.id, name: running.name },
    };
  }

  // Only a pane-typed steer interrupts the child's TUI. A reply delivered via
  // the `.ask-reply` sidecar is consumed inside the child's current turn, so
  // its activity state is left to the activity observer.
  if (delivered.mode === "typed") {
    running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  }
  updateWidget();

  // The ack is mode-specific: in reply mode the message is NOT picked up
  // at a turn boundary — it is handed to the blocked call, which returns
  // it as the tool result inside the child's current turn.
  const ackText =
    delivered.mode === "reply"
      ? `Reply delivered to subagent "${running.name}": it unblocks the sub-agent's waiting ` +
        `ask_question call, which returns your message as the tool result, and the ` +
        `sub-agent continues with the answer in the same turn.`
      : `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`;

  return {
    content: [{
      type: "text" as const,
      text: ackText,
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(statusSubjectName(running), snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  resolveRunningByName,
  nameRowVisibleTo,
  nameInUseMessage,
  deliverPendingQuestion,
  uniqueRunningName,
  findNameConflict,
  findChainNameConflict,
  lockPendingStepNames,
  releaseStepNameLocks,
  releaseStepNameLocksForSession,
  stepNameLockIsStale,
  lockedStepNames,
  findStepNameLockConflict,
  stepNameLocks,
  unscopedStepNameLockReads: () => unscopedStepNameLockReads,
  launchArtifactPath,
  writeArtifactExclusive,
  artifactNameSlug,
  reservedNames,
  steerSubagent,
  handleSubagentSteer,
  deliverSubagentSteer,
  resolveResultPresentation,
  formatResultIdentity,
  resultLabel,
  formatWatcherError,
  chainShadowNote,
  statusSubjectName,
  resultIdentityFor,
  displayChainName,
  resolveResumeLaunchBehavior,
  runningSubagents,
  parentSessionOf,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
  // Chain internals (unit-test hooks)
  buildChainStepTask,
  buildChainContextBlock,
  buildChainEnvParts,
  composeSystemPromptText,
  chainStepNumber,
  chainBlockForLoadout,
  chainWidgetPosition,
  normalizeChain,
  chainHooks,
  subagentOps,
  formatChainPresentation,
  truncateChainOutput,
  startChain,
  runChain,
  getChainMapForSession,
  chainsBySession,
  MAX_CHAIN_STEPS,
  /** Test hook: stop the widget/status refresh timers (they keep the test process alive). */
  stopTimersForTest() {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
  },
  /** Test hook: install a fake ExtensionContext so updateWidget() renders into a recorder. */
  setLatestCtxForTest(ctx: unknown) {
    latestCtx = ctx as any;
  },
  /** Test hook: is the widget refresh interval currently armed? */
  widgetRefreshActive() {
    return widgetInterval !== null;
  },
  // /agent_model internals (unit-test hooks)
  parseModelOverridesEnv,
  getAgentModelOverride,
  setAgentModelOverride,
  getMergedModelOverrides,
  modelOverridesBySession,
  setInheritedModelOverrides,
  resetAgentModelOverrides,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string; chainContext?: SubagentChainContext },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const sessionId = ctx.sessionManager.getSessionId();
  // Model resolution: explicit tool param > this session's /agent_model
  // override (its own per-session entries, then the snapshot inherited from
  // the spawner — this is what propagates overrides into nested spawns) >
  // the agent file default.
  const effectiveModel =
    params.model ??
    (params.agent ? getAgentModelOverride(sessionId, params.agent) : undefined) ??
    agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  // An agent with a non-empty subagent_agents list is granted the spawning
  // toolset and may only spawn the listed agents (enforced via PI_SUBAGENT_ALLOWED).
  const grantSpawning = !!(agentDefs?.subagentAgents && agentDefs.subagentAgents.length > 0);
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  // Chain position of this launch — undefined for ordinary spawns and for a
  // one-step chain. Advisory only: nothing about it restricts what the step may
  // spawn. It reaches the child two ways: the PI_SUBAGENT_CHAIN_* env vars
  // below, and the `## Chain context` block in its SYSTEM PROMPT — never in the
  // task text, because fullTask is bypassed entirely in fork mode (params.task
  // goes through verbatim) and delivered as an artifact file otherwise.
  const chainContext = options?.chainContext;

  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    // Chain position, machine-readable — the twin of the block below. This path
    // sets no other PI_SUBAGENT_* var (it never persists a loadout, so there is
    // no sandbox to replay), but a `cli: claude` chain step must still get the
    // env channel a pi chain step gets. buildChainEnvParts returns [] for a
    // non-chain launch, so an ordinary Claude spawn is byte-identical to before.
    cmdParts.push(...buildChainEnvParts(chainContext));
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    // Claude CLI path: one --append-system-prompt call, carrying the identity
    // with the chain block appended (there is no shared loadout helper here —
    // this path never persists a loadout). normalizeChain keeps this branch on
    // the same validity gate as the pi path.
    const normalized = normalizeChain(chainContext);
    const chainBlock = normalized
      ? buildChainContextBlock({ ...normalized, agent: params.agent ?? "" })
      : "";
    const sp = composeSystemPromptText(agentDefs.body, chainBlock);
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    cmdParts.push(shellEscape(params.task));

    const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    const launchScriptName = `${(params.name || "subagent")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      parentSessionId: sessionId,
      launchScriptFile,
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    return running;
  }

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  // Resolve the config dir the child sees: a target-local .pi/agent/ wins,
  // else the propagated global dir. Captured once so the launch env and the
  // resume snapshot agree.
  const resolvedAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : process.env.PI_CODING_AGENT_DIR ?? null;

  // Default-deny model: when an agent restricts its tools (or is granted the
  // spawning toolset), we disable global extension discovery and re-enable only
  // the extensions backing the whitelisted tools. Bare/fork spawns with no tool
  // restriction keep their full default toolset and all global extensions.
  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, { grantSpawning });

  // Snapshot the session's model overrides (inherited + per-session) so a
  // later resume can re-emit the same PI_SUBAGENT_MODEL_OVERRIDES for this
  // subagent's own nested spawns.
  const modelOverrides = getMergedModelOverrides(sessionId);

  // Snapshot the fully-resolved sandbox beside the session file so a later
  // `subagent_message({ name })` resume can replay the exact same
  // restriction instead of relaunching pi with all global extensions + tools.
  const loadout: SubagentLoadout = {
    agent: params.agent ?? null,
    toolAllowlist,
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    spawnable: agentDefs?.subagentAgents ?? null,
    autoExit: agentDefs?.autoExit ?? false,
    cwd: effectiveCwd ?? null,
    agentDir: resolvedAgentDir,
    modelOverrides: Object.keys(modelOverrides).length > 0 ? modelOverrides : null,
    // Persisted so a resume rebuilds the same block and replays the same
    // position; the block itself is injected by applySandboxToParts().
    chain: chainContext ?? null,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Apply model, identity, and the default-deny tool/extension restriction via
  // the shared helper (same code path resume uses — they can't drift).
  applySandboxToParts(parts, loadout, { artifactDir, name: params.name, id });

  // Build env prefix: subagent identity + config dir propagation + spawn allowlist
  const envParts: string[] = [];

  if (resolvedAgentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resolvedAgentDir)}`);
  }

  if (grantSpawning && agentDefs?.subagentAgents) {
    envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(agentDefs.subagentAgents.join(","))}`);
  }
  if (Object.keys(modelOverrides).length > 0) {
    envParts.push(`PI_SUBAGENT_MODEL_OVERRIDES=${shellEscape(JSON.stringify(modelOverrides))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  // Chain position (chain steps only) — the machine-readable twin of the
  // system-prompt block. Deliberately absent (never set to "") for non-chain
  // launches, and that is safe in both directions: these are per-command `VAR=x
  // cmd` assignments scoped to this one process, and the pane itself is created
  // by `tmux split-window`, whose shell inherits the tmux *server* environment,
  // not the spawner's. So a chain step's own child spawn can neither inherit a
  // stale PI_SUBAGENT_CHAIN_* nor see one it was never given.
  envParts.push(...buildChainEnvParts(chainContext));
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const artifactPath = launchArtifactPath(artifactDir, { dir: "context", name: params.name, id });
    taskArg = `@${writeArtifactExclusive(artifactPath, fullTask)}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    parentSessionId: sessionId,
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently.
 *
 * The `.ask` file is deliberately NOT deleted here: the subagent's blocking
 * `ask_question` call consumes the reply and unlinks the file itself, and the
 * parent's `subagent_message` checks for the file (plus the child's activity,
 * via childIsAsking) to route a reply into the
 * `${sessionFile}.ask-reply` sidecar. Notification is still once per question
 * — deduped by the payload content key (`lastNotifiedAsk`), so an unchanged
 * lingering file does not re-notify, while a new question (or a re-ask)
 * notifies again.
 *
 * A lingering `.ask` is NOT harmless for reply routing: a child that stops
 * waiting without cleaning up (e.g. SIGKILL mid-wait) would otherwise keep
 * steering the orchestrator's replies into the sidecar. That case is
 * handled at the source — the child unlinks `.ask` on abort, the watcher
 * unlinks both sidecars when the pane dies, and a resume unlinks them
 * before relaunching — with the activity cross-check as a second line of
 * defence for a live child that is not waiting.
 *
 * A `.ask` file that keeps failing to parse (e.g. the child died mid-write)
 * is given up on: after a few consecutive parse failures the file is
 * unlinked, so it neither clogs the notification loop forever nor keeps
 * steering replies into the sidecar.
 */
const ASK_PARSE_GIVE_UP_AFTER = 3;

function deliverPendingQuestion(running: RunningSubagent): void {
  const askFile = `${running.sessionFile}.ask`;
  let payload: any = null;
  try {
    if (!existsSync(askFile)) return;
    payload = JSON.parse(readFileSync(askFile, "utf-8"));
  } catch {
    // Malformed/partway-written file. Tolerate a few ticks (the child may
    // still be writing); give up after N consecutive failures.
    running.askParseFailures = (running.askParseFailures ?? 0) + 1;
    if (running.askParseFailures >= ASK_PARSE_GIVE_UP_AFTER) {
      try {
        unlinkSync(askFile);
      } catch {}
    }
    return;
  }
  running.askParseFailures = 0;
  if (!payload?.question) return;

  const askKey = `${payload.askedAt ?? ""}|${payload.question}`;
  if (running.lastNotifiedAsk === askKey) return;
  running.lastNotifiedAsk = askKey;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  // NOTE: routed through `latestPi`, which is process-global — see the caveat at its
  // declaration. The reply itself is resolved by the session that acts on it, so the
  // name below always addresses the right sub-agent.
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `${resultLabel(resultIdentityFor(running))} asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  options?: { onTick?: () => void },
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      onTick() {
        observeRunningSubagent(running);
        deliverPendingQuestion(running);
        options?.onTick?.();
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // The pane is gone: any `.ask`/`.ask-reply` sidecars on this session
    // file are stale — the child died without consuming them (e.g.
    // SIGKILL while blocked in ask_question). Unlink them so a later
    // resume of this session doesn't misroute its first steer into the
    // reply sidecar or re-notify the dead question.
    try {
      unlinkSync(`${sessionFile}.ask`);
    } catch {}
    try {
      unlinkSync(`${sessionFile}.ask-reply`);
    } catch {}

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      closeSurface(surface);
      runningSubagents.delete(running.id);

      return { name, task, summary, exitCode: result.exitCode, elapsed, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    closeSurface(surface);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A shutdown that cannot attribute
    // its session — or the last session in the process — aborts the shared module
    // poll-abort controller; install a fresh one so subagents spawned in this
    // session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
  });

  // Clean up on session shutdown.
  //
  // pi can serve more than one session from one process, and every piece of
  // state below is module-global: one flat `runningSubagents`, one
  // `chainsBySession` (keyed by spawner session id), one widget/status timer
  // pair, one module poll signal. So teardown is scoped by the id THIS handler
  // was invoked for — reading the shared maps by position cancelled other
  // sessions' chains and watchers and steered THEIR orchestrators with a
  // "parent session shut down" message about a session that never shut down.
  pi.on("session_shutdown", (_event, ctx) => {
    let sessionId: string | null = null;
    try {
      sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
    } catch {
      // No id means we cannot tell our work from a stranger's.
    }
    // With no id the only safe reading of the shared state is "all of it":
    // aborting everything is acceptable for an unattributed shutdown, while a
    // KNOWN session must never abort a session it is not. A row that carries no
    // owner at all counts as ours too, so it gets torn down rather than being
    // mistaken for someone else's and left polling forever.
    const isOurs = (owner: string | null) =>
      sessionId === null || owner === null || owner === sessionId;

    // This session's watchers. A row's own controller covers ordinary spawns
    // and resumes; chain steps are watched through their CHAIN's signal, so the
    // chains below have to be aborted as well or a step's poll loop survives.
    // Removing the rows here matches what the old `clear()` did — the aborted
    // watcher deletes its own row later, which is a no-op on an absent key.
    for (const [id, agent] of runningSubagents) {
      if (!isOurs(parentSessionOf(agent))) continue;
      agent.abortController?.abort();
      runningSubagents.delete(id);
    }
    // Chains are already partitioned by spawner session id, so this session's
    // chains are exactly ONE map — not the outer `chainsBySession`, whose other
    // entries belong to whoever else shares the process. (The comment here used
    // to claim chains "belong to this session's process"; they don't.) Aborted
    // chains still deliver their aggregate steer, which reports the cancellation.
    const ownChainMaps = sessionId === null
      ? Array.from(chainsBySession.values())
      : [getChainMapForSession(sessionId)];
    for (const chains of ownChainMaps) {
      for (const chain of chains.values()) {
        if (!chain.finished) {
          chain.aborted = true;
          chain.abortController.abort();
        }
      }
    }
    // ... and their step-name reservations go with them, so a name a chain of THIS
    // session promised is not spent after the session is gone. Scoped by session id
    // like the chain maps above — a stranger session's chains keep their promises
    // (an unattributed shutdown is the case where everything counts as ours). The
    // aborted chains' locks would already read as stale; dropping them here is what
    // keeps the map itself from accumulating.
    for (const chains of ownChainMaps) {
      for (const chain of chains.values()) releaseStepNameLocks(chain);
    }
    releaseStepNameLocksForSession(sessionId);

    // The two refresh timers and the module poll signal are process-global by
    // design — ONE interval pair renders whatever ctx was captured last, and the
    // poll signal is OR-ed into every watcher in the process — so they belong to
    // the process, not to this session, and come down only once nothing else in
    // the process still needs them. Clearing them because a stranger exited
    // would freeze another session's widget and abort its watchers mid-poll (a
    // fresh pair is re-armed by the next spawn either way). A whole-process exit
    // still stops them: by then nothing of anyone else is left.
    //
    // A chain that is already aborted does NOT count as work needing the timers:
    // `aborted`/`signal.aborted` are set synchronously by that chain's own
    // teardown, while `finished` only turns true once `runChain` unwinds (async).
    // In that window the dying chain would look like live work from a session that
    // has already exited — and since no further `session_shutdown` will ever fire
    // for it, the timers would stay armed forever and keep the process alive.
    const needsTimers = (chain: ActiveChain) =>
      !chain.finished && !chain.aborted && !chain.abortController.signal.aborted;
    const otherWorkRunning =
      Array.from(runningSubagents.values()).some((r) => !isOurs(parentSessionOf(r))) ||
      Array.from(chainsBySession.entries()).some(
        ([sid, chainMap]) => !isOurs(sid) && Array.from(chainMap.values()).some(needsTimers),
      );
    if (otherWorkRunning) return;

    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready. " +
        "Chains: instead of agent+task, pass chain: [{agent, task}, ...] to run subagents one after another " +
        "(e.g. worker → reviewer → worker). Each step's final output is automatically appended to the next step's task — " +
        "you never need a {previous} placeholder or to paste prior output yourself. " +
        "The chain runs in the background and the aggregate result for the whole chain is delivered as a steer message " +
        "when the last step finishes, or when the chain stops early because a step failed. " +
        "To reach the currently running step, use subagent_message with the chain name or the step's own name. " +
        "Every completion steer names the run it belongs to — `Sub-agent \"<name>\" (agent: <agent>) completed …`, " +
        "plus `; chain \"<chain>\" step i/N` for a chain step — so you always know which child woke you up.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready. " +
        "Chains: pass chain: [{agent, task}, ...] instead of agent+task to run subagents one after another — " +
        "each step's final output is automatically appended to the next step's task (no {previous} placeholder needed). " +
        "The aggregate chain result arrives as a steer message when the chain finishes. " +
        "Completion steers name the run: `Sub-agent \"<name>\" (agent: <agent>; chain \"<chain>\" step i/N)`.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
        const hasSingle = Boolean(params.agent || params.task);

        if (hasChain && hasSingle) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Provide either a single spawn (agent + task) or a chain (chain array of steps) — not both. " +
                  "For sequential worker → reviewer → worker style workflows use chain with one {agent, task} entry per step.",
              },
            ],
            details: { error: "chain and single spawn are mutually exclusive" },
          };
        }

        // Strict whitelist at every depth. The caller's permitted set is:
        //   • a restricted subagent (PI_SUBAGENT_ALLOWED) → only its pinned agents;
        //   • a top-level session → every discoverable agent, i.e. exactly what
        //     `subagents_list` shows.
        // Every spawn must name an agent in that set. Without this guard a missing or
        // unknown `agent` silently launches an unrestricted, full-toolset child.
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        const permittedAgents = SUBAGENT_ALLOWLIST
          ? [...SUBAGENT_ALLOWLIST]
          : discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        // ── Chain mode: validate + kick off, then return an acknowledgement ──
        if (hasChain) {
          return startChain(params, permittedSet, permittedList, currentAgent, ctx, pi);
        }

        // ── Single-spawn mode ──
        // Prevent self-spawning (e.g. planner spawning another planner)
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        if (!params.agent || !params.task) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field (with a "task"), ` +
                  `or provide a "chain" array of {agent, task} steps for a sequential chain. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent+task or chain required" },
          };
        } else if (!permittedSet.has(params.agent)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You may not spawn the "${params.agent}" agent — it is not ` +
                  `${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: {
              error: SUBAGENT_ALLOWLIST ? "agent not in allowlist" : "unknown agent",
            },
          };
        }

        // Validate prerequisites (need mux + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // Default the cosmetic pane label to the agent name when omitted,
        // disambiguating against running subagents, in-flight reservations, and
        // every name already in the registry — so names stay unique across the
        // whole session, running or finished. Reserve the chosen name
        // synchronously (before any await) so parallel spawns don't collide.
        // When the name was SUPPLIED instead, uniqueness is a precondition: a
        // collision is rejected below, not renamed.
        let reservedName: string | null = null;
        const spawnSessionId = ctx.sessionManager.getSessionId();
        const spawnChains = getChainMapForSession(spawnSessionId);
        if (!params.name?.trim()) {
          const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
          // A chain handle of this session is invisible to the running/reserved/
          // registry sets, so it is handed in explicitly — a generated name that
          // took one would shadow the chain and leave it unaddressable. The names
          // this session's chains have promised to steps that have not started are
          // added by `uniqueRunningName` itself, from the reservations.
          params.name = uniqueRunningName(params.agent, registryNames, spawnChains.keys(), spawnSessionId);
          reservedName = params.name;
          reservedNames.add(reservedName, spawnSessionId);
        } else {
          // An EXPLICIT name belongs to the caller: it is the handle they will
          // use with subagent_message, so a collision is REJECTED, never quietly
          // suffixed (and `registerName` would otherwise overwrite the previous
          // holder's registry entry and cost that sub-agent its name).
          // Chain handles count too — a chain of this session already answers to
          // that name, and running subagents are resolved first, so sharing it
          // would leave the chain unreachable through its own name.
          // The check and the reservation are one synchronous block — no await in
          // between — so two parallel explicit spawns of the same name cannot
          // both pass: the loser finds the winner in `reservedNames`. Released in
          // the `finally` below, exactly like the defaulted path.
          const explicitName = params.name.trim();
          const conflict =
            findChainNameConflict(explicitName, spawnChains, "spawn") ??
            findNameConflict(explicitName, parentArtifactDir, "spawn", spawnSessionId);
          if (conflict) {
            return {
              content: [{ type: "text", text: conflict.message }],
              details: {
                error: conflict.message,
                kind: conflict.kind,
                ...(conflict.holder ? { holder: conflict.holder } : {}),
              },
            };
          }
          params.name = explicitName;
          reservedName = explicitName;
          reservedNames.add(reservedName, spawnSessionId);
        }

        // Launch the subagent (creates pane, sends command). Release the name
        // reservation once it registers in runningSubagents (or launch fails) —
        // from then on uniqueRunningName tracks it via the running map.
        // Going through `subagentOps` (identical to the direct call by default,
        // and what the chain step runner already uses) is what lets a test prove
        // a rejected spawn launched nothing.
        let running;
        try {
          running = await subagentOps.launch(params, ctx);
        } finally {
          // Released FOR THIS SESSION only — another session may be holding the very
          // same name in its own launch, and its claim is not ours to cancel.
          if (reservedName) reservedNames.delete(reservedName, spawnSessionId);
        }

        // Persist name → session so subagent_message({ name }) can resume this
        // subagent after it finishes (and after a pi restart). Done at launch,
        // not completion, so the handle exists even if the parent dies mid-run.
        registerName(parentArtifactDir, running.name, {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
        });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background (same seam as `launch`,
        // so a test that stubs the launch path can stub the watcher too).
        subagentOps
          .watch(running, watcherAbort.signal)
          .then((result) => {
            updateWidget(); // reflect removal from Map immediately

            const presentation = resolveResultPresentation(result, resultIdentityFor(running));

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                  ...(result.stats ? { stats: result.stats } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            // Same header as the success/failure paths — a watcher that throws
            // must still say which run it was watching.
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: formatWatcherError(resultIdentityFor(running), err),
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;

        // Chain mode: show the step sequence.
        const chain = Array.isArray(partialArgs.chain) ? (partialArgs.chain as any[]) : null;
        if (chain && chain.length > 0) {
          const chainName =
            typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "chain";
          let text =
            "○ " +
            theme.fg("toolTitle", theme.bold(chainName)) +
            theme.fg("accent", ` — chain (${chain.length} steps)`);
          chain.slice(0, 5).forEach((s, i) => {
            const agent = s && typeof s.agent === "string" ? s.agent : "...";
            const task = s && typeof s.task === "string" ? s.task : "";
            // renderCall is called repeatedly as the LLM generates arguments,
            // so the task grows token by token — keep it to one short line.
            const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
            const preview = firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
            text +=
              "\n  " +
              theme.fg("muted", `${i + 1}.`) +
              " " +
              theme.fg("accent", agent) +
              (preview ? theme.fg("dim", ` ${preview}`) : "");
          });
          if (chain.length > 5) text += `\n  ${theme.fg("muted", `... +${chain.length - 5} more`)}`;
          return new Text(text, 0, 0);
        }

        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct cosmetic name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // "Chain started" result — tool returned immediately; the chain runs
        // in the background and reports via a steer message when it finishes.
        if (details?.status === "chain-started") {
          const chainName = details.chainName ?? "chain";
          const steps: any[] = details.steps ?? [];
          const stepList = steps.map((s) => s.agent).join(" → ");
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(chainName)) +
              theme.fg("dim", ` — chain started (${steps.length} steps: ${stepList})`) +
              theme.fg("muted", " · result arrives as a steer message"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const fallbackText = result.content[0] as { text?: string } | undefined;
        const text = typeof fallbackText?.text === "string" ? fallbackText.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Send a message to a subagent by name. Names are unique within your session and persist after a subagent finishes, " +
        "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
        "if it has finished, your message resumes that session and continues it. " +
        "A name that matches BOTH a running subagent and an active chain goes to the running subagent, and the reply then says so and names the chain's current step — address that step by its own name to reach the chain. " +
        "`name` and `message` are both required. " +
        "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
        "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
        "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
        "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
      promptSnippet:
        "Message a subagent by name: steers it if running, resumes it if finished (same name either way). " +
        "If a name matches both a running subagent and an active chain, the running subagent gets the message and the reply names the chain's current step. " +
        "`name` and `message` are required. Steering returns immediately; resuming delivers its result later as a steer message. " +
        "Do not poll or fabricate results.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
        }),
        message: Type.String({
          description:
            "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
        }),
      }),

      renderCall(args, theme) {
        const target = args.name ?? "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "steered") {
          // A shadowed name means the reply text carries a collision warning the
          // one-line ack would otherwise hide — keep it visible in the TUI too.
          const warning = details.chainShadowed
            ? "\n" +
              theme.fg(
                "warning",
                "! this name is also an active chain — the message went to the running subagent",
              )
            : "";
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered") +
              warning,
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const fallbackText = result.content[0] as { text?: string } | undefined;
        const text = typeof fallbackText?.text === "string" ? fallbackText.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const requestedName = params.name?.trim();
        if (!requestedName) {
          const err = "Provide the subagent's `name` to steer (if running) or resume (if finished).";
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        // ── Steer a running subagent ──
        // A name that matches a currently-running subagent always steers it —
        // resolved through the SAME ambiguity-aware helper the steer itself
        // uses. Picking `.find(...)` here let two rows that share a name be
        // steered as "the first one", and let such an ambiguous name be answered
        // with a chain-shadow note instead of the ambiguity error.
        const resolution = resolveRunningByName(requestedName, ctx.sessionManager.getSessionId());
        if ("error" in resolution && resolution.ambiguous) {
          return { content: [{ type: "text", text: resolution.error }], details: { error: resolution.error } };
        }
        const runningMatch = "running" in resolution ? resolution.running : null;
        if (runningMatch) {
          const steer = handleSubagentSteer(
            { name: requestedName, message: params.message },
            sendCommand,
            ctx.sessionManager.getSessionId(),
          );
          // Resolution order is running → chain → registry, so a chain that was
          // given a name a subagent already answers to can never be reached
          // here. Steering the live subagent is still the right call — but the
          // collision has to be VISIBLE, or the orchestrator believes it just
          // steered the chain. Hence a note on the returned text plus
          // details.chainShadowed (details.error keeps its meaning unchanged).
          const shadow = getChainMapForSession(ctx.sessionManager.getSessionId()).get(requestedName);
          if (shadow && !shadow.finished) {
            const head = typeof (steer.content[0] as { text?: string } | undefined)?.text === "string"
              ? (steer.content[0] as { text: string }).text
              : "";
            // "steered" is the only shape handleSubagentSteer returns on success;
            // anything with details.error means nothing was delivered.
            const delivered = !steer.details?.error;
            const note = chainShadowNote(shadow, delivered);
            return {
              content: [{ type: "text" as const, text: head ? `${head}\n\n${note}` : note }],
              details: { ...steer.details, chainShadowed: true },
            };
          }
          return steer;
        }

        // ── Message an active chain ──
        // A chain is not a running subagent itself — its steps are. A name
        // that matches an active chain is delivered to the chain's currently
        // running step, so the orchestrator can steer a chain by one handle.
        const chain = getChainMapForSession(ctx.sessionManager.getSessionId()).get(requestedName);
        if (chain) {
          if (chain.finished) {
            const stepNames = chain.steps.map((s) => s.name).filter(Boolean).join(", ") || "(none recorded)";
            const err =
              `Chain "${requestedName}" has already finished — its aggregate result was delivered as a steer message. ` +
              `To continue working with one of its sessions, message a step by name: ${stepNames}.`;
            return { content: [{ type: "text" as const, text: err }], details: { error: "chain finished" } };
          }
          const current = chain.currentRunning;
          if (!current) {
            const err =
              `Chain "${requestedName}" is between steps right now; the aggregate result steer will arrive shortly. ` +
              `Try again in a moment, or wait for it.`;
            return { content: [{ type: "text" as const, text: err }], details: { error: "chain between steps" } };
          }
          const steer = handleSubagentSteer(
            { name: current.name, message: params.message },
            sendCommand,
            ctx.sessionManager.getSessionId(),
          );
          if (steer.details?.error) return steer;
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Message delivered to chain "${requestedName}" (step ${chain.currentStep}/${chain.steps.length}: ${current.name}). ` +
                  `It is picked up at the step's next turn boundary — or, if the step is currently blocked in ask_question, it unblocks that call and is returned as the tool result. The chain's aggregate result still arrives as a steer message when the chain finishes.`,
              },
            ],
            details: { ...steer.details, chain: requestedName },
          };
        }

        // ── Resume a finished session by name ──
        const message = params.message;
        const name = requestedName; // identity preservation: the resumed run reclaims its name
        const { autoExit, interactive } = resolveResumeLaunchBehavior();
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        // Resolve the name to its session file via this session's registry.
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );
        const entry = resolveNameInRegistry(parentArtifactDir, requestedName);
        if (!entry) {
          const known = Object.keys(readNameRegistry(parentArtifactDir));
          const err =
            `No subagent named "${requestedName}" in this session. ` +
            (known.length > 0
              ? `Known subagents: ${known.join(", ")}.`
              : "No subagents have been spawned in this session yet.");
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        const sessionPath = entry.sessionFile;
        if (!sessionPath || !existsSync(sessionPath)) {
          const err =
            `Subagent "${requestedName}" is registered but its session file is gone ` +
            `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        // A child killed while blocked in ask_question leaves its
        // `.ask`/`.ask-reply` sidecars on this session file. Unlink them
        // before relaunching so the first steer to the resumed child is
        // typed into the pane (not swallowed by the reply sidecar) and
        // the fresh RunningSubagent doesn't re-notify the dead question.
        for (const sidecar of [`${sessionPath}.ask`, `${sessionPath}.ask-reply`]) {
          try {
            unlinkSync(sidecar);
          } catch {}
        }

        // Guard: never resume a session that is still running — two processes
        // mutating the same .jsonl corrupts it. Steer it by name instead.
        for (const r of runningSubagents.values()) {
          if (resolve(r.sessionFile) === resolve(sessionPath)) {
            const err = `Subagent "${requestedName}" is still running as "${r.name}". Your message will steer it; resending as a steer.`;
            return handleSubagentSteer(
              { name: r.name, message: params.message },
              sendCommand,
              ctx.sessionManager.getSessionId(),
            );
          }
        }

        // Reconstruct the sandbox from the snapshot written at spawn time.
        // Without it we cannot safely resume: relaunching bare would load every
        // global extension + the full toolset. Refuse rather than escalate.
        const loadout = readSubagentLoadout(sessionPath);
        if (!loadout) {
          const err =
            `Cannot safely resume "${requestedName}": no sandbox snapshot found for this session ` +
            `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
            `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
            `Re-run the task as a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? requestedName;

        // Record entry count before resuming so we can extract new messages.
        // Count lines cheaply (no per-line JSON.parse) so resuming a large
        // transcript doesn't block the UI.
        const entryCountBefore = countSessionEntryLines(sessionPath);

        const surface = createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
        parts.push("-e", shellEscape(subagentDonePath));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        // Replay the model, identity, and default-deny tool/extension sandbox.
        applySandboxToParts(parts, loadout, { artifactDir, name, id });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          resumeMsgFile = writeArtifactExclusive(
            launchArtifactPath(artifactDir, { dir: "subagent-resume", name, id, fallback: "resume" }),
            message,
          );
          parts.push(shellEscape(`@${resumeMsgFile}`));
        }

        // Build env prefix — replay the snapshot's config dir + spawn whitelist
        // so the resumed process resolves the same agents/extensions and keeps
        // the same nested-spawn restriction it originally ran with.
        const resumeEnvParts: string[] = [];
        const resumeAgentDir = loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null;
        if (resumeAgentDir) {
          resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resumeAgentDir)}`);
        }
        if (loadout.spawnable && loadout.spawnable.length > 0) {
          resumeEnvParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(loadout.spawnable.join(","))}`);
        }
        // Replay the snapshot's model overrides (NOT the live parent map — the
        // loadout is the spawn-time source of truth) so the resumed process
        // keeps the same nested-spawn model semantics it originally ran with.
        if (loadout.modelOverrides && Object.keys(loadout.modelOverrides).length > 0) {
          resumeEnvParts.push(
            `PI_SUBAGENT_MODEL_OVERRIDES=${shellEscape(JSON.stringify(loadout.modelOverrides))}`,
          );
        }
        if (loadout.agent) {
          resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(loadout.agent)}`);
        }
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
        if (autoExit) {
          resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
        }
        // Replay the snapshot's chain position (chain steps only) so the resumed
        // step is told — and can read — the position it originally had, never a
        // recomputed one. The system-prompt block itself comes from
        // applySandboxToParts() above, off the same loadout field.
        resumeEnvParts.push(...buildChainEnvParts(loadout.chain));
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        // Resume in the subagent's original cwd so its tools (safe_bash, edits)
        // operate where they did before.
        const resumeCdPrefix = loadout.cwd ? `cd ${shellEscape(loadout.cwd)} && ` : "";

        const command = `${resumeCdPrefix}${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
        );
        sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
          ].join("\n"),
        });

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: message,
          // The loadout is the only record of what this session actually was —
          // the name alone cannot say "worker" (nor which chain step it was),
          // and the completion text needs both.
          ...(loadout.agent ? { agent: loadout.agent } : {}),
          surface,
          startTime,
          sessionFile: sessionPath,
          // The spawner doing the resume owns this row: `sessionPath` is the
          // resumed sub-agent's own session (its id is `resumedSessionId`), so
          // the owner can only come from ctx.
          parentSessionId: sessionId,
          launchScriptFile,
          activityFile,
          interactive,
          // Widget: a resumed chain step keeps the position it ran with — the
          // same sanitized numbers (and the same opt-out gate) as its block and
          // its env vars, so nothing from the snapshot reaches the TUI unfiltered.
          ...chainWidgetPosition(loadout.chain),
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget();

            const allEntries = getNewEntries(sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const presentation = resolveResultPresentation(
              { ...result, summary, sessionFile: sessionPath, sessionId: resumedSessionId },
              resultIdentityFor(running),
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: message,
                  ...(loadout.agent ? { agent: loadout.agent } : {}),
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: sessionPath,
                  sessionId: resumedSessionId,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            // The sibling of the spawn-path catch above: a resumed run's
            // watcher rejecting must name the run in `content` too, not only
            // in `details` (which the renderers, not the model, read).
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: formatWatcherError(resultIdentityFor(running), err),
                display: true,
                details: {
                  name,
                  error: err?.message,
                  ...(loadout.agent ? { agent: loadout.agent } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionId: resumedSessionId,
            sessionFile: sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /agent_model command — change the model a named sub-agent uses for the
  // rest of this session (in-memory, like pi's /model). Overrides propagate
  // to nested spawns via PI_SUBAGENT_MODEL_OVERRIDES at spawn time.
  registerAgentModelCommand(pi, {
    listAgents: () =>
      discoverAgentDefinitions().map((a) => ({ name: a.name, model: a.model })),
    getOverride: getAgentModelOverride,
    getSessionOverride: (sessionId, agentName) =>
      agentName ? getAgentModelOverrideMap(sessionId).get(agentName) : undefined,
    setOverride: setAgentModelOverride,
    listModelRefs: () => {
      // Argument completion has no ctx; use the last captured session context.
      const models = latestCtx?.modelRegistry.getAvailable();
      return models && models.length > 0
        ? models.map((m) => `${m.provider}/${m.id}`)
        : undefined;
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    // Chain aggregate result: one box listing every step of the chain.
    if (details.chain && Array.isArray(details.steps)) {
      const steps: any[] = details.steps;
      const name = details.name ?? "chain";
      const failed = (details.exitCode ?? 0) !== 0;
      const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
      const completedCount = steps.filter((s) => s.status === "completed").length;
      const bgFn = failed
        ? (text: string) => theme.bg("toolErrorBg", text)
        : (text: string) => theme.bg("toolSuccessBg", text);
      const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");

      return {
        // pi's Component contract — render() is pure here, so there is no
        // cached output to drop.
        invalidate(): void {},
        render(width: number): string[] {
          const stepStatusText = (s: any): string =>
            s.status === "completed"
              ? s.elapsed != null ? formatElapsed(s.elapsed) : "done"
              : s.status === "failed"
                ? "failed"
                : s.status === "cancelled"
                  ? "cancelled"
                  : s.status === "skipped"
                    ? "skipped"
                    : "pending";

          const contentLines: string[] = [
            `${icon} ${theme.fg("toolTitle", theme.bold(name))} ` +
              theme.fg("accent", `chain ${completedCount}/${steps.length}`) +
              ` ${theme.fg("dim", "—")} ${theme.fg("dim", elapsed)}`,
            ...steps.map((s, i: number) => {
              const sIcon =
                s.status === "completed"
                  ? theme.fg("success", "✓")
                  : s.status === "failed"
                    ? theme.fg("error", "✗")
                    : theme.fg("muted", "○");
              return `${theme.fg("muted", `${i + 1}.`)} ${theme.fg("toolTitle", theme.bold(s.name ?? s.agent))}` +
                theme.fg("dim", ` (${s.agent})`) +
                ` ${sIcon} ${theme.fg("dim", stepStatusText(s))}`;
            }),
          ];

          if (options.expanded) {
            for (const s of steps) {
              if (s.status !== "completed" && s.status !== "failed") continue;
              contentLines.push("");
              contentLines.push(
                theme.fg(
                  "muted",
                  `─── Step ${s.index}: ${s.agent}${s.errorMessage ? ` — ${s.errorMessage}` : ""}`,
                ),
              );
              const out = String(s.output ?? s.summary ?? "").split("\n");
              for (const line of out.slice(0, 30)) {
                contentLines.push(line.slice(0, width - 6));
              }
              if (out.length > 30) {
                contentLines.push(theme.fg("muted", `… ${out.length - 30} more lines`));
              }
              if (s.sessionFile) {
                contentLines.push(theme.fg("muted", `Session file: ${s.sessionFile}`));
              }
            }
            const followUps = steps.filter((s) => s.name).map((s) => `"${s.name}"`);
            if (followUps.length > 0) {
              contentLines.push("");
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "<step name>", message: "…" }) — steps: ${followUps.join(", ")}`,
                ),
              );
            }
          } else {
            // Collapsed: preview of the last step that produced output
            const lastRan = [...steps].reverse().find((s) => s.output || s.summary);
            if (lastRan) {
              const previewLines = String(lastRan.output ?? lastRan.summary ?? "").split("\n").slice(0, 4);
              for (const line of previewLines) {
                contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
              }
            }
            contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
          }

          const box = new Box(1, 1, bgFn);
          box.addChild(new Text(contentLines.join("\n"), 0, 0));
          return ["", ...box.render(width)];
        },
      };
    }

    return {
      invalidate(): void {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            // No ExtensionContext here — use the session_start snapshot for the
            // registry lookup (same ctx-less precedent as listModelRefs). The
            // session entry stores provider next to model, so pass it through:
            // stats.model is a bare id and bare ids can be ambiguous.
            const window = contextWindowFor(stats.model, latestCtx?.modelRegistry, stats.provider);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and the header line). The header is
        // matched by shape rather than by exact wording: it now also carries the
        // agent type and the chain position, and this renderer already composes an
        // equivalent header line of its own from `details` — so the whole first
        // line goes, whatever identifiers it spells out.
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(/^Sub-agent "[^\n]*\n\n/, "");

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate(): void {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate(): void {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
// test
