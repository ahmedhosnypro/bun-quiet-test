/**
 * bun-quiet-test — a `bun test` wrapper built for AI agents.
 *
 * Wraps a plain, sequential `bun test` run:
 *   - Humans in a TTY get a live single-frame progress view while tests run,
 *     driven by bun's official custom-reporter mechanism: the child runs with
 *     `--inspect` and the wrapper subscribes to TestReporter events over the
 *     inspector WebSocket (current test at start, discovered total for the
 *     progress bar). If that connection fails, the TUI falls back to parsing
 *     the piped text output.
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
const DEFAULT_TEST_PATH = "demo/";
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
  <paths>               One or more test files or directories (default: demo/)
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

// --- live reporter (bun's official custom-reporter mechanism) ----------------
//
// With `--inspect`, bun exposes the TestReporter domain over the inspector
// WebSocket: TestReporter.found / start / end events. That gives the TUI
// real-time data piped text cannot: the current test name the moment it
// STARTS, and the discovered test total for a progress bar. The final report
// always comes from text parsing; if the WebSocket fails or the Bun version
// lacks the domain, the TUI silently falls back to text-derived state.

interface LiveTestInfo {
  name: string;
  parentId?: number;
  url?: string;
}

interface LiveState {
  connected: boolean;
  ws: WebSocket | null;
  testsTotal: number;
  testsCompleted: number;
  passed: number;
  failed: number;
  names: Map<number, LiveTestInfo>;
  currentTestId: number | null;
}

function createLiveState(): LiveState {
  return {
    connected: false,
    ws: null,
    testsTotal: 0,
    testsCompleted: 0,
    passed: 0,
    failed: 0,
    names: new Map(),
    currentTestId: null,
  };
}

const WS_URL_RE = /ws:\/\/[^\s'"]+/;

function tryConnectInspector(rawLine: string, live: LiveState): void {
  if (live.ws) return;
  const match = WS_URL_RE.exec(rawLine);
  if (!match) return;

  // bun's inspector binds to IPv6 loopback only; "localhost" may not resolve there.
  const url = match[0].replace("localhost", "[::1]");
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    return;
  }
  live.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    ws.send(JSON.stringify({ id: 2, method: "TestReporter.enable" }));
    ws.send(JSON.stringify({ id: 3, method: "LifecycleReporter.enable" }));
    live.connected = true;
  };
  ws.onmessage = (msg: MessageEvent) => handleInspectorMessage(live, String(msg.data));
  ws.onclose = () => {
    live.connected = false;
  };
}

function handleInspectorMessage(live: LiveState, data: string): void {
  let parsed: { method?: string; params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  const params = parsed.params;
  if (!params) return;

  if (parsed.method === "TestReporter.found") {
    if (params.type === "test") live.testsTotal++;
    live.names.set(params.id as number, {
      name: String(params.name ?? ""),
      parentId: params.parentId as number | undefined,
      url: params.url as string | undefined,
    });
  } else if (parsed.method === "TestReporter.start") {
    live.currentTestId = params.id as number;
  } else if (parsed.method === "TestReporter.end") {
    live.testsCompleted++;
    if (params.status === "fail") live.failed++;
    else live.passed++;
  }
}

function liveTestName(live: LiveState, id: number | null): string {
  const parts: string[] = [];
  let cursor: number | null | undefined = id;
  let guard = 0;
  while (cursor != null && live.names.has(cursor) && guard++ < 10) {
    const info = live.names.get(cursor)!;
    parts.unshift(info.name);
    cursor = info.parentId ?? null;
  }
  return parts.join(" > ");
}

// --- TUI (humans only; never rendered when stdout is not a TTY) -------------

interface RunMeta {
  startedAt: number;
  label: string;
}

function renderProgressBar(current: number, total: number): string {
  const width = 16;
  if (total <= 0 || current > total) {
    return `\x1b[36m${current}\x1b[0m \x1b[90mtests done (total unknown)\x1b[0m`;
  }
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const percent = Math.round(ratio * 100);
  return `\x1b[36m[${bar}]\x1b[0m \x1b[1m${percent}%\x1b[0m \x1b[90m(${current}/${total} tests)\x1b[0m`;
}

function renderTuiFrame(state: ParseState, live: LiveState, meta: RunMeta, repaint: boolean): void {
  if (!useColor) return;
  const elapsed = ((performance.now() - meta.startedAt) / 1000).toFixed(1);
  const width = Math.min(80, process.stdout.columns ?? 80);
  const rule = "─".repeat(width);

  const truncate = (s: string): string => (s.length > 55 ? `...${s.slice(-52)}` : s);
  const liveInfo = live.currentTestId !== null ? live.names.get(live.currentTestId) : undefined;
  const file = liveInfo?.url
    ? truncate(relative(PROJECT_ROOT, liveInfo.url))
    : truncate(state.currentFile);
  const test = live.currentTestId !== null
    ? truncate(liveTestName(live, live.currentTestId))
    : truncate(state.currentTest);

  const showLive = live.connected;
  const passed = showLive ? live.passed : state.passes;
  const failed = showLive ? live.failed : state.fails;

  let out = repaint ? `\x1b[${TUI_FRAME_HEIGHT}A\x1b[J` : "";
  out += `\x1b[36m\x1b[1m⚡ bun-quiet-test\x1b[0m \x1b[90m[${meta.label}]\x1b[0m \x1b[33m${elapsed}s elapsed\x1b[0m\n`;
  out += `\x1b[90m${rule}\x1b[0m\n`;
  out += `  \x1b[1m📁 File:\x1b[0m    \x1b[34m${file || "Discovering tests..."}\x1b[0m\n`;
  out += `  \x1b[1m▶ Test:\x1b[0m    \x1b[37m${test || "Running..."}\x1b[0m\n`;
  const assertsBadge = state.expects > 0 ? ` • \x1b[90m${state.expects} asserts\x1b[0m` : "";
  out += `  \x1b[1m📊 Tests:\x1b[0m   \x1b[32m${passed} passed\x1b[0m • \x1b[31m${failed} failed\x1b[0m${assertsBadge}\n`;
  const progress = live.connected && live.testsTotal > 0
    ? renderProgressBar(live.testsCompleted, live.testsTotal)
    : `\x1b[36m${state.filesSeen}\x1b[0m \x1b[90mfiles seen so far\x1b[0m`;
  out += `  \x1b[1m📦 Progress:\x1b[0m ${progress}\n`;
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
  // The inspector gives the live TUI real-time TestReporter events. Never
  // double-add when the caller forwarded their own inspector flags.
  if (!forwarded.some(a => a.startsWith("--inspect"))) bunArgs.push("--inspect");
  bunArgs.push(...forwarded);
  const command = `bun ${bunArgs.join(" ")}`;

  const state = createParseState();
  const live = createLiveState();
  const meta: RunMeta = { startedAt: performance.now(), label: paths.join(" ") };
  const rawLines: string[] = [];

  const proc = Bun.spawn([BUN_BIN, ...bunArgs], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
    env: { ...process.env, FORCE_COLOR: "0", NODE_ENV: "test", BUN_QUIET_TEST_RUNNER_OK: "1" },
  });

  const onLine = (line: string): void => {
    rawLines.push(line);
    feedLine(state, line);
    if (!live.ws) tryConnectInspector(line, live);
  };

  const useTui = useColor;
  if (useTui) process.stdout.write("\x1b[?25l");
  let firstFrame = true;
  const ticker = useTui
    ? setInterval(() => {
        renderTuiFrame(state, live, meta, !firstFrame);
        firstFrame = false;
      }, TUI_REFRESH_INTERVAL_MS)
    : null;
  if (useTui) renderTuiFrame(state, live, meta, false);

  const cleanup = (): void => {
    if (ticker) clearInterval(ticker);
    if (useTui) process.stdout.write("\x1b[?25h");
    if (live.ws) {
      try {
        live.ws.close();
      } catch {
        // already closed
      }
    }
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
