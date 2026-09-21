/**
 * Test Runner Guard — Preload Script
 *
 * bunfig.toml loads this before every `bun test` run. A direct `bun test`
 * invocation (by a human or an AI agent) is intercepted here and
 * transparently delegated to the wrapper (runner/run-test.ts), so you always
 * get the live TUI and the compact final report — even when you type plain
 * `bun test`.
 *
 * The wrapper marks its own child runs with BUN_QUIET_TEST_RUNNER_OK=1, which
 * turns this preload into a no-op and prevents infinite delegation.
 *
 * Known limitation: Bun does not expose CLI flags to preloads (process.argv
 * holds the test file being loaded, not the invocation), so this guard
 * recovers the original command line from the OS instead. Flags still cannot
 * be forwarded safely — a detected flag prints a notice. For flag-bearing runs:
 *
 *   bun run test:file -- <flags> <paths>
 *
 * To bypass the guard entirely and get raw output:
 *
 *   BUN_QUIET_TEST_RUNNER_OK=1 bun test <args>
 */
import { readFileSync } from "node:fs";

const RUNNER_ENV_VAR = "BUN_QUIET_TEST_RUNNER_OK";

function isApprovedRunner(): boolean {
  return process.env[RUNNER_ENV_VAR] === "1";
}

/**
 * The original `bun test ...` command line, excluding the bun binary and the
 * "test" subcommand. /proc/self/cmdline (Linux) preserves the kernel's
 * NUL-separated copy with full fidelity; ps covers macOS and other unices
 * with whitespace splitting. Returns null when neither is available.
 */
function originalArgs(): string[] | null {
  try {
    const args = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);
    if (args.length > 0) return args.slice(1).filter(a => a !== "test");
  } catch {
    // not Linux
  }

  try {
    const out = Bun.spawnSync(["ps", "-o", "command=", "-p", String(process.pid)]);
    const text = new TextDecoder().decode(out.stdout).trim();
    if (text.length > 0) return text.split(/\s+/).slice(1).filter(a => a !== "test");
  } catch {
    // no ps either
  }

  return null;
}

/** User positionals (path filters), made relative to the project root. */
function userPaths(args: string[]): string[] {
  const cwd = process.cwd();
  const relativeIfInside = (arg: string): string => (arg.startsWith(`${cwd}/`) ? arg.slice(cwd.length + 1) : arg);
  return args
    .filter(
      a =>
        a !== process.execPath &&
        !a.startsWith("--preload") &&
        !a.endsWith("test-runner-guard.ts"),
    )
    .filter(a => !a.startsWith("-"))
    .map(relativeIfInside);
}

if (!isApprovedRunner()) {
  const args = originalArgs();
  const flags = (args ?? []).filter(a => a.startsWith("-"));

  if (flags.length > 0) {
    process.stderr.write(
      `[bun-quiet-test] bun test flags (${flags.join(" ")}) cannot be forwarded through the preload — ` +
        `delegating paths only. For flag support: bun run test:file -- <flags> <paths>\n`,
    );
  }

  const paths = args === null
    // No way to recover the invocation — fall back to what the preload knows
    // (the test file being loaded). Imperfect for bare `bun test`, but tests
    // still run through the wrapper.
    ? process.argv.filter(a => a !== process.execPath && !a.startsWith("-"))
    : userPaths(args);

  const proc = Bun.spawnSync([process.execPath, "run", "runner/run-test.ts", ...paths], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, [RUNNER_ENV_VAR]: "1" },
  });
  process.exit(proc.exitCode ?? 1);
}
