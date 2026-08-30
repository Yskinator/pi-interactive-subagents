/**
 * /agent_model slash command: change the model a named sub-agent uses for the
 * rest of the session (in-memory, like pi's /model — not persisted).
 *
 * Ported from the old pi-extensions/subagent implementation. The picker and
 * two-stage flow (agent picker → model picker) replicate the old UX.
 *
 * The command module is deliberately decoupled from index.ts through the
 * `AgentModelCommandDeps` hooks so it stays testable without a live pi
 * session.
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

// ── Searchable picker (agent / model selection) ─────────────────────────────

interface PickerItem {
  value: string;
  label: string;
  hint?: string;
}

/** Structural subset of pi-ai's Model that this module needs. */
interface ModelLike {
  provider: string;
  id: string;
}

/**
 * Simple searchable list picker with the same interaction model as the
 * built-in /model selector: type to filter, ↑/↓ to move, enter to select,
 * escape to cancel.
 */
class SearchablePickerComponent implements Component, Focusable {
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
  }

  private title: string;
  private items: PickerItem[];
  private theme: Theme;
  private done: (value: string | undefined) => void;
  private searchMode = false;
  private searchText = "";
  private selectedIndex = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    title: string,
    items: PickerItem[],
    theme: Theme,
    done: (value: string | undefined) => void,
    initialIndex = 0,
  ) {
    this.title = title;
    this.items = items;
    this.theme = theme;
    this.done = done;
    this.selectedIndex = Math.max(0, Math.min(initialIndex, items.length - 1));
  }

  private get filteredItems(): PickerItem[] {
    const q = this.searchText.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        (it.hint ?? "").toLowerCase().includes(q),
    );
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold(this.title)));
    lines.push("");

    if (this.searchMode) {
      const cursor = this.searchText.length > 0 ? "\x1b[7m " : "\x1b[7m_";
      lines.push(this.theme.fg("muted", "Search: ") + this.searchText + cursor + "\x1b[27m");
      lines.push("");
    }

    const filtered = this.filteredItems;
    const maxVisible = width > 80 ? 15 : 10;
    // Slide the window so the selection stays visible (lists longer than
    // maxVisible — e.g. the full model registry — scroll with ↑/↓).
    const start = Math.min(
      Math.max(0, this.selectedIndex - maxVisible + 1),
      Math.max(0, filtered.length - maxVisible),
    );
    const visible = filtered.slice(start, start + maxVisible);
    const hiddenCount = filtered.length - visible.length;
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const isSelected = i + start === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "> ") : "  ";
      let text = prefix + this.theme.fg("accent", item.label);
      if (item.hint) text += " " + this.theme.fg("dim", `(${item.hint})`);
      lines.push(truncateToWidth(text, width));
    }
    if (hiddenCount > 0) {
      lines.push(this.theme.fg("dim", `... ${hiddenCount} more`));
    }

    lines.push("");
    lines.push(this.theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc cancel"));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this.searchMode) {
      if (matchesKey(data, Key.escape)) {
        this.searchMode = false;
        this.searchText = "";
        this.selectedIndex = 0;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.searchText = this.searchText.slice(0, -1);
        this.selectedIndex = 0;
      } else if (matchesKey(data, Key.enter)) {
        this.select();
        return;
      } else if (data.length === 1 && data >= " " && data <= "~") {
        this.searchText += data;
        this.selectedIndex = 0;
      }
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.up)) {
      const filtered = this.filteredItems;
      if (filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? filtered.length - 1 : this.selectedIndex - 1;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      const filtered = this.filteredItems;
      if (filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.select();
      return;
    }
    // Any printable character starts a search
    if (data.length === 1 && data >= " " && data <= "~") {
      this.searchMode = true;
      this.searchText = data;
      this.selectedIndex = 0;
      this.invalidate();
    }
  }

  private select(): void {
    const filtered = this.filteredItems;
    const item = filtered[this.selectedIndex];
    if (item) {
      this.done(item.value);
    }
  }
}

// ── Model helpers ────────────────────────────────────────────────────────────

function sortModels(models: readonly ModelLike[]): ModelLike[] {
  return [...models].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
}

/** Resolve a user-supplied model ref against the available models. */
function findModel(models: readonly ModelLike[], ref: string): ModelLike | undefined {
  const exact = models.find((m) => `${m.provider}/${m.id}` === ref);
  if (exact) return exact;
  const byId = models.filter((m) => m.id === ref);
  return byId.length === 1 ? byId[0] : undefined;
}

/**
 * Qualify a model ref to "provider/id" against the available models so the
 * picker's preselect matches a picker item. Already-qualified refs
 * ("provider/id") pass through unchanged; bare ids resolve when exactly one
 * available model matches, otherwise the ref is returned as-is.
 */
function qualifyModelRef(models: readonly ModelLike[], modelRef: string): string {
  if (modelRef.includes("/")) return modelRef;
  const resolved = findModel(models, modelRef);
  return resolved ? `${resolved.provider}/${resolved.id}` : modelRef;
}

// ── Command registration ─────────────────────────────────────────────────────

export interface AgentProfile {
  name: string;
  /** Agent-file default model, or undefined when the file sets none. */
  model?: string;
}

/**
 * Hooks into index.ts the command needs. `sessionId` is always the calling
 * session's id (ctx.sessionManager.getSessionId()); overrides are per-session
 * in index.ts and fall back to the spawner-inherited snapshot.
 */
export interface AgentModelCommandDeps {
  /** Discovered agent profiles (already filtered by the spawn allowlist). */
  listAgents: () => AgentProfile[];
  /** Current effective override for an agent (per-session, then inherited). */
  getOverride: (sessionId: string | undefined, agentName: string | undefined) => string | undefined;
  /** This session's own (explicitly set) override, without the inherited fallback. */
  getSessionOverride: (sessionId: string | undefined, agentName: string | undefined) => string | undefined;
  /** Set, or clear with "default", this session's override for an agent. */
  setOverride: (sessionId: string | undefined, agentName: string, modelRef: string) => void;
  /** Qualified model refs for argument completion, or undefined. */
  listModelRefs?: () => string[] | undefined;
}

/** Apply a model selection: validate against the registry, store qualified. */
function applyModelOverride(
  ctx: ExtensionCommandContext,
  deps: AgentModelCommandDeps,
  sessionId: string | undefined,
  agent: AgentProfile,
  modelRef: string,
): void {
  if (modelRef === "default" || modelRef === "reset") {
    deps.setOverride(sessionId, agent.name, "default");
    // Clearing the per-session entry may still leave the spawner-inherited
    // snapshot in effect for this agent — report what will actually happen.
    const fallback = deps.getOverride(sessionId, agent.name);
    ctx.ui.notify(
      fallback
        ? `${agent.name} will use ${fallback} (inherited from spawner).`
        : `${agent.name} will use its default model (${agent.model || "none"}).`,
      "info",
    );
    return;
  }

  const resolved = findModel(ctx.modelRegistry.getAvailable(), modelRef);
  if (!resolved) {
    ctx.ui.notify(`Unknown model "${modelRef}".`, "error");
    return;
  }

  const ref = `${resolved.provider}/${resolved.id}`;
  deps.setOverride(sessionId, agent.name, ref);
  ctx.ui.notify(`${agent.name} will use ${ref} for the rest of this session.`, "info");
}

export function registerAgentModelCommand(
  pi: ExtensionAPI,
  deps: AgentModelCommandDeps,
): void {
  pi.registerCommand("agent_model", {
    description:
      "Set the model a sub-agent uses for the rest of the session",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trimStart().split(/\s+/).filter(Boolean);
      if (parts.length === 0 || (parts.length === 1 && !prefix.includes(" "))) {
        // First argument: agent names
        const items = deps
          .listAgents()
          .map((a) => ({ value: a.name, label: a.name }))
          .filter((it) => it.value.startsWith(parts[0] ?? ""));
        if (items.length > 0) return items;
      }
      if (parts.length === 2 && prefix.includes(" ")) {
        // Second argument: qualified model refs
        const refs = deps.listModelRefs?.() ?? [];
        const items = refs
          .map((m) => ({ value: m, label: m }))
          .filter((it) => it.value.startsWith(parts[1] ?? ""));
        if (items.length > 0) return items;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const agentName = parts[0];
      const modelArg = parts.slice(1).join(" ");

      const agents = deps.listAgents();
      const agent = agentName ? agents.find((a) => a.name === agentName) : undefined;

      if (agentName && !agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        ctx.ui.notify(`Unknown agent "${agentName}". Available agents: ${available}.`, "error");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();

      // Full form: /agent_model <agent> <model> — works in any mode.
      if (agent && modelArg) {
        applyModelOverride(ctx, deps, sessionId, agent, modelArg);
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          agent
            ? "agent_model requires TUI mode to pick a model. Usage: /agent_model <agent> <model>"
            : "agent_model requires TUI mode to pick an agent. Usage: /agent_model <agent> <model>",
          "warning",
        );
        return;
      }

      // Stage 1: pick the agent if not given.
      let target = agent;
      if (!target) {
        const items: PickerItem[] = agents.map((a) => {
          const override = deps.getOverride(sessionId, a.name);
          const sessionOverride = override
            ? deps.getSessionOverride(sessionId, a.name)
            : undefined;
          return {
            value: a.name,
            label: a.name,
            hint: override
              ? `model: ${override} (${
                  sessionOverride ? "session override" : "inherited from spawner"
                })`
              : `model: ${a.model || "(none)"} (default)`,
          };
        });
        if (items.length === 0) {
          ctx.ui.notify("No subagents found.", "info");
          return;
        }
        const picked = await ctx.ui.custom<string | undefined>(
          (_tui, theme, _kb, done) =>
            new SearchablePickerComponent("Select subagent", items, theme, done),
        );
        if (!picked) return;
        target = agents.find((a) => a.name === picked);
        if (!target) return;
      }

      // Stage 2: pick the model.
      const models = ctx.modelRegistry.getAvailable();
      if (models.length === 0) {
        ctx.ui.notify("No models available.", "warning");
        return;
      }
      const modelItems: PickerItem[] = sortModels(models).map((m) => ({
        value: `${m.provider}/${m.id}`,
        label: m.id,
        hint: m.provider,
      }));
      const items: PickerItem[] = [
        {
          value: "default",
          label: "default",
          hint: `use ${target.model || "(none)"} from ${target.name}`,
        },
        ...modelItems,
      ];
      // Preselect the current effective model (override, else agent default).
      const currentRef =
        deps.getOverride(sessionId, target.name) ??
        (target.model ? qualifyModelRef(models, target.model) : undefined);
      const currentIndex = currentRef
        ? modelItems.findIndex((it) => it.value === currentRef)
        : -1;
      const picked = await ctx.ui.custom<string | undefined>(
        (_tui, theme, _kb, done) =>
          new SearchablePickerComponent(
            `Select model for ${target.name}`,
            items,
            theme,
            done,
            // +1 because "default" is at index 0
            currentIndex >= 0 ? currentIndex + 1 : 0,
          ),
      );
      if (!picked) return;
      applyModelOverride(ctx, deps, sessionId, target, picked);
    },
  });
}
