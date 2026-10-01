# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**my personal fork of a tmux-only fork.** See [Acknowledgements](#acknowledgements) for the upstream projects.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required (single mode) | Which agent to spawn (must be known and permitted) |
| `task` | string | required (single mode) | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …). In chain mode this names the **chain** (its steps get their own names) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |
| `chain` | `{agent, task, name?, model?, cwd?}[]` | — | Run a sequence of subagents one after another instead of a single spawn (see [Chains](#chains)) |

### Chains

Run subagents sequentially — e.g. `worker → reviewer → worker` — with the previous step's output **automatically appended** to the next step's task. The hand-off is driven by the extension, so the previous step's report can never be forgotten: there is no `{previous}` placeholder for the caller to add, and no pasting of prior output into the next task.

```typescript
subagent({
  name: "fix-auth",
  chain: [
    { agent: "worker",   task: "Implement the auth fix" },
    { agent: "reviewer", task: "Review the implementation" },
    { agent: "worker",   task: "Apply the review feedback" },
  ],
});
```

How it works:

- Each step runs in its own pane, tracked by the widget like any other subagent. Steps run **one after another**, in the order given (max 10 steps).
- Step N's final assistant message is appended to step N+1's task under an `## Output from previous step (step N: agent)` heading. An empty output appends nothing.
- Like every other spawn, the tool call is **fire-and-forget**: it returns an acknowledgement immediately, and ONE aggregate result for the whole chain — every step's status and output — is delivered as a steer message when the last step finishes, or when the chain stops early because a step failed. Do not poll; just wait for the steer.
- If a step fails (non-zero exit, provider error, or its pane was closed), the remaining steps are marked `skipped` and the aggregate steer says exactly where the chain stopped and what never ran.
- Steps are addressable by their names (auto-suffixed on collision, e.g. `worker`, `reviewer`, `worker-2`) via `subagent_message`, as usual. A message to the **chain name** is delivered to the chain's currently running step; a message to a finished chain's name gets an error pointing at its steps.
- Per-step `model`, `cwd`, and cosmetic `name` overrides work the same as for single spawns.
- Every step is told where it sits in the chain, so it knows the other steps exist: its system prompt gets a short `## Chain context` block — step N of M, the chain name, its own role, the full sequence (`worker → reviewer → worker`), and the fact that any later steps run automatically and receive its final message, along with the fact that only the final step's final message reaches the orchestrator that started the chain, so each step should carry relevant information from earlier steps forward — and the same facts in its environment as `PI_SUBAGENT_CHAIN_NAME`, `PI_SUBAGENT_CHAIN_STEP` (1-based), `PI_SUBAGENT_CHAIN_STEP_TOTAL`, and `PI_SUBAGENT_CHAIN_SEQUENCE`. This is informational only — a step learns where it sits and what happens next; no spawn restriction of any kind is imposed (the `subagent_agents` / `PI_SUBAGENT_ALLOWED` allowlist is unchanged and remains the only gate). A resumed chain step keeps the position it originally ran with — it is read from the step's `loadout.json` snapshot, never recomputed, and the resumed widget shows the same sanitized position as its block and env vars.

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd, chain position — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The tool call **blocks** until the orchestrator replies (up to 10 minutes): the sub-agent writes a `${sessionFile}.ask` signal, the parent is notified with the sub-agent's name, and the orchestrator replies via `subagent_message({ name, message })` — the parent writes the reply to `${sessionFile}.ask-reply` (as JSON `{ askedAt, text }`, echoed from the `.ask` file so a reply from a different question cycle is rejected), and the sub-agent's call returns it as the **tool result**. The question is answered within the same turn: the session shows as active while waiting, and the sub-agent continues immediately with the answer. If the parent never replies within 10 minutes, the tool returns a no-reply note and the sub-agent decides whether to proceed with its best judgment or stop and summarize. A reply sent *after* the call has already timed out (or the wait was interrupted) is not consumed by the call — it is typed into the sub-agent's pane as a normal steer, picked up on its next turn. Parallel questions are supported — each sub-agent has its own name. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `vllm/qwen3.8-flash-next` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `vllm/qwen3.8-flash-next` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **planner** | `vllm/qwen3.8-flash-next` | `read`, `grep`, `find`, `ls` + spawning | Concrete implementation plans (Goal / Plan / Files to Modify / Risks); may spawn `scout` to gather context |
| **worker** | `vllm/qwen3.8-flash-next` | `read`, `write`, `edit`, `bash` + spawning | General implementer; may spawn `scout`, `planner`, and `reviewer` |
| **reviewer** | `vllm/qwen3.8-flash-next` | `read`, `grep`, `find`, `ls`, `bash` (read-only) | Code review: diff/changed files → structured findings (Critical / Warnings / Suggestions) |

All five are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`). The `reviewer` is the natural middle step of a `worker → reviewer → worker` [chain](#chains), and a `planner` in front of a `worker` (e.g. `[{agent: "planner", …}, {agent: "worker", task: "Execute the plan"}]`) turns a vague brief into a plan, then a verbatim execution.

### Bundled web tools

`web_search` and `web_fetch` ship inside the package (`pi-extension/subagents/tools/`) — no separate install needed; the researcher gets them from its `tools:` list out of the box.

- **`web_search`** — web search via a [SearXNG](https://docs.searxng.org/) JSON API. The instance URL comes from the **`SEARXNG_URL`** env var (default `http://host.docker.internal:8088`, the docker-bridge route to a SearXNG running on the host). SearXNG's JSON format must be enabled in its `settings.yml` (`search.formats: [html, json]`). Returns a numbered title/URL/snippet list; the query supports SearXNG operators (`"exact phrase"`, `OR`, `inurl:`, `intitle:`, `filetype:`). **Rate-limited to one request per 61s** — SearXNG's upstream engines suspend the instance on query bursts, so the tool paces itself. The limit is **cross-process** (a small state file under the system temp dir, keyed by SearXNG URL, serialized with an `O_EXCL` lock), so parallel sub-agents can't burst the engine pool together; a call may wait before running, and waits are reported. Tune with **`WEB_SEARCH_MIN_INTERVAL_S`** (seconds, `0` disables). Because the upstream engines rate-limit aggressively, the tool also surfaces `unresponsive_engines` in the response, so a model can tell "nothing exists" from "engines are down — retry in a minute".
- **`web_fetch`** — fetches a URL and returns readable content as markdown: Readability + Turndown for HTML, unpdf text extraction for PDFs (max 100 pages), plain text passthrough, and Next.js RSC flight-data extraction. **Local-only**: the original implementation's Jina Reader fallback was removed — pages that can't be extracted produce an explanatory error (e.g. "page appears to be JavaScript-rendered") instead of phoning out to an external service. Limits: 5 MB (20 MB PDF), 30 s timeout.

The `web_fetch` tool has its own `package.json` (readability, linkedom, turndown, unpdf) in `tools/web-fetch/` — run `npm ci` there once (the Dockerfile does it at build time). `web_search` has no npm dependencies.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: vllm/qwen3.8-flash-next
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** an in-flight `ask_question` call blocks the turn until the orchestrator replies (or the 10-minute timeout elapses), so the session stays open and shows as active for the duration of the wait — once the reply is consumed (or the timeout handled), the flag is cleared inside the tool and auto-exit resumes for the rest of the turn. The same suppression applies while the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [tmux](https://github.com/tmux/tmux)

```bash
tmux new -A -s pi 'pi'
```

## Acknowledgements

Forker from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents). I've since added sub-agent chains, a reviewer agents, and bundled web search tools. I yoinked the last two from here [amosblomqviest/pi-config](https://github.com/amosblomqvist/pi-config/) and tweaked them to suit my needs. I also made the sub-agents use my local vllm server instead of cloud models and made the sub-agent ask questions tool blocking instead of async.
amosblomqviest/pi-interactive-subagents was forked from from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
