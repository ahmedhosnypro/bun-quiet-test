# bun-quiet-test

**A minimal-output `bun test` wrapper for AI agents.** Live TUI for humans while tests run,
one compact report at the end for agents — so coding agents read test results without
burning tokens on per-test pass lines, ANSI codes, and banners.

Zero dependencies. Only requirement: [Bun](https://bun.com).

```
Raw bun test:      24 lines, 915 bytes   →   bun-quiet-test:   7 lines, 170 bytes  (-81%)
```

## Why

Raw `bun test` output is designed for humans: a line per passing test, durations for each,
version banners, blank-line padding. When an AI agent runs your test suite, all of that
becomes prompt tokens — and for a green run, almost none of it is useful:

```
bun test v1.4.0 (34cbb9a40)

test/math.test.ts:
(pass) add > adds two positive numbers [0.54ms]
(pass) add > adds negative numbers [0.01ms]
(pass) add > is commutative
(pass) subtract > subtracts the second from the first [0.02ms]
(pass) average > averages a list of numbers [3.77ms]
(pass) average > throws on an empty list [2.31ms]

test/strings.test.ts:
(pass) capitalize > capitalizes a single word [0.48ms]
(pass) capitalize > lowercases the rest of the word [0.18ms]
(pass) capitalize > leaves an empty string alone
(pass) truncate > returns short strings unchanged [0.02ms]
(pass) truncate > truncates long strings to maxLength - 1 plus an ellipsis [0.22ms]
(pass) truncate > throws on a non-positive maxLength [0.02ms]
(pass) slugify > turns spaces into dashes [3.10ms]
(pass) slugify > strips leading and trailing dashes [0.16ms]

 14 pass
 0 fail
 14 expect() calls
Ran 14 tests across 2 files. [47.00ms]
```

With the wrapper, the same run produces:

```
=== bun-quiet-test result ===
Command: bun test test/
Files: 2  Pass: 14  Fail: 0  Asserts: 14  Time: 0.03s
Status: ALL PASSED

Log: logs/2026-09-21T02-05-11/test__.log
```

The saving grows with your suite: a 500-test suite that passes emits ~500 useless lines
raw, but always exactly 5 lines through the wrapper. The full raw output is never lost —
it's captured to `logs/<timestamp>/` and can be re-read on demand with `--last`.

## Failure output

Failures are where compact output matters most: the report keeps **only** the failed test
names and their deduplicated error details — no passing-test noise, no repeated lines, no
code-snippet dumps, no `node_modules` stack frames.

The repo ships a demo suite in `demo/` (outside the default `test/` path) that exercises
all three failure kinds bun produces — assertion diff, thrown error, and test timeout:

```
$ bun run runner/run-test.ts --plain demo/failures.test.ts

=== bun-quiet-test result ===
Command: bun test demo/failures.test.ts
Files: 1  Pass: 0  Fail: 3  Asserts: 1  Time: 0.51s
Status: FAILED

Failed tests:
  demo/failures.test.ts > failure demo > assertion diff failure [FAIL]
    error: expect(received).toBe(expected)
    Expected: 5
    Received: 4
    at <anonymous> (/path/to/bun-quiet-test/demo/failures.test.ts:12:23)
  demo/failures.test.ts > failure demo > thrown error failure [FAIL]
    error: boom: something went wrong on purpose
    at <anonymous> (/path/to/bun-quiet-test/demo/failures.test.ts:16:60)
  demo/failures.test.ts > failure demo > timeout failure [FAIL]
    ^ this test timed out after 500ms.

Log: logs/2026-09-21T04-36-19/demo__failures.test.ts.log
```

Compare that with the raw output for the same three failures: 40+ lines including
numbered source snippets, blank-line padding, the passing-test list, and version
banners — most of it irrelevant to fixing the bug.

## The TUI (humans only)

When stdout is a TTY, the wrapper renders a live single-frame progress view while the
child `bun test` runs — current file, current test, running pass/fail/assert counts,
elapsed time:

```
⚡ bun-quiet-test [demo/] 2.4s elapsed
────────────────────────────────────────────────────────────────────────────────
  📁 File:    demo/slow.test.ts
  ▶ Test:     slow demo > processes a batch
  📊 Tests:   1 passed • 0 failed
  📦 Progress: [█████░░░░░░░░░░░] 33% (1/3 tests)
────────────────────────────────────────────────────────────────────────────────
```

The `▶ Test` and `📦 Progress` rows are driven in real time by bun's own
`TestReporter` events (the wrapper attaches to `bun test --inspect` over the
inspector WebSocket — bun's official custom-reporter channel), so the current
test appears the moment it starts and the bar reflects the discovered test
total.

To watch it for real, run `bun run test` — the showcase suite contains slow tests
(about 6 seconds total) so the frames tick by visibly.

When the run ends, the TUI is replaced by the same compact report agents get (with ANSI
colors). Non-TTY consumers — AI agents, CI logs, pipes — never see the TUI or any escape
sequences at all, so it never contaminates captured output.

## Usage

```sh
bun test                                           # just works — the guard delegates to the wrapper
bun test math                                      # one file or substring filter, passed through
bun run test                                       # the same, script form (showcase suite)
bun run test:file -- --coverage test/math.test.ts  # flag-bearing runs forward verbatim
bun run runner/run-test.ts --plain test/           # plain text (no TUI, no colors)
bun run last                                       # re-read the last run's summary — no rerun
bun run runner/run-test.ts --last --focus "average" test/math.test.ts
```

| Flag | Description |
| --- | --- |
| `--last` | Print the compact summary of the last saved run (no rerun) |
| `--focus <str>` | With `--last`: only show failed tests matching `<str>` |
| `--plain` | Plain text output — no ANSI colors, no live TUI |
| `--timeout <ms>` | Per-test timeout forwarded to bun test |
| `--` | Everything after is forwarded verbatim to `bun test` |
| `-h`, `--help` | Usage |

Notes:

- Typing plain `bun test` is intercepted by the preload guard and delegated to the
  wrapper — same TUI, same compact report, same exit code. Bun still prints its banner
  and the first file header before the guard takes over.
- Flags on a direct `bun test` call cannot be forwarded through the preload (Bun does
  not expose CLI flags to preloads). Detected flags print a notice; use
  `bun run test:file -- <flags> <paths>` for flag support, or bypass the guard for raw
  output: `BUN_QUIET_TEST_RUNNER_OK=1 bun test ...`
- Positional paths follow standard `bun test` semantics: they act as substring filters
  over discovered test file paths (e.g. `math` matches `test/math.test.ts`).
- The child runs with `--inspect` so the wrapper can attach its live reporter via
  bun's inspector protocol (the official custom-reporter mechanism). Forward your
  own `--inspect*` flags after `--` and the wrapper won't add another. Inspector
  banner noise never reaches the report.
- Exit code always mirrors the underlying `bun test` exit code, so scripts and CI gates
  work unchanged.
- `logs/` holds one `<timestamp>/<paths>.log` file per run with the full raw output. It is
  gitignored; prune it whenever you like.

## How it works

The wrapper spawns `bun test --inspect` with piped stdout/stderr, `FORCE_COLOR=0`,
and `NODE_ENV=test`. The inspector is bun's official custom-reporter mechanism:
the wrapper connects to the inspector WebSocket and subscribes to
`TestReporter.found` / `start` / `end` events, so the TUI shows the current
test the moment it *starts* and a progress bar computed from the discovered
test total. If that connection fails (older Bun, busy port, a very fast run),
the TUI silently falls back to state parsed from the piped text.

Plain `bun test` is intercepted the same way siraj's test runners do it: `bunfig.toml`
loads `runner/test-runner-guard.ts` as a `[test]` preload, so it runs inside every
`bun test` process. The guard recovers the original command line from the OS
(`/proc/self/cmdline` on Linux, `ps` elsewhere — preloads don't receive CLI flags
or the invocation args) and transparently re-executes the wrapper with the same
path filters. The wrapper marks its own children with `BUN_QUIET_TEST_RUNNER_OK=1`,
which makes the guard a no-op there and prevents infinite delegation.

The compact final report is always built by parsing the piped text: with a
non-TTY stdout, bun falls back to plain-ASCII output — `(pass)` / `(fail)`
prefixes and `N pass / N fail / N expect() calls` summary lines — which a
small line parser (`runner/helpers.ts`) consumes. No plugins, no config, no
side effects: it's a plain wrapper around standard `bun test` behavior, so it
stays portable across Bun versions and projects.

Bun prints a failure's error block *before* its `(fail)` line; the parser buffers error
details and merges them into the matching `(fail)` entry. Error blocks that no `(fail)`
line claims (file-level crashes) are kept as unattributed failures. Numbered source
snippets and bare `^` carets are dropped — the `at <file>:<line>` frame already carries
the location — while caret lines that carry a message (test timeouts) are kept. Details
are then deduplicated, `node_modules` frames are dropped, and each failure is capped at 30
lines with a pointer to the full log.

## Use it in your own project

`runner/` is self-contained (three files, no imports outside Bun/Node built-ins):

1. Copy `runner/` into your project.
2. Add to `package.json`:

   ```json
   "scripts": {
     "test": "bun run runner/run-test.ts",
     "last": "bun run runner/run-test.ts --last"
   }
   ```

3. Add the preload guard to `bunfig.toml` so plain `bun test` goes through the
   wrapper too:

   ```toml
   [test]
   preload = ["./runner/test-runner-guard.ts"]
   ```

4. Run `bun run test` (or just `bun test`). `logs/` is created automatically and
   should be gitignored.

Note: in this repo the `test` script points at `demo/` (the showcase suite) because the
repository itself is the template — in your project it points at your own suite.

No databases, no services, no integrations — it wraps whatever `bun test` already runs in
your project, sequentially, exactly as `bun test` would.

## Project layout

```
runner/
  run-test.ts          # the wrapper: TUI, final report, log capture, --last/--focus
  test-runner-guard.ts # bunfig preload: intercepts direct `bun test` and delegates
  helpers.ts           # ANSI stripping, line dedupe, bun test output parser
bunfig.toml            # loads the guard as a [test] preload
src/                   # tiny pure-function modules the demo tests exercise
test/                  # passing demo suite
demo/                  # showcase suite: slow passing tests (watch the TUI) + all
                       # three failure kinds (diff, thrown error, timeout)
```

## License

MIT
