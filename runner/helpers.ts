/**
 * Output parsing + formatting helpers for the quiet test wrapper.
 *
 * Zero dependencies — Bun / Node built-ins only.
 *
 * Why a line parser instead of a custom reporter: when `bun test` runs with a
 * piped (non-TTY) stdout and `FORCE_COLOR=0`, it falls back to plain-ASCII
 * output with `(pass)` / `(fail)` prefixes and `N pass / N fail / N expect()
 * calls` summary lines. That stable, human-and-machine-readable format is all
 * we need — no inspector protocol, no plugins, works on any Bun version.
 */

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsiCodes(str: string): string {
  return str.replace(ANSI_RE, "");
}

/** Collapse runs of identical adjacent lines into `line` + `(repeated N more times)`. */
export function deduplicateLines(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  const result: string[] = [];
  let currentLine = "";
  let currentCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === currentLine && line.length > 0) {
      currentCount++;
    } else {
      if (currentCount > 1) result.push(`  (repeated ${currentCount - 1} more times)`);
      currentLine = line;
      currentCount = 1;
      result.push(line);
    }
  }
  if (currentCount > 1) result.push(`  (repeated ${currentCount - 1} more times)`);

  return result.join("\n");
}

export interface TestFailure {
  file: string;
  test: string;
  details: string[];
}

export interface ParseState {
  currentFile: string;
  currentTest: string;
  passes: number;
  fails: number;
  expects: number;
  filesRan: number;
  /** Test files seen so far (for live TUI progress); filesRan is the final count. */
  filesSeen: number;
  failures: TestFailure[];
  capturing: TestFailure | null;
  /**
   * Bun prints a failure's error block (error:, Expected/Received, stack frames)
   * BEFORE the `(fail)` line, so details are buffered here and merged into the
   * next `(fail)` line. If none arrives (file-level crash), they are flushed as
   * an unattributed failure.
   */
  pendingDetails: string[] | null;
  rawLines: number;
}

export function createParseState(): ParseState {
  return {
    currentFile: "",
    currentTest: "",
    passes: 0,
    fails: 0,
    expects: 0,
    filesRan: 0,
    filesSeen: 0,
    failures: [],
    capturing: null,
    pendingDetails: null,
    rawLines: 0,
  };
}

const PASS_PREFIXES = ["(pass)", "✓"];
const FAIL_PREFIXES = ["(fail)", "✗", "FAIL"];

function extractName(trimmed: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (trimmed.startsWith(`${prefix} `)) {
      return trimmed
        .slice(prefix.length + 1)
        .replace(/\s*\[[\d.]+m?s\]$/, "")
        .trim();
    }
  }
  return "";
}

const FILE_HEADER_RE = /^\S[^:]*\.test\.[cm]?tsx?:$/;
const CODE_SNIPPET_RE = /^\s*\d+\s*\|/;
const BARE_CARET_RE = /^\s*\^$/;
/**
 * bun prints the inspector banner to stderr the moment a debugger attaches,
 * which can land mid-stream (between failures). These lines are never test
 * output — drop them everywhere without touching capture state.
 */
const INSPECTOR_NOISE_RE = /Bun Inspector|debug\.bun\.sh|^ws:\/\/|^Listening:$/;

/**
 * Bun prefixes error blocks with a source-code snippet (numbered lines plus a
 * bare `^` caret). Snippets belong to the *next* failure and are deliberately
 * excluded from the compact report — the `at <file>:<line>` frame is kept
 * instead. Caret lines that carry a message (`^ this test timed out ...`) are
 * real error details and are kept.
 */
function isSnippetLine(trimmed: string): boolean {
  return CODE_SNIPPET_RE.test(trimmed) || BARE_CARET_RE.test(trimmed);
}
const SUMMARY_RE = {
  pass: /^(\d+)\s+pass$/,
  fail: /^(\d+)\s+fail$/,
  expects: /^(\d+)\s+expect\(\)\s+calls$/,
  ran: /^Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?/,
} as const;

/** Attribute buffered error details to a failure entry. */
function attachDetails(state: ParseState, failure: TestFailure): void {
  if (state.pendingDetails) {
    failure.details = state.pendingDetails;
    state.pendingDetails = null;
  }
}

/** Buffered error details that no `(fail)` line claimed — a file-level crash. */
function flushPendingDetails(state: ParseState): void {
  if (state.pendingDetails) {
    state.failures.push({
      file: state.currentFile,
      test: "(file-level error)",
      details: state.pendingDetails,
    });
    state.pendingDetails = null;
  }
}

/**
 * Feed one raw (possibly ANSI-colored) output line into the state machine.
 * Safe to call for every line from stdout and stderr, in arrival order.
 */
export function feedLine(state: ParseState, rawLine: string): void {
  state.rawLines++;
  const clean = stripAnsiCodes(rawLine).replace(/\r$/, "");
  const trimmed = clean.trim();
  if (!trimmed) {
    if (state.capturing) state.capturing.details.push("");
    else if (state.pendingDetails) state.pendingDetails.push("");
    return;
  }

  if (INSPECTOR_NOISE_RE.test(trimmed)) return;

  if (SUMMARY_RE.pass.test(trimmed)) {
    state.passes = Number.parseInt(SUMMARY_RE.pass.exec(trimmed)![1]!, 10);
    state.capturing = null;
    flushPendingDetails(state);
    return;
  }
  if (SUMMARY_RE.fail.test(trimmed)) {
    state.fails = Number.parseInt(SUMMARY_RE.fail.exec(trimmed)![1]!, 10);
    state.capturing = null;
    flushPendingDetails(state);
    return;
  }
  if (SUMMARY_RE.expects.test(trimmed)) {
    state.expects = Number.parseInt(SUMMARY_RE.expects.exec(trimmed)![1]!, 10);
    state.capturing = null;
    flushPendingDetails(state);
    return;
  }
  const ranMatch = SUMMARY_RE.ran.exec(trimmed);
  if (ranMatch) {
    state.filesRan = Number.parseInt(ranMatch[2]!, 10);
    state.capturing = null;
    flushPendingDetails(state);
    return;
  }

  const passName = extractName(trimmed, PASS_PREFIXES);
  if (passName) {
    state.currentTest = passName;
    state.capturing = null;
    flushPendingDetails(state);
    return;
  }

  const failName = extractName(trimmed, FAIL_PREFIXES);
  if (failName) {
    const failure: TestFailure = { file: state.currentFile, test: failName, details: [] };
    attachDetails(state, failure);
    state.failures.push(failure);
    state.capturing = failure;
    state.currentTest = failName;
    return;
  }

  if (FILE_HEADER_RE.test(trimmed)) {
    state.currentFile = trimmed.slice(0, -1);
    state.currentTest = "";
    state.filesSeen++;
    state.capturing = null;
    flushPendingDetails(state);
    return;
  }

  if (isSnippetLine(trimmed)) {
    state.capturing = null;
    return;
  }

  if (trimmed.startsWith("error:")) {
    // An error block always belongs to the NEXT (fail) line — close any open
    // capture first so details never bleed into the previous failure.
    state.capturing = null;
    if (state.pendingDetails) flushPendingDetails(state);
    state.pendingDetails = [trimmed];
    return;
  }

  if (state.capturing) {
    state.capturing.details.push(trimmed);
    return;
  }

  if (state.pendingDetails) {
    state.pendingDetails.push(trimmed);
  }
}

const MAX_DETAIL_LINES = 30;
const NOISE_FRAME_RE = /node_modules|\/\.bun\//;

/** Trim a failure's raw detail lines into a compact, deduplicated block. */
export function compactFailureDetails(details: string[]): string[] {
  const meaningful = details.filter(
    line => line.trim() !== "" && !(line.trim().startsWith("at ") && NOISE_FRAME_RE.test(line)),
  );

  const compact = deduplicateLines(meaningful.join("\n"))
    .split("\n")
    .filter(line => line.trim() !== "");

  if (compact.length > MAX_DETAIL_LINES) {
    const omitted = compact.length - MAX_DETAIL_LINES;
    return [...compact.slice(0, MAX_DETAIL_LINES), `  ⤷ (${omitted} more lines — see full log)`];
  }
  return compact;
}
