/**
 * Import-time scrub of ambient sub-agent environment variables.
 *
 * pi sets PI_SUBAGENT_* in every sub-agent pane, so `npm test` run from inside
 * one inherits a sub-agent identity. The extension reads some of that state
 * once, at module load — PI_SUBAGENT_ALLOWED becomes the module-level
 * SUBAGENT_ALLOWLIST (pi-extension/subagents/index.ts), which filters the
 * discoverable agent set — so the restriction cannot be undone later by a
 * beforeEach: the snapshot already happened during import.
 *
 * PI_SUBAGENT_MODEL_OVERRIDES is seeded the same way, into the module-level
 * inheritedModelOverrides snapshot, so an ambient value would leak into every
 * test that runs before the model-override suite resets it.
 *
 * This module has no exports. Importing it for its side effect *before* the
 * extension module makes the whole test file hermetic with respect to those
 * vars, i.e. it always behaves like a top-level session. PI_SUBAGENT_AGENT is
 * read per tool call rather than at load, so suites that call into the spawn
 * path also neutralize it around each test (see the save/restore in
 * test.ts); scrubbing it here too keeps the two halves from disagreeing.
 *
 * Nothing here weakens a guard test: a test that wants a sub-agent env still
 * sets it explicitly in its own body and restores it afterwards.
 */
for (const name of [
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_ALLOWED",
  "PI_SUBAGENT_MODEL_OVERRIDES",
]) {
  delete process.env[name];
}
