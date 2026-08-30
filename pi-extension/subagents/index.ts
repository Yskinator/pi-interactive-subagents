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
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
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
        "Optional cosmetic label for the subagent's pane and widget row. Defaults to the agent name. " +
        "Has no effect on which agent runs — use `agent` for that. In chain mode this names the chain " +
        "(its steps get their own names).",
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
              "Optional cosmetic label for this step's pane. Defaults to the agent name (auto-suffixed on collision).",
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

/**
 * Known context-window sizes by model id substring, used for the context-usage
 * gauge. Unknown models fall back to a window-less "Nk ctx" label.
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
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

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  >,
  name: string,
): string {
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it.
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
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
  surface: string;
  startTime: number;
  sessionFile: string;
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

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

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
) => Promise<ChainStepRunResult>;

/**
 * Per-step runner for chains: launch a pane, register the name, watch until
 * the step exits. Isolated behind a hook so unit tests can replace it
 * (spawning real tmux panes is integration-test territory).
 */
const chainHooks: { runStep: ChainStepRunner } = {
  runStep: async (step, ctx, parentArtifactDir, _pi, signal, { onLaunched, onSurfaceLost }) => {
    const running = await launchSubagent(
      {
        agent: step.agent,
        task: step.task,
        name: step.name,
        ...(step.model ? { model: step.model } : {}),
        ...(step.cwd ? { cwd: step.cwd } : {}),
      },
      ctx,
    );
    onLaunched(running);
    registerName(parentArtifactDir, running.name, {
      sessionFile: running.sessionFile,
      sessionId: getSessionId(running.sessionFile),
    });
    const result = await watchSubagent(running, signal, {
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

  for (const step of chain.steps) {
    if (chain.aborted || chain.abortController.signal.aborted) {
      step.status = "skipped";
      continue;
    }

    step.status = "running";
    chain.currentStep = step.index;

    // Default the step's name to the agent name, uniquified against running
    // subagents, in-flight reservations, and the session's persistent
    // registry (earlier chain steps live there). Reserve it synchronously
    // (before any await) so parallel spawns can't collide.
    if (!step.name) {
      const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
      step.name = uniqueRunningName(step.agent, registryNames);
      reservedNames.add(step.name);
    }

    try {
      const taskForStep = buildChainStepTask(step.task, previous);
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
          },
          onSurfaceLost: () => {
            chain.surfaceLost = true;
            chain.abortController.abort();
          },
        },
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
      if (step.name) reservedNames.delete(step.name);
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
  const sessionChains = getChainMapForSession(ctx.sessionManager.getSessionId());
  const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
  const baseName = params.name?.trim() || uniqueRunningName("chain", registryNames);
  let chainName = baseName;
  let suffix = 2;
  while (sessionChains.has(chainName)) chainName = `${baseName}-${suffix++}`;

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

  startWidgetRefresh();
  startStatusRefresh(pi);

  // Fire-and-forget: the chain drives itself and reports via a steer message.
  runChain(chain, ctx, parentArtifactDir, pi).catch((err) => {
    // runChain handles step failures internally; this is a last resort.
    if (!chain.finished) {
      chain.finished = true;
      chain.finishedAt = Date.now();
    }
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

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
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
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag} `;
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
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR) and cwd are the caller's
 * responsibility since they differ slightly between launch and resume.
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
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

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

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
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 */
const reservedNames = new Set<string>();

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function resolveRunningByName(name: string):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = Array.from(runningSubagents.values()).map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
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
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "");
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
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
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
  deliverPendingQuestion,
  uniqueRunningName,
  reservedNames,
  steerSubagent,
  handleSubagentSteer,
  deliverSubagentSteer,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  runningSubagents,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
  // Chain internals (unit-test hooks)
  buildChainStepTask,
  chainHooks,
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
  options?: { surface?: string },
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
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    const sp = agentDefs.body;
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
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Apply model, identity, and the default-deny tool/extension restriction via
  // the shared helper (same code path resume uses — they can't drift).
  applySandboxToParts(parts, loadout, { artifactDir, name: params.name });

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
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
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
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
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
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
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
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
    // Chains belong to this session's process too — abort any that are still
    // running so their watchers stop (the aggregate steer, if it can still be
    // delivered, reports the cancellation).
    for (const sessionChains of chainsBySession.values()) {
      for (const chain of sessionChains.values()) {
        if (!chain.finished) {
          chain.aborted = true;
          chain.abortController.abort();
        }
      }
    }
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
        "To reach the currently running step, use subagent_message with the chain name or the step's own name.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready. " +
        "Chains: pass chain: [{agent, task}, ...] instead of agent+task to run subagents one after another — " +
        "each step's final output is automatically appended to the next step's task (no {previous} placeholder needed). " +
        "The aggregate chain result arrives as a steer message when the chain finishes.",
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
        let reservedName: string | null = null;
        if (!params.name?.trim()) {
          const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
          params.name = uniqueRunningName(params.agent, registryNames);
          reservedName = params.name;
          reservedNames.add(reservedName);
        }

        // Launch the subagent (creates pane, sends command). Release the name
        // reservation once it registers in runningSubagents (or launch fails) —
        // from then on uniqueRunningName tracks it via the running map.
        let running;
        try {
          running = await launchSubagent(params, ctx);
        } finally {
          if (reservedName) reservedNames.delete(reservedName);
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

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget(); // reflect removal from Map immediately

            const presentation = resolveResultPresentation(result, running.name);

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
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
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
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
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
        "`name` and `message` are both required. " +
        "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
        "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
        "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
        "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
      promptSnippet:
        "Message a subagent by name: steers it if running, resumes it if finished (same name either way). " +
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
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
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
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
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
        // A name that matches a currently-running subagent always steers it.
        const runningMatch = Array.from(runningSubagents.values()).find((r) => r.name === requestedName);
        if (runningMatch) {
          return handleSubagentSteer({ name: requestedName, message: params.message });
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
          const steer = handleSubagentSteer({ name: current.name, message: params.message });
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
            return handleSubagentSteer({ name: r.name, message: params.message });
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
        applySandboxToParts(parts, loadout, { artifactDir, name });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${name
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, message, "utf8");
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
          surface,
          startTime,
          sessionFile: sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
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
              name,
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: message,
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
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
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
            const window = contextWindowFor(stats.model);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

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
