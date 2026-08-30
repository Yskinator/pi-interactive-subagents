/**
 * web_search extension for subagents — web search via a SearXNG instance.
 *
 * Output shape mirrors Amos Blomqvist's `pi-config` web_search tool
 * (MIT licensed, originally Google Custom Search API): a numbered
 * title / URL / snippet list that is cheap for an LLM to read.
 *
 * Backend: the SearXNG JSON API. The instance URL comes from the
 * SEARXNG_URL environment variable (default: http://host.docker.local:8088,
 * the docker-bridge route to a searxng running on the host). JSON output
 * must be enabled in SearXNG's settings.yml (search.formats: [html, json]).
 *
 * SearXNG aggregates multiple upstream engines (google, brave, bing, …).
 * Those upstreams rate-limit aggressively: after a burst of queries SearXNG
 * reports suspended engines via `unresponsive_engines` and result quality
 * degrades. This tool surfaces that state in the response so the model can
 * tell "nothing exists" from "engines are down — retry in a minute".
 *
 * Loaded into a child pi process via `--extension` when an agent's `tools`
 * frontmatter lists `web_search`. See CUSTOM_TOOL_EXTENSIONS in ../index.ts.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import {
	openSync,
	writeSync,
	closeSync,
	unlinkSync,
	statSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_SEARXNG_URL = "http://host.docker.internal:8088";
const SEARCH_TIMEOUT_MS = 20000;
const MAX_RESULTS = 10; // SearXNG caps `q` results per page around 30; keep it small
const DEFAULT_COUNT = 5;

function getSearxngUrl(): string {
	return (process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL).replace(/\/+$/, "");
}

// ── Types ────────────────────────────────────────────────────────────

export interface SearxngResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearxngSearchData {
	query: string;
	results: SearxngResult[];
	answers: string[];
	unresponsiveEngines: string[];
}

// ── Search ───────────────────────────────────────────────────────────

/**
 * Run one search against the SearXNG JSON API.
 * `fetchImpl` is injectable for unit tests; `baseUrl` overrides SEARXNG_URL.
 */
export async function searchSearxng(
	query: string,
	count: number,
	opts: {
		fetchImpl?: typeof fetch;
		baseUrl?: string;
		signal?: AbortSignal;
	} = {},
): Promise<SearxngSearchData> {
	const doFetch = opts.fetchImpl ?? fetch;
	const base = (opts.baseUrl ?? getSearxngUrl()).replace(/\/+$/, "");
	const url = new URL("/search", base);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");

	let res: Response;
	try {
		res = await doFetch(url, {
			signal: AbortSignal.any([
				AbortSignal.timeout(SEARCH_TIMEOUT_MS),
				...(opts.signal ? [opts.signal] : []),
			]),
			headers: { Accept: "application/json" },
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`SearXNG unreachable at ${base}: ${message}`);
	}

	if (!res.ok) {
		let body = "";
		try {
			body = (await res.text()).slice(0, 200);
		} catch {
			/* ignore */
		}
		throw new Error(
			`SearXNG request failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
		);
	}

	let json: any;
	try {
		json = await res.json();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`SearXNG returned non-JSON response: ${message}`);
	}

	const n = Math.max(1, Math.min(count, MAX_RESULTS));
	const raw: any[] = Array.isArray(json.results) ? json.results : [];
	const results: SearxngResult[] = raw.slice(0, n).map((r) => ({
		title: typeof r.title === "string" ? r.title : "",
		url: typeof r.url === "string" ? r.url : "",
		snippet: typeof r.content === "string" ? r.content : "",
	}));
	const answers: string[] = Array.isArray(json.answers)
		? json.answers.filter((a: unknown) => typeof a === "string")
		: [];
	const unresponsiveEngines: string[] = Array.isArray(
		json.unresponsive_engines,
	)
		? json.unresponsive_engines
				.filter((e: unknown) => Array.isArray(e) && typeof e[0] === "string")
				.map((e: string[]) => e[0])
		: [];

	return {
		query: typeof json.query === "string" ? json.query : query,
		results,
		answers,
		unresponsiveEngines,
	};
}

// ── Formatting ───────────────────────────────────────────────────────

function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Render the search response in the compact numbered list format
 * (numbered results, then optional direct answers, then a note when
 * upstream engines are suspended).
 */
export function formatSearchResults(
	data: SearxngSearchData,
): { text: string; resultCount: number } {
	const parts: string[] = [];

	if (data.results.length === 0) {
		if (data.unresponsiveEngines.length > 0) {
			parts.push(
				`Search returned no results, but upstream engines are temporarily unavailable (${data.unresponsiveEngines.join(", ")}). ` +
					`Retry in a minute; results are likely incomplete right now.`,
			);
		} else {
			parts.push(`No results found for "${data.query}".`);
		}
	} else {
		parts.push(
			data.results
				.map((r, i) => {
					const lines = [`${i + 1}. ${r.title || "(untitled)"}`];
					if (r.url) lines.push(`   ${r.url}`);
					const snippet = flatten(r.snippet);
					if (snippet) lines.push(`   ${snippet}`);
					return lines.join("\n");
				})
				.join("\n\n"),
		);
		if (data.unresponsiveEngines.length > 0) {
			parts.push(
				`(Note: some upstream engines were temporarily unavailable — ${data.unresponsiveEngines.join(", ")} — results may be incomplete.)`,
			);
		}
	}

	if (data.answers.length > 0) {
		parts.push(
			"Answers:\n" + data.answers.map((a) => `- ${flatten(a)}`).join("\n"),
		);
	}

	return { text: parts.join("\n\n"), resultCount: data.results.length };
}

// ── Cross-process rate limiting ───────────────────────────────────────
// SearXNG's upstream engines suspend the instance on bursts of queries, so
// web_search is paced to at most one request per interval (default 61s). The
// limit is GLOBAL, not per-process: every sub-agent is a separate pi process,
// but they all share the same SearXNG upstream, so the limiter's state lives in
// a small file under the system temp dir (keyed by SearXNG URL) and callers
// serialize on an O_EXCL lock. A per-process in-memory limiter would let two
// parallel sub-agents burst the engine pool together.
//
// WEB_SEARCH_MIN_INTERVAL_S sets the interval in seconds (0 disables).
// WEB_SEARCH_RL_DIR overrides the state directory (tests).

const DEFAULT_MIN_INTERVAL_S = 61;
const STALE_LOCK_MS = 2 * 60 * 1000; // a lock older than this is from a crashed process
const LOCK_RETRY_MS = 150; // sleep between lock-acquire attempts
const LOCK_WAIT_CAP_MS = 30 * 1000; // give up acquiring the lock after this

export function getMinIntervalMs(): number {
	const raw = process.env.WEB_SEARCH_MIN_INTERVAL_S;
	if (raw === undefined) return DEFAULT_MIN_INTERVAL_S * 1000;
	const n = Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_MIN_INTERVAL_S * 1000;
	return Math.max(0, Math.round(n * 1000));
}

function rlDir(): string {
	return process.env.WEB_SEARCH_RL_DIR || tmpdir();
}

export function rlStateFile(baseUrl: string): string {
	const h = createHash("md5").update(baseUrl).digest("hex").slice(0, 16);
	return join(rlDir(), `pi-websearch-rl-${h}.json`);
}

function readLastRequest(stateFile: string): number {
	try {
		const data = JSON.parse(readFileSync(stateFile, "utf8"));
		return typeof data?.lastRequest === "number" ? data.lastRequest : 0;
	} catch {
		return 0;
	}
}

function writeLastRequest(stateFile: string, ts: number): void {
	writeFileSync(stateFile, JSON.stringify({ lastRequest: ts }));
}

/** Create the lock file exclusively; returns true if we hold it. Cleans up stale locks. */
function acquireLock(lockFile: string): boolean {
	for (;;) {
		try {
			const fd = openSync(lockFile, "wx"); // O_CREAT|O_EXCL — fails if it exists
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return true;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			try {
				const st = statSync(lockFile);
				if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
					try {
						unlinkSync(lockFile);
					} catch {
						/* lost the race to another cleaner — fine */
					}
					continue; // retry creating immediately
				}
			} catch {
				/* lock vanished between the exists-check and stat — retry */
			}
			return false; // held by a live process; caller will retry
		}
	}
}

function releaseLock(lockFile: string): void {
	try {
		unlinkSync(lockFile);
	} catch {
		/* already gone */
	}
}

async function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	const CHUNK = 250;
	let remaining = ms;
	while (remaining > 0) {
		if (signal?.aborted) throw new Error("Aborted while waiting for the web_search rate limit");
		const slice = Math.min(CHUNK, remaining);
		await new Promise((r) => setTimeout(r, slice));
		remaining -= slice;
	}
}

/**
 * Pace web_search to at most one request per interval, shared across all
 * sub-agent processes. Returns the number of milliseconds waited. `baseUrl`
 * selects the limiter for that SearXNG instance.
 */
export async function waitForSearchSlot(
	baseUrl: string,
	opts: { intervalMs?: number; stateFile?: string; signal?: AbortSignal } = {},
): Promise<number> {
	const intervalMs = opts.intervalMs ?? getMinIntervalMs();
	if (intervalMs <= 0) return 0; // disabled

	const stateFile = opts.stateFile ?? rlStateFile(baseUrl);
	const lockFile = stateFile + ".lock";
	const signal = opts.signal;
	const startedAt = Date.now();

	for (;;) {
		if (signal?.aborted) throw new Error("Aborted while waiting for the web_search rate limit");

		// Acquire the lock, retrying with backoff; stale locks are cleaned up along the way.
		let acquired = false;
		const lockDeadline = Date.now() + LOCK_WAIT_CAP_MS;
		while (Date.now() < lockDeadline) {
			if (signal?.aborted) throw new Error("Aborted while waiting for the web_search rate limit");
			if (acquireLock(lockFile)) {
				acquired = true;
				break;
			}
			await interruptibleSleep(LOCK_RETRY_MS, signal);
		}

		if (!acquired) {
			// Another process is holding the lock past the cap. Pacing is the whole point,
			// so conservatively wait out the interval before proceeding.
			const extra = Math.max(0, intervalMs - (Date.now() - startedAt));
			if (extra > 0) await interruptibleSleep(extra, signal);
			return Date.now() - startedAt;
		}

		try {
			const last = readLastRequest(stateFile);
			const now = Date.now();
			const remaining = intervalMs - (now - last);
			if (remaining <= 0) {
				writeLastRequest(stateFile, now);
				return Date.now() - startedAt;
			}
			// Slot is occupied: release the lock, wait for the interval to elapse, then
			// re-loop and re-check (another process may have advanced `last` meanwhile).
			await interruptibleSleep(remaining, signal);
		} finally {
			releaseLock(lockFile);
		}
	}
}

// ── Extension Registration ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via the local SearXNG instance. Returns a numbered list of title / URL / snippet results, plus direct answers when available. " +
			"The query supports SearXNG operators: \"exact phrase\", OR, inurl:, intitle:, filetype:. " +
			"Calls are rate-limited to about one per minute (shared across all sub-agents), so a call may wait before running. " +
			"If the response notes that upstream engines are temporarily unavailable, wait ~1 minute and retry before concluding there are no results.",
		parameters: Type.Object({
			query: Type.String({
				description:
					'Search query. Supports SearXNG operators: "exact phrase", OR, inurl:, intitle:, filetype:.',
			}),
			count: Type.Optional(
				Type.Number({
					description: `Number of results (1-${MAX_RESULTS}, default ${DEFAULT_COUNT})`,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const count =
				typeof params.count === "number" ? params.count : DEFAULT_COUNT;
			const base = getSearxngUrl();
			const waitedMs = await waitForSearchSlot(base, { signal });
			const data = await searchSearxng(params.query, count, {
				signal,
				baseUrl: base,
			});
			const { text, resultCount } = formatSearchResults(data);
			const finalText =
				waitedMs >= 2000
					? `${text}\n\n(Rate-limited: waited ${Math.round(waitedMs / 1000)}s before searching.)`
					: text;
			return {
				content: [{ type: "text" as const, text: finalText }],
				details: {
					query: data.query,
					resultCount,
					unresponsiveEngines: data.unresponsiveEngines,
					rateLimitWaitMs: waitedMs,
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { query } = args as { query?: string };
			if (!query) {
				text.setText(
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("error", "(no query)"),
				);
				return text;
			}
			const display = query.length > 50 ? query.slice(0, 47) + "..." : query;
			text.setText(
				theme.fg("toolTitle", theme.bold("search ")) +
					theme.fg("accent", display),
			);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Searching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				query?: string;
				resultCount?: number;
				unresponsiveEngines?: string[];
				rateLimitWaitMs?: number;
			};
			const q = details?.query ?? "";
			const n = details?.resultCount ?? 0;
			const enginesDown = details?.unresponsiveEngines?.length ?? 0;
			const waitedSec = Math.round((details?.rateLimitWaitMs ?? 0) / 1000);
			const status =
				theme.fg("success", `"${q}"`) +
				theme.fg("muted", ` — ${n} result${n === 1 ? "" : "s"}`) +
				(enginesDown > 0
					? theme.fg("warning", ` (${enginesDown} engine${enginesDown === 1 ? "" : "s"} down)`)
					: "") +
				(waitedSec >= 2
					? theme.fg("dim", ` · waited ${waitedSec}s (rate limit)`)
					: "");

			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500 ? content.slice(0, 500) + "..." : content;
			text.setText(status + "\n" + theme.fg("dim", preview));
			return text;
		},
	});
}

// ── Test exports ─────────────────────────────────────────────────────

export const __test__ = {
	getMinIntervalMs,
	rlStateFile,
	waitForSearchSlot,
};
