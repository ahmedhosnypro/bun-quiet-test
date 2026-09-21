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
⚡ bun-quiet-test 12.4s
────────────────────────────────────────────────────────────────────────────────
  File:    test/math.test.ts
  Test:    average > averages a list of numbers
  Stats:   9 passed • 0 failed • 9 asserts
  $ bun test test/
────────────────────────────────────────────────────────────────────────────────
```

To watch it for real, run the demo suite — it contains slow tests (about 6 seconds
total) so the frames tick by visibly:

```
bun run demo
```

When the run ends, the TUI is replaced by the same compact report agents get (with ANSI
colors). Non-TTY consumers — AI agents, CI logs, pipes — never see the TUI or any escape
sequences at all, so it never contaminates captured output.

## Usage

```sh
bun run test                                     # whole suite (default path: test/)
bun run test:file test/math.test.ts              # one file
bun run demo                                      # demo suite: slow TUI tests + failure kinds (~6s)
bun run runner/run-test.ts --plain test/         # plain text (no TUI, no colors)
bun run last                                      # re-read the last run's summary — no rerun
bun run runner/run-test.ts --last test/math.test.ts
bun run runner/run-test.ts --last --focus "average" test/math.test.ts
bun run runner/run-test.ts -- --coverage         # forward flags verbatim to bun test
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

- Positional paths follow standard `bun test` semantics: they act as substring filters
  over discovered test file paths (e.g. `math` matches `test/math.test.ts`).
- Exit code always mirrors the underlying `bun test` exit code, so scripts and CI gates
  work unchanged.
- `logs/` holds one `<timestamp>/<paths>.log` file per run with the full raw output. It is
  gitignored; prune it whenever you like.

## How it works

The wrapper spawns `bun test` with piped stdout/stderr, `FORCE_COLOR=0`, and
`NODE_ENV=test`. With a non-TTY stdout, bun falls back to plain-ASCII output — `(pass)`
/ `(fail)` prefixes and `N pass / N fail / N expect() calls` summary lines — which a small
line parser (`runner/helpers.ts`) consumes as it streams. No custom reporters, no plugins,
no inspector protocol: it's a plain wrapper around completely standard `bun test`
behavior, so it stays portable across Bun versions and projects.

Bun prints a failure's error block *before* its `(fail)` line; the parser buffers error
details and merges them into the matching `(fail)` entry. Error blocks that no `(fail)`
line claims (file-level crashes) are kept as unattributed failures. Numbered source
snippets and bare `^` carets are dropped — the `at <file>:<line>` frame already carries
the location — while caret lines that carry a message (test timeouts) are kept. Details
are then deduplicated, `node_modules` frames are dropped, and each failure is capped at 30
lines with a pointer to the full log.

## Use it in your own project

`runner/` is self-contained (two files, no imports outside Bun/Node built-ins):

1. Copy `runner/` into your project.
2. Add to `package.json`:

   ```json
   "scripts": {
     "test": "bun run runner/run-test.ts",
     "last": "bun run runner/run-test.ts --last"
   }
   ```

3. Run `bun run test` (or pass a path/filters). `logs/` is created automatically and
   should be gitignored.

No databases, no services, no integrations — it wraps whatever `bun test` already runs in
your project, sequentially, exactly as `bun test` would.

## Project layout

```
runner/
  run-test.ts    # the wrapper: TUI, final report, log capture, --last/--focus
  helpers.ts     # ANSI stripping, line dedupe, bun test output parser
src/             # tiny pure-function modules the demo tests exercise
test/            # passing demo suite
demo/            # showcase suite: slow passing tests (watch the TUI) + all
                 # three failure kinds (diff, thrown error, timeout)
```

## License

MIT
