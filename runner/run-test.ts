/**
 * bun-quiet-test — a `bun test` wrapper built for AI agents.
 *
 * Wraps a plain, sequential `bun test` run (no custom reporters, no plugins):
 *   - Humans in a TTY get a live, single-frame progress view while tests run.
 *   - At the end, EVERYONE (human or agent) gets one compact report:
 *     counts + failed tests + deduplicated error details. Nothing else.
 *   - The full raw output is captured to logs/<timestamp>/<slug>.log so it can
 *     be re-read later with `--last` without rerunning the tests.
 *
 * Usage:
 *   bun run runner/run-test.ts [flags] [paths...] [-- <bun test args>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  compactFailureDetails,
  createParseState,
  feedLine,
  stripAnsiCodes,
  type ParseState,
} from "./helpers.ts";

const BUN_BIN = process.execPath;
const PROJECT_ROOT = process.cwd();
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const DEFAULT_TEST_PATH = "test/";
const TUI_REFRESH_INTERVAL_MS = 150;
const TUI_FRAME_HEIGHT = 7;

// --- output styling ---------------------------------------------------------

const isTty = process.stdout.isTTY ?? false;
let useColor = isTty;

function paint(code: string, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function logError(message: string): void {
  process.stderr.write(`[run-test] ERROR: ${message}\n`);
}

// --- CLI --------------------------------------------------------------------

interface ParsedArgs {
  help: boolean;
  last: boolean;
  focus: string | null;
  plain: boolean;
  timeoutMs: number | null;
  paths: string[];
  forwarded: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    last: false,
    focus: null,
    plain: false,
    timeoutMs: null,
    paths: [],
    forwarded: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--") {
      parsed.forwarded = argv.slice(i + 1);
      break;
    } else if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "--last") {
      parsed.last = true;
    } else if (arg === "--focus") {
      if (i + 1 >= argv.length) {
        logError("--focus requires a string argument");
        process.exit(1);
      }
      parsed.focus = argv[++i]!;
    } else if (arg === "--plain") {
      parsed.plain = true;
    } else if (arg.startsWith("--timeout=")) {
      parsed.timeoutMs = Number.parseInt(arg.split("=")[1]!, 10);
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      parsed.timeoutMs = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith("-")) {
      logError(`Unknown flag: ${arg}`);
      process.exit(1);
    } else {
      parsed.paths.push(arg);
    }
    i++;
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write(`run-test.ts - run bun tests with compact, agent-friendly output

USAGE
  bun run runner/run-test.ts [flags] [paths...] [-- <bun test args>]

FLAGS
  --last              Print the compact summary of the last saved run (no rerun)
  --focus <str>       With --last: only show failed tests matching <str>
  --plain             Plain text output (no ANSI colors, no live TUI)
  --timeout <ms>     Per-test timeout forwarded to bun test
  --                  Everything after this is forwarded verbatim to bun test
  -h, --help          Print this help

ARGUMENTS
  <paths>               One or more test files or directories (default: test/)
                        Note: bun treats these as substring filters over test
                        file paths, e.g. "math" matches test/math.test.ts

EXAMPLES
  bun run test                                 # whole suite
  bun run runner/run-test.ts test/math.test.ts # one file
  bun run last                                 # re-read the last run's summary
  bun run runner/run-test.ts --last --focus "adds numbers" test/math.test.ts
  bun run runner/run-test.ts -- --coverage     # forward flags to bun test
`);
}

// --- TUI (humans only; never rendered when stdout is not a TTY) -------------

interface RunMeta {
  startedAt: number;
  command: string;
}

function renderTuiFrame(state: ParseState, meta: RunMeta, repaint: boolean): void {
  if (!useColor) return;
  const elapsed = ((performance.now() - meta.startedAt) / 1000).toFixed(1);
  const width = Math.min(80, process.stdout.columns ?? 80);
  const rule = "─".repeat(width);

  const truncate = (s: string): string => (s.length > 55 ? `...${s.slice(-52)}` : s);
  const file = truncate(state.currentFile) || "Discovering tests...";
  const test = truncate(state.currentTest) || "-";

  let out = repaint ? `\x1b[${TUI_FRAME_HEIGHT}A\x1b[J` : "";
  out += `\x1b[36m\x1b[1m⚡ bun-quiet-test\x1b[0m \x1b[33m${elapsed}s\x1b[0m\n`;
  out += `\x1b[90m${rule}\x1b[0m\n`;
  out += `  \x1b[1mFile:\x1b[0m    \x1b[34m${file}\x1b[0m\n`;
  out += `  \x1b[1mTest:\x1b[0m    \x1b[37m${test}\x1b[0m\n`;
  out += `  \x1b[1mStats:\x1b[0m   \x1b[32m${state.passes} passed\x1b[0m • \x1b[31m${state.fails} failed\x1b[0m${state.expects > 0 ? ` • \x1b[90m${state.expects} asserts\x1b[0m` : ""}\n`;
  out += `  \x1b[90m$ ${meta.command}\x1b[0m\n`;
  out += `\x1b[90m${rule}\x1b[0m\n`;

  process.stdout.write(out);
}

// --- final report (the token-saving core) ------------------------------------

interface ReportOptions {
  state: ParseState;
  command: string;
  durationMs: number | null;
  logFile: string | null;
  focus: string | null;
  includeLogPath: boolean;
}

function buildFinalReport(opts: ReportOptions): string {
  const { state, command, durationMs, logFile, focus, includeLogPath } = opts;
  const elapsed = durationMs !== null ? `${(durationMs / 1000).toFixed(2)}s` : "(saved run)";
  const success = state.fails === 0 && state.failures.length === 0;

  const lines: string[] = [];
  lines.push("=== bun-quiet-test result ===");
  lines.push(`Command: ${command}`);
  const filesPart = state.filesRan > 0 ? `Files: ${state.filesRan}  ` : "";
  lines.push(`${filesPart}Pass: ${state.passes}  Fail: ${state.fails}  Asserts: ${state.expects}  Time: ${elapsed}`);
  lines.push(`Status: ${success ? paint("32", "ALL PASSED") : paint("31", "FAILED")}`);

  if (!success) {
    const failures = focus
      ? state.failures.filter(f => f.test.toLowerCase().includes(focus.toLowerCase()))
      : state.failures;

    if (failures.length === 0) {
      lines.push(`(no failed tests match --focus "${focus}")`);
    } else {
      lines.push("");
      lines.push("Failed tests:");
      for (const failure of failures) {
        lines.push(`  ${failure.file ? `${failure.file} > ` : ""}${failure.test} ${paint("31", "[FAIL]")}`);
        for (const detail of compactFailureDetails(failure.details)) {
          lines.push(`    ${detail}`);
        }
      }
    }
  }

  if (includeLogPath && logFile) {
    lines.push("");
    lines.push(`Log: ${relative(PROJECT_ROOT, logFile)}`);
  }

  return lines.join("\n");
}

// --- log capture -------------------------------------------------------------

function formatTimestampDir(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

function slugFor(paths: string[]): string {
  return paths.map(p => p.replaceAll("/", "__")).join("+");
}

function writeLog(rawLines: string[], paths: string[]): string {
  const timestamp = formatTimestampDir();
  const logFile = join(LOGS_DIR, timestamp, `${slugFor(paths)}.log`);
  mkdirSync(join(LOGS_DIR, timestamp), { recursive: true });
  writeFileSync(logFile, `${rawLines.join("\n")}\n`, "utf8");
  return logFile;
}

function findLatestLog(paths: string[]): string | null {
  if (!existsSync(LOGS_DIR)) return null;
  const wanted = `${slugFor(paths)}.log`;
  const timestampDirs = readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .toSorted((a, b) => b.localeCompare(a));
  for (const tsDir of timestampDirs) {
    const candidate = join(LOGS_DIR, tsDir, wanted);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// --- run mode ----------------------------------------------------------------

async function streamLines(readable: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of readable) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      onLine(buffer.slice(0, newlineIdx));
      buffer = buffer.slice(newlineIdx + 1);
      newlineIdx = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) onLine(buffer);
}

async function runTests(paths: string[], timeoutMs: number | null, forwarded: string[]): Promise<number> {
  const bunArgs = ["test", ...paths];
  if (timeoutMs !== null) bunArgs.push(`--timeout=${timeoutMs}`);
  bunArgs.push(...forwarded);
  const command = `bun ${bunArgs.join(" ")}`;

  const state = createParseState();
  const meta: RunMeta = { startedAt: performance.now(), command };
  const rawLines: string[] = [];

  const proc = Bun.spawn([BUN_BIN, ...bunArgs], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
    env: { ...process.env, FORCE_COLOR: "0", NODE_ENV: "test" },
  });

  const onLine = (line: string): void => {
    rawLines.push(line);
    feedLine(state, line);
  };

  const useTui = useColor;
  if (useTui) process.stdout.write("\x1b[?25l");
  let firstFrame = true;
  const ticker = useTui
    ? setInterval(() => {
        renderTuiFrame(state, meta, !firstFrame);
        firstFrame = false;
      }, TUI_REFRESH_INTERVAL_MS)
    : null;
  if (useTui) renderTuiFrame(state, meta, false);

  const cleanup = (): void => {
    if (ticker) clearInterval(ticker);
    if (useTui) process.stdout.write("\x1b[?25h");
  };
  process.on("SIGINT", () => {
    cleanup();
    try {
      proc.kill();
    } catch {
      // already dead
    }
    process.exit(1);
  });

  const [stdoutDone, stderrDone, exitCode] = await Promise.all([
    streamLines(proc.stdout as ReadableStream<Uint8Array>, onLine),
    streamLines(proc.stderr as ReadableStream<Uint8Array>, onLine),
    proc.exited,
  ]);
  void stdoutDone;
  void stderrDone;
  cleanup();

  const logFile = writeLog(rawLines, paths);
  const durationMs = performance.now() - meta.startedAt;

  process.stdout.write("\n");
  process.stdout.write(`${buildFinalReport({ state, command, durationMs, logFile, focus: null, includeLogPath: true })}\n`);

  return exitCode;
}

// --last mode -----------------------------------------------------------------

function showLastResult(paths: string[], focus: string | null): void {
  const logFile = findLatestLog(paths);
  if (!logFile) {
    logError(`No previous run found for: ${paths.join(" ")}`);
    process.exit(1);
    return;
  }

  const state = createParseState();
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    feedLine(state, stripAnsiCodes(line));
  }

  const success = state.fails === 0 && state.failures.length === 0;
  process.stdout.write(
    `${buildFinalReport({ state, command: `bun test ${paths.join(" ")} (saved run)`, durationMs: null, logFile, focus, includeLogPath: true })}\n`,
  );
  process.exit(success ? 0 : 1);
}

// --- entry -------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.plain) useColor = false;

  const paths = args.paths.length > 0 ? args.paths : [DEFAULT_TEST_PATH];

  if (args.last) {
    showLastResult(paths, args.focus);
    return;
  }

  const exitCode = await runTests(paths, args.timeoutMs, args.forwarded);
  process.exit(exitCode);
}

main().catch((err: unknown) => {
  logError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
