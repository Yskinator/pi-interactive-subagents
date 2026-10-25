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
 * `${sessionFile}.ask` signal the parent's watcher picks up, then waits for
 * the answer on EITHER of two channels and returns whichever arrives first:
 *   1. the file channel: `${sessionFile}.ask-reply`, written by the parent's
 *      subagent_message as JSON `{ askedAt, text }`, the `askedAt` echoed from
 *      the `.ask` file so a reply from a different question cycle is rejected;
 *   2. the fallback input channel: while the call is parked, text submitted
 *      into this child's pane arrives as an `input` event, and the `input`
 *      handler hands it to the waiting call and reports `handled` so pi absorbs
 *      it instead of queueing a duplicate turn. It exists because pi never
 *      delivers steering text into a pending tool call (it polls at the turn
 *      boundary only), so a reply that reaches the pane of a parked child -- a
 *      steer the parent misrouted, or a human typing the answer -- would
 *      otherwise sit in the queue while this call hung until its timeout. Such
 *      a reply belongs to the current cycle by construction, so it needs no
 *      `askedAt` correlation.
 * Either way the call returns the orchestrator's
 * reply as the tool result — the question is answered within the same
 * turn. While the call is waiting, `awaitingAnswer` suppresses auto-exit
 * so the session stays open (shown as active). On abort/timeout/consumption
 * the call unlinks the sidecars itself, so a lingering `.ask` only ever
 * comes from a child that was killed mid-wait — the parent's watcher
 * unlinks the sidecars when the pane dies and again on resume.
 *
 * ONE question per child parks at a time: a second `ask_question` while one is
 * still waiting is refused -- the sidecar pair and the input handle are per
 * session file, so one reply channel cannot serve two parked questions.
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
 *
 * Pass the session's own id when you have one: the shared map is process-global
 * and pi can host several sessions in one process, so an unscoped count would let
 * ANOTHER session's children park this one here forever. An older `index.ts` that
 * ignores the argument just reports the whole map, as before.
 */
export function runningChildrenCount(sessionId?: string | null): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn(sessionId ?? undefined);
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

  /**
   * The `ask_question` call currently parked waiting on the orchestrator, with
   * the resolver that hands it an answer. Set for the duration of the wait and
   * cleared when the wait ends (see the tool's `finally`).
   *
   * This is the second reply channel: the `input` handler resolves it when text
   * is submitted into the pane while a question is pending, instead of letting
   * pi queue that text for a later turn -- a parked tool call never sees a
   * steer, so the `.ask-reply` file is not the only way an answer can arrive.
   *
   * At most one ask may be parked at a time, and that is ENFORCED, not just
   * assumed: the `.ask`/`.ask-reply` sidecar pair and this handle are per
   * session file, so two parked questions would fight over one channel and the
   * first to finish would kill the other's reply path. `ask_question` refuses
   * the second call while this handle is set (see the guard at the top of
   * `execute`). `askedAt` identifies the parked cycle and appears in that
   * refusal, so a model that batched two questions sees which one to wait for.
   */
  let pendingAsk: { askedAt: number; resolve: (text: string) => void } | null = null;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", (event) => {
    recorder.input();
    // Only submitted TEXT can answer a question. The interactive pane trims and
    // rejects empty input, but an rpc- or extension-sourced submission can
    // arrive with no text (or with only attachments); resolving with "" would
    // answer the question with an empty string and silently drop the payload,
    // so such an input falls through and is handled as an ordinary turn.
    const answer = typeof event?.text === "string" ? event.text : "";
    const ask = pendingAsk;
    if (ask && answer) {
      // A question is parked: this submitted text IS its answer. Hand it to the
      // waiting call and report `handled`, so pi absorbs the input instead of
      // ALSO queueing a turn that the call can no longer return. The tool owns
      // the rest of the cleanup (`awaitingAnswer`, the activity marker, the
      // sidecars) because it consumes the answer through the same path as a
      // file reply. Clearing `pendingAsk` here (rather than only in the tool's
      // `finally`) means a second input right behind this one is queued as a
      // normal turn instead of being absorbed by an already-answered ask.
      //
      // Two consequences of the short-circuit, both accepted:
      //  - pi stops emitting `input` once a handler reports `handled`, so a
      //    sibling `input` handler does not run for absorbed text and cannot do
      //    its own bookkeeping for it (e.g. prompt-snippets clearing toggles it
      //    armed for a submission that never became a turn). Inherent to pi's
      //    routing, not something this extension can fix.
      //  - `userTookOver` is deliberately NOT set: answering the child's own
      //    question is not a human taking the session over. (Moot today --
      //    `shouldAutoExitOnAgentEnd` does not read the flag -- but do not
      //    "restore" it here without meaning it.)
      pendingAsk = null;
      ask.resolve(answer);
      return { action: "handled" as const };
    }
    // No ask is pending, so this is an ordinary steer/fresh turn: keep the
    // previous behaviour. Clear the defensive flag here, not only on
    // agent_start, because a message steered in *mid-run* is absorbed into the
    // current run (pi's `steer` behavior injects it before the next LLM call):
    // no new agent_start fires, so without this the flag would stay set and
    // agent_end would park the session as `waiting` even though nothing is
    // waiting anymore. (The `input` event fires for mid-run steers because
    // prompt() emits it before queueing.)
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
    //  - runningChildrenCount(id): this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    // In both cases the session parks as `waiting` and resumes when the next
    // turn lands. The id scopes the count to THIS session — one process can host
    // several, and a stranger's children must not park this one forever.
    const hasPendingChildren = runningChildrenCount(ctx?.sessionManager?.getSessionId?.()) > 0;
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

      // pi runs the tool calls of one assistant message in parallel, so nothing
      // else stops a second ask_question in the same batch: both would drive the
      // one `.ask`/`.ask-reply` pair and the one `pendingAsk` handle, and the
      // first to finish would tear down the other's reply channels -- two
      // parked questions and no answer for either. Refuse the second call
      // loudly instead of silently parking it. Checked BEFORE any sidecar is
      // touched, so a refused call cannot delete the parked call's incoming
      // reply. `pendingAsk` is the exact "a call is parked right now" signal:
      // unlike `awaitingAnswer` it is cleared on every exit, including the abort
      // path, whose deliberate park must not block a re-ask after an
      // interrupted wait.
      if (pendingAsk) {
        throw new Error(
          "ask_question is already waiting for an answer in this session " +
            `(asked ${Math.max(0, Date.now() - pendingAsk.askedAt)}ms ago). ` +
            "Ask one question at a time: wait for that reply, then ask again.",
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
      // subagent_message. The answer then reaches this call on one of two
      // channels: the parent writes `${sessionFile}.ask-reply` as JSON
      // `{ askedAt, text }`, echoing our `askedAt` so this call can reject a
      // reply that belongs to a different question cycle; or the reply was
      // typed into this pane, and the extension's `input` handler resolves the
      // `pendingAsk` handle below. Either way the reply is consumed as this
      // call's result.
      //
      // Setting the park up can fail (the `.ask` write, the activity write) and
      // it happens BEFORE the wait loop's `finally` is entered, so it needs its
      // own guard: a throw here would otherwise leak BOTH markers --
      // `awaitingAnswer` would suppress auto-exit forever, and a written
      // `askPending` would keep the parent routing replies into a sidecar no
      // body reads. Everything between this guard and the loop's `try` is
      // declarations that cannot throw.
      awaitingAnswer = true;
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
      try {
        writeFileSync(askFile, JSON.stringify(askData));
        // Park the activity as `waiting` WITH the authoritative ask marker set
        // for THIS cycle (same `askedAt` as the `.ask` sidecar). The parent
        // routes its replies off `askPending`: `latestEvent` alone is
        // unreliable, because a sibling tool in the same parallel batch
        // overwrites it while this call is still parked, and then the parent
        // types the reply into the pane instead of writing the sidecar -- where
        // nothing can hand it to a parked call.
        recorder.askQuestion(askData.askedAt);
      } catch (err) {
        // Nothing is waiting, so undo the park exactly as a consumed ask would.
        // `askAnswered` is idempotent (a no-op when the marker was never
        // written), and the `.ask` we may have failed to (re)write is left to
        // the parent's watcher and the next question's cleanup.
        awaitingAnswer = false;
        recorder.askAnswered();
        throw err;
      }
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
        // The question was answered WITHIN this turn, on either channel: clean
        // up both sidecars, drop the authoritative ask marker (else the parent
        // keeps routing steers into the sidecar), and clear the flag. No new
        // turn fires for the reply, so without the clear `agent_end` would park
        // the session as `waiting` even though the answer already arrived and
        // was consumed here.
        recorder.askAnswered();
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

      // Block until a reply arrives (file channel or input channel), the call
      // is aborted, or the timeout elapses. Every pass checks the reply file
      // FIRST, so a reply that races a Ctrl-C still wins.
      const pollMs = __test__.askQuestion.pollMs;
      const timeoutMs = __test__.askQuestion.timeoutMs;
      const startedAt = Date.now();

      // The input channel. `pendingAsk` (set to this call's `mine` handle just
      // before the loop) is what this extension's `input` handler answers: it
      // resolves with the submitted text and wakes the sleep below, so a reply
      // that reached the pane instead of the sidecar still becomes this call's
      // result rather than sitting in pi's steer queue -- a parked tool call is
      // never handed a steer, because pi polls for steering only at the turn
      // boundary, once the whole tool batch has finished.
      let inputReply: string | null = null;
      let wake: (() => void) | null = null;
      // This call's handle. Owned by the `finally`: it clears the global only
      // while it still points at THIS call's handle (see below).
      let mine: { askedAt: number; resolve: (text: string) => void } | null = null;
      // The one exit that deliberately keeps `awaitingAnswer` set.
      let aborted = false;
      /** Sleep that a reply or an abort can cut short (else both cost a poll). */
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, ms);
          wake = () => {
            wake = null;
            clearTimeout(timer);
            resolve();
          };
        });
      const wakeEarly = () => wake?.();
      // Only there so an abort is noticed between polls; the loop still prefers
      // a reply that landed in the same instant. Detached in the `finally`.
      signal?.addEventListener("abort", wakeEarly, { once: true });
      mine = {
        askedAt: myAskedAt,
        resolve: (text) => {
          inputReply = text;
          wakeEarly();
        },
      };
      pendingAsk = mine;
      try {
        for (;;) {
          // Reply FIRST, then abort: a reply that landed just before the
          // Ctrl-C is preserved instead of being discarded.
          const reply = readReply();
          // Both channels can answer in the same pass. Returning only one would
          // destroy the other: the typed text was already absorbed (`handled`),
          // so pi will not queue it for a later turn either, and `consumeReply`
          // unlinks the sidecar the parent wrote. Return both.
          if (reply.kind === "reply" && inputReply !== null) {
            return consumeReply(`${reply.text}\n\n(Also typed into this pane: ${inputReply})`);
          }
          if (reply.kind === "reply") return consumeReply(reply.text);
          // The input channel: text submitted into this pane while the call was
          // parked. It answers THIS cycle by construction (the handler only
          // resolves the ask this call is waiting on), so unlike a file reply it
          // needs no `askedAt` correlation.
          if (inputReply !== null) return consumeReply(inputReply);

          if (signal?.aborted) {
            // The one exit that keeps the park (see the `finally`).
            aborted = true;
            // Catch a reply that landed in the same tick as the abort so the
            // orchestrator's answer is preserved in the error instead of
            // being silently dropped.
            const lastReply = readReply();
            const suffix =
              lastReply.kind === "reply" ? ` A reply had just arrived: ${lastReply.text}` : "";
            // The wait is over: clear the marker the parent routes replies off,
            // exactly as consumption does, so its next steer is typed into the
            // pane instead of landing in a sidecar nobody will read.
            recorder.askAnswered();
            // Unlink `.ask` BEFORE throwing: we are no longer waiting, so the
            // file no longer represents a pending question. Left in place it
            // would misroute the orchestrator's next subagent_message --
            // naturally the reply to this very question -- into the
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
            recorder.askAnswered();
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

          await sleep(pollMs);
        }
      } finally {
        // However the wait ended (reply, abort, timeout, or a throw on the way
        // out), this call no longer owns the pending ask: the `input` handler
        // must stop absorbing submitted text as answers, and the abort listener
        // must not outlive the call. The clear is CONDITIONAL on still owning the
        // handle: pi runs tool calls of one assistant message in parallel, so an
        // unconditional `pendingAsk = null` here could wipe a handle belonging
        // to another parked call and silently kill its input channel.
        if (mine && pendingAsk === mine) pendingAsk = null;
        signal?.removeEventListener("abort", wakeEarly);
        // Backstop for an exit path that left the markers set (a throw from
        // `readReply`/`consumeReply`, say): a call that is no longer waiting
        // must not keep the parent writing replies into a sidecar nobody reads,
        // nor keep auto-exit suppressed. Both are idempotent no-ops on the
        // normal paths, which already clean up. The abort path is the one
        // deliberate exception for the FLAG: the session stays parked after an
        // interrupted wait so the orchestrator's late reply is still picked up
        // as a fresh turn instead of the session exiting under it (the marker
        // itself IS cleared there, which is what stops sidecar routing).
        recorder.askAnswered();
        if (!aborted) awaitingAnswer = false;
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
