/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically when their agent loop ends (see the `agent_end` handler);
 * interactive agents end when the human exits the pane.
 *
 * `ask_question` BLOCKS until the orchestrator replies: it writes a
 * `${sessionFile}.ask` signal the parent's watcher picks up, then polls
 * `${sessionFile}.ask-reply` (written by the parent's subagent_message as
 * JSON `{ askedAt, text }`, echoed from the `.ask` file so a reply from a
 * different question cycle is rejected) and returns the orchestrator's
 * reply as the tool result — the question is answered within the same
 * turn. While the call is waiting, `awaitingAnswer` suppresses auto-exit
 * so the session stays open (shown as active). On abort/timeout/consumption
 * the call unlinks the sidecars itself, so a lingering `.ask` only ever
 * comes from a child that was killed mid-wait — the parent's watcher
 * unlinks the sidecars when the pane dies and again on resume.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";

/**
 * Test hooks for the blocking `ask_question` wait loop. `pollMs` is how often
 * the reply file is checked; `timeoutMs` caps how long the call blocks. Tests
 * override both to stay fast; production defaults are 500 ms / 10 minutes.
 */
export const __test__ = {
  askQuestion: {
    pollMs: 500,
    timeoutMs: 10 * 60 * 1000,
  },
};

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_end` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  // Set while ask_question is blocked waiting for the orchestrator's reply;
  // suppresses auto-exit so the session stays open for the duration of the
  // wait. Cleared INSIDE the tool once the reply (or the timeout) is handled —
  // the answer is consumed within the same turn, so without that clear
  // `agent_end` would wrongly park the session as `waiting`. The `input` /
  // `agent_start` clears below remain as a defensive backstop for input that
  // arrives as a fresh turn.
  let awaitingAnswer = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and agent_end would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingAnswer = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    // A new turn is starting — any pending ask_question has now been answered
    // (or superseded), so let auto-exit resume normally when this turn ends.
    awaitingAnswer = false;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    // Never shut down while this session still has work in flight:
    //  - awaitingAnswer: an ask_question is pending the orchestrator's reply.
    //  - runningChildrenCount(): this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    // In both cases the session parks as `waiting` and resumes when the next
    // turn lands.
    const hasPendingChildren = runningChildrenCount() > 0;
    const shouldExit =
      !awaitingAnswer &&
      !hasPendingChildren &&
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify({
              type: "error",
              errorMessage: errorInfo.errorMessage,
              stopReason: errorInfo.stopReason,
            }),
          );
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) a single question. " +
      "This call BLOCKS until the orchestrator replies — the reply is returned as THIS tool's result (up to 10 minutes). " +
      "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
      "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
      "If the call times out, the result says so and you decide whether to proceed with your best judgment or stop and summarize. " +
      "Ask exactly one question per call; make separate calls for unrelated questions. " +
      "Do NOT call ask_question again before the current call's result arrives.",
    promptSnippet:
      "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "The call blocks until the orchestrator replies — the reply arrives as this tool's result, so continue working with it as soon as the call returns.",
      "Do not call ask_question again before the current call's result arrives.",
      "If the call times out and the orchestrator replies later, that late reply arrives as a NEW message (a fresh turn), not as this call's result.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      const askFile = `${sessionFile}.ask`;
      const replyFile = `${sessionFile}.ask-reply`;

      // Drop a stale reply from a previous question cycle so an old answer is
      // never returned as the reply to THIS question.
      try {
        unlinkSync(replyFile);
      } catch {}

      // Keep the session open: suppress auto-exit while we wait for the
      // orchestrator's reply. The parent's watcher picks up the `.ask`
      // signal and notifies the orchestrator, who replies via
      // subagent_message — the parent then writes `${sessionFile}.ask-reply`
      // as JSON `{ askedAt, text }`, echoing our `askedAt` so this call can
      // reject a reply that belongs to a different question cycle. The
      // reply is consumed as this call's result.
      awaitingAnswer = true;
      recorder.askQuestion();
      const askData = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
        // Unique per question cycle; the parent's watcher dedupes its
        // notification on this key (the .ask file may linger when the child
        // is killed mid-wait, and a re-ask must still notify). The parent
        // also echoes this value into the reply file for correlation.
        askedAt: Date.now(),
      };
      writeFileSync(askFile, JSON.stringify(askData));
      const myAskedAt = askData.askedAt;

      /**
       * Read the reply sidecar. The parent writes the reply as JSON
       * `{ askedAt, text }`, echoing the `askedAt` it read from our `.ask`
       * file. A reply carrying a different `askedAt` belongs to a different
       * question cycle (a stale `.ask` outlived the child that wrote it) —
       * drop it and keep waiting. Plain-text replies (legacy/tests) are
       * accepted as-is.
       */
      const readReply = ():
        | { kind: "reply"; text: string }
        | { kind: "stale" }
        | { kind: "none" } => {
        let raw: string;
        try {
          raw = readFileSync(replyFile, "utf8");
        } catch {
          return { kind: "none" };
        }
        let parsed: any = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "text" in parsed) {
          if (parsed.askedAt !== undefined) {
            if (parsed.askedAt === myAskedAt) {
              return { kind: "reply", text: typeof parsed.text === "string" ? parsed.text : raw };
            }
            // A reply for a different question cycle — drop it so it can't
            // be consumed by mistake (it also can't linger into our next
            // question: this call owns the file until it exits).
            try {
              unlinkSync(replyFile);
            } catch {}
            return { kind: "stale" };
          }
        }
        return { kind: "reply", text: raw };
      };

      const consumeReply = (text: string) => {
        // The question was answered WITHIN this turn: clean up both
        // sidecars and clear the flag. No new turn fires for the reply,
        // so without the clear `agent_end` would park the session as
        // `waiting` even though the answer already arrived and was
        // consumed here.
        try {
          unlinkSync(replyFile);
        } catch {}
        try {
          unlinkSync(askFile);
        } catch {}
        awaitingAnswer = false;
        return {
          content: [{ type: "text", text }],
          details: { question: params.question, replied: true },
        };
      };

      // Block until the reply file appears, the call is aborted, or the
      // timeout elapses.
      const pollMs = __test__.askQuestion.pollMs;
      const timeoutMs = __test__.askQuestion.timeoutMs;
      const startedAt = Date.now();
      for (;;) {
        // Reply FIRST, then abort: a reply that landed just before the
        // Ctrl-C is preserved instead of being discarded.
        const reply = readReply();
        if (reply.kind === "reply") return consumeReply(reply.text);

        if (signal?.aborted) {
          // Catch a reply that landed in the same tick as the abort so the
          // orchestrator's answer is preserved in the error instead of
          // being silently dropped.
          const lastReply = readReply();
          const suffix =
            lastReply.kind === "reply" ? ` A reply had just arrived: ${lastReply.text}` : "";
          // Unlink `.ask` BEFORE throwing: we are no longer waiting, so the
          // file no longer represents a pending question. Left in place it
          // would misroute the orchestrator's next subagent_message —
          // naturally the reply to this very question — into the
          // `.ask-reply` sidecar, where it is silently swallowed. The
          // `awaitingAnswer` backstop and the parent's `lastNotifiedAsk`
          // dedupe make the cleanup safe; steers then fall back to typing
          // into the pane (a fresh turn).
          try {
            unlinkSync(askFile);
          } catch {}
          try {
            unlinkSync(replyFile);
          } catch {}
          throw new Error(`Interrupted while waiting for the orchestrator reply${suffix}`);
        }

        if (Date.now() - startedAt >= timeoutMs) {
          // ONE FINAL read before giving up: a reply that landed after the
          // last poll's read but before this check must be consumed here,
          // not orphaned (it would otherwise be silently lost and purged
          // as a stale reply by the next question cycle).
          const lastReply = readReply();
          if (lastReply.kind === "reply") return consumeReply(lastReply.text);
          try {
            unlinkSync(askFile);
          } catch {}
          awaitingAnswer = false;
          const minutes = Math.max(1, Math.round(timeoutMs / 60000));
          return {
            content: [
              {
                type: "text",
                text:
                  `No reply from the orchestrator within ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
                  "Proceed with your best judgment, or stop and summarize where you are.",
              },
            ],
            details: { question: params.question, replied: false },
          };
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

}
