# flakefinder — The Complete Guide

> **One document, zero assumptions.** This is the full story of the
> flakefinder project: the problem it solves, why it exists, how every single
> part of it works — from the smallest utility function to the GitHub Action —
> how it is tested, why every major design decision was made, and where it is
> going in the cloud.
>
> **You need no prior knowledge.** If you have never written a test, never
> heard of CI, and never opened this repository, start at Part 1 and read
> straight through. Every term is defined the first time it appears, and the
> full glossary is in Part 12.
>
> Companion documents, for when you want a different depth:
>
> | Document | Depth | Best for |
> |---|---|---|
> | **docs/EXPLAINER.md** (this file) | everything, from zero | understanding the project |
> | README.md | the pitch | deciding whether to use it |
> | docs/USAGE.md | command reference | daily operation |
> | PLAN.md | the build spec | changing behavior safely |
> | docs/BUILD_REPORT.md | how it was engineered | contributors |
> | docs/CLOUD_SCALING.md | the cloud plan | the roadmap |
>
> Current at: v1.1.0 · 261 tests across 27 files · six report parsers ·
> MIT licensed.

---

## Table of contents

- **Part 1 — The world this tool lives in** (tests, CI, traffic lights)
- **Part 2 — The villain: flaky tests** (what, why, the damage)
- **Part 3 — What flakefinder does** (the pitch, the two superpowers, what's
  new for the community, design principles)
- **Part 4 — The 60-second tour**
- **Part 5 — Architecture overview** (module map, data flow)
- **Part 6 — From atom to atom** (every module, in depth)
  - 6.1 The frozen contract — `src/types.ts`
  - 6.2 Test identity — `makeTestId`
  - 6.3 The utilities — glob matcher, redaction
  - 6.4 The parser layer — all six formats in depth
  - 6.5 The history store — JSONL, locking, pruning
  - 6.6 The detection engine — signals, precedence, scoring, tags
  - 6.7 The runner — live execution, spawning, targeted re-runs
  - 6.8 Quarantine — benching tests without touching code
  - 6.9 The report layer — terminal, JSON, markdown, HTML dashboard
  - 6.10 Configuration — loading, validation, runner detection
  - 6.11 The CLI — every command
  - 6.12 `flakefinder doctor`
  - 6.13 The GitHub Action — internals
  - 6.14 GitLab support
  - 6.15 Build and release machinery
- **Part 7 — How it's tested** (the quality machine)
- **Part 8 — Design decisions and rejected alternatives**
- **Part 9 — QA war stories** (real bugs, what they teach)
- **Part 10 — Configuration reference**
- **Part 11 — The cloud plan**
- **Part 12 — Glossary**
- **Part 13 — FAQ**
- **Part 14 — Where to go next**

---

# Part 1 — The world this tool lives in

## 1.1 What software testing is (from zero)

When programmers write software — a website, a phone app, a bank's backend —
they also write small programs whose only job is to **check** the real
program. Each check is called a *test*.

A test looks like this, conceptually:

> "Call the calculator's divide function with 10 and 2. Assert that the
> answer is 5. If it is not, fail loudly."

Three pieces of vocabulary:

- **assert** — a check that must be true; if it isn't, the test *fails*.
- **test suite** — the complete collection of a project's tests (real
  projects have hundreds to hundreds of thousands).
- **test runner** — the program that executes a suite and reports results.
  Popular runners: **Jest** and **vitest** (JavaScript), **pytest** (Python),
  **go test** (Go), **Mocha** (JavaScript), **VSTest** (.NET).

Tests come in flavors: *unit tests* check one function in isolation,
*integration tests* check that components work together, *end-to-end tests*
drive the whole product like a user would. flakefinder is agnostic — it
reads *results*, whatever kind of test produced them.

The crucial property of a good test: **deterministic**. Same code in, same
result out, every single time. Keep that word in mind — the entire villain
of this story is a test that violates it.

## 1.2 What CI is (from zero)

**CI stands for Continuous Integration.** It is the industry practice of
having robots run a project's entire test suite automatically every time
anyone proposes a change to the code.

Concretely, on GitHub (the world's largest code-hosting platform):

1. A developer finishes a change and opens a **pull request** (PR) — a
   proposal saying "here is my change; please merge it into the main code."
2. GitHub sees the PR and triggers a **workflow** — a recipe of steps
   (checkout the code, install dependencies, run the tests) executed on a
   fresh cloud machine owned by GitHub.
3. Minutes later, the PR shows a traffic light:

   - ✅ **Green** — every test passed. The change is safe to merge.
   - ❌ **Red** — at least one test failed. Stop; fix before merging.

The same robots also run on every push to the main branch, so the main
branch is continuously *verified* to work — hence "continuous integration."

These recipes are files in the repository itself (for GitHub: `.github/
workflows/*.yml`). A single reusable robot recipe — like flakefinder's — is
called a **GitHub Action**. Anyone can publish an Action, and anyone else
can use it in their workflow with one line:

```yaml
- uses: DJJW26/flakefinder@v1
```

The traffic light is sacred. Entire team rituals, merge rules, and release
pipelines are built on trusting it. Which brings us to the problem.

## 1.3 The economics (why the traffic light matters)

A green light is permission to ship. A red light is a stop sign that costs:

- the **developer's** time (context-switch away, investigate),
- the **team's** time (merge blocked, everyone waiting),
- **real money** (CI machines bill by the minute; re-running big suites is
  expensive),
- and, worst case, **user trust** (if the light is ignored, bugs ship).

Everything flakefinder does follows from protecting the *reliability* of
that light at the lowest possible cost.

---

# Part 2 — The villain: flaky tests

## 2.1 What a flaky test is

A **flaky test** is a test that **sometimes passes and sometimes fails on
the exact same code**. Nothing changed. Nobody broke anything. Run it ten
times and it passes nine times; the tenth run, red.

Think of a smoke alarm that goes off randomly, with no fire. At 3 AM.
Sometimes. That is a flaky test.

The formal way to say it: a flaky test is **non-deterministic** — its
outcome depends on something *outside* the code under test.

## 2.2 Where flakiness comes from (the real causes)

Flaky tests are not a hypothetical. A landmark study at Google found that
roughly **1.5% of all test failures are flaky** — across millions of runs,
that is an enormous volume of false alarms. Common root causes:

| Cause | Example |
|---|---|
| **Timing / race conditions** | The test asserts a result before an async operation finished; on a fast machine it wins, on a slow CI runner it loses. |
| **Leftover state** | A test writes `config.json`; a previous test left a different one behind. Passes locally (fresh machine), fails in CI (shared state). |
| **Order dependence** | Tests pass in alphabetical order, fail in the random order CI uses. |
| **Network / I/O** | A test calls a real endpoint; a hiccup anywhere fails it. |
| **Time and randomness** | A test that assumes "today" or a random port that collided. |
| **Resource exhaustion** | CI runner runs out of memory mid-suite; an unrelated test gets blamed. |
| **Concurrency** | Two tests listening on the same port; whoever starts second fails. |

The defining frustration: **the failure is real, but it is not a bug in the
product.** The red light is false.

## 2.3 The four kinds of damage (why this matters)

### Damage 1 — The boy who cried wolf (the worst one)

When a known-flaky test goes red, the team shrugs: "oh, THAT test again —
just re-run it." Do this for a month and the re-run becomes a reflex.
Then one day the red light is a *real* bug racing toward production — and
nobody looks, because red has stopped meaning anything. **Flaky tests are
how real bugs reach users.** This is the damage that makes flaky tests a
severity-1 engineering problem rather than an annoyance.

### Damage 2 — Burned time and money

"Just re-run it" costs a full CI cycle: for a 30-minute suite, every flake
costs 30 minutes of machine time plus the developer's attention. Multiply
by hundreds of developers and thousands of runs.

### Damage 3 — Randomly blocked work

A merge that should take minutes sits for hours because test #417 decided
to fail today. Meanwhile the flaky test blocks *everyone*, not just its owner.

### Damage 4 — Death by manual investigation

Finding a flake by hand is brutally expensive: if a test fails 10% of the
time, you must re-run it ~10 times to catch it once. Nobody has time to do
that for a thousand tests. So teams *know* they have flakes and can't even
*name* them.

## 2.4 What teams do today (and why it isn't enough)

| Coping strategy | Why it fails |
|---|---|
| Re-run and hope | Treats the symptom, pays forever, trains people to ignore red. |
| Delete the test | Throws away real protection because it's annoying. |
| `sleep(5)` before the assertion | Hides the race; fails again on a slower machine. |
| Buy a SaaS dashboard | Paid, closed, cloud-only — your test data leaves your network, and local developers get nothing. |
| Write your own scripts | Every team rebuilds the same fragile log-grepping scripts. |

The gap in the ecosystem: a **free, open-source, deterministic,
local-first** tool that tells you *which* tests are flaky, *how bad*, and
*what to do about it* — on your laptop and in your CI, without shipping
your data anywhere. That gap is exactly what flakefinder fills.

---

# Part 3 — What flakefinder does

## 3.1 The pitch

> **flakefinder** finds your flaky tests before they find your CI.
> It detects them (instantly and from history), scores them 0–100,
> quarantines them without touching your code, comments on your pull
> requests, and renders an offline dashboard. Free, open-source,
> local-first, no AI, no accounts, no telemetry.

One npm package that is simultaneously:

1. a **CLI** (`npx flakefinder …`) for local use and any CI system,
2. a **GitHub Action** (`uses: DJJW26/flakefinder@v1`) for GitHub,
3. a **library** (the engine is importable — this matters for the cloud plan,
   Part 11).

## 3.2 Superpower 1 — the instant detective (retry mode)

You run your tests *through* flakefinder:

```
flakefinder run -- npm test
```

flakefinder executes your normal command. **If it fails, it runs it again**
(up to two more times by default — configurable). Then it reads the results
and separates:

- A test that **failed, then passed on an identical re-run** → *proven
  flake*. Deterministic tests cannot do that; the re-run is mathematical
  proof.
- A test that **failed every time** → *real failure*. Go fix it.

And it encodes the difference in the process **exit code** — the numeric
result a program returns to the shell, which CI systems use as their traffic
light:

| Exit code | Meaning |
|---|---|
| `0` | Clean run, **or** every failure was proven to be a rescued flake |
| `1` | A real failure persisted (a bug — block the merge) |
| `2` | flakefinder itself couldn't operate (bad config, missing files) |

This is the whole trick that makes CI sane again: **flaky no longer means
red.** A rescued flake exits 0 (with a loud report), a real failure exits 1.

## 3.3 Superpower 2 — the long-term memory (history mode)

Every run flakefinder sees is appended to a private diary:
`.flakefinder/history.jsonl` inside your project (one JSON object per line —
human-readable, `cat`-able, deletable at will).

From that diary the engine derives **mathematical proof** of flakiness. The
strongest signal:

> The **same version of the code** (same Git commit — literally identical
> bytes) produced both a pass and a failure for the same test. A healthy
> test cannot do that. Only a flake can.

Weaker statistical signals (repeated flip-flopping across versions) add
evidence for tests that fail rarely. Everything combines into two numbers
per test:

- **Flake score 0–100** — how flaky is this test?
- **Confidence 0–100** — how much evidence backs the verdict?

(The exact arithmetic is in Part 6.6 — it's simple, transparent, and has no
AI in it. Every rule is published in PLAN.md and pinned by tests.)

## 3.4 What you get

- **Terminal reports** — color-coded, worst-first, with next-step hints.
- **An HTML dashboard** — one self-contained file you double-click: every
  test's score, trend charts, a detail drawer per test. Works offline, dark
  and light theme, no network requests.
- **Quarantine** — bench a flaky test from the run path *without editing
  your code* (Part 6.8).
- **PR comments** (GitHub Action) — "3 flaky, 1 NEW this week," with
  evidence and a one-click quarantine command. New flakes are distinguished
  from known ones, so you're only pinged when things get worse.
- **Annotations + MR notes** (any CI) — GitHub-style warnings, GitLab
  merge-request notes.
- **Exit codes you can script against** — the tool composes with everything.

## 3.5 What it does NOT do (boundaries, stated plainly)

- **Never edits your test files.** Quarantine uses the runner's own skip
  flags. Remove an entry, the test is back.
- **Never sends data anywhere.** No cloud, no accounts, no telemetry. The
  GitHub Action uploads only to *your* repository's own cache and artifacts.
  When data does leave the machine (a PR comment), credential-shaped
  strings are redacted first.
- **No AI, no guessing.** Every verdict is deterministic arithmetic on
  recorded evidence; the rules are published and pinned by tests.
- **No daemon, no background processes.** Run it, get answers, done.

## 3.6 What's new for the community (honest positioning)

The flaky-test space has commercial players (BuildPulse, Trunk Flaky Tests,
Datadog Test Visibility, Buildkite Test Engine — all good products, all
paid SaaS, all cloud-first). What flakefinder adds:

| Dimension | What exists | flakefinder |
|---|---|---|
| Cost | Paid SaaS | Free, MIT |
| Data locality | Your results leave your network | Everything local; the Action only touches your repo's own cache |
| Transparency | Closed-source scoring | Every rule published (PLAN §5), table-test driven |
| Setup | Vendor onboarding | `npx flakefinder init` → done; no account |
| Local experience | CI-only products | First-class CLI: your laptop is a first-class citizen |
| Determinism | Some vendors add opaque "AI scoring" | Pure arithmetic; reproducible verdicts |
| Format coverage | Varies by vendor | Six formats out of the box: JUnit XML, Jest/vitest JSON, Mocha JSON, `go test -json`, TAP (node:test), TRX (.NET) |
| Story for CI cost | Detection only | *Targeted re-runs*: retry loops cost suite + 2×(failed tests), not 3×(whole suite) |

Also — and this is the part the community asked for — it is the **only**
tool in this space whose detection engine is a small, dependency-light,
importable TypeScript library, which makes the cloud roadmap (Part 11)
"the same engine, hosted if you want it" instead of a rewrite.

---

# Part 4 — The 60-second tour

```console
$ npx flakefinder init                # detect your test runner, write a config
$ npx flakefinder run -- npm test     # run tests WITH flake detection
   …your normal test output…
   flakefinder — 412 tracked test(s), 2 need attention

   FLAKY (confirmed) — 1
      90  conf 100%  runs   6  pass  50%  med  301ms  Calculator :: divides evenly
   FAILING — 1
        0  conf  50%  runs   5  pass   0%  med    8ms  Network :: real endpoint

   next steps:
     • quarantine the worst offender:
         flakefinder quarantine add 751d224cd7d6734b

$ npx flakefinder report              # verdicts from accumulated history
$ npx flakefinder html                # self-contained dashboard file
$ npx flakefinder doctor              # is my setup wired correctly?
```

In GitHub, add one step to your workflow and every PR gets flake reports,
comments, and a dashboard artifact — Part 6.13.

---

# Part 5 — Architecture overview

## 5.1 The one-paragraph shape

flakefinder is a **pipeline**: test runners produce *report files*
(machine-readable receipts of a run); parsers normalize them into a common
shape; a store accumulates them as an append-only diary; the engine scores
every test from its diary; renderers turn verdicts into terminal output,
JSON, markdown, and HTML; and a thin CLI and a GitHub Action drive the
pipeline from the terminal and from CI.

## 5.2 Module map

```
                       ┌─────────────────────────────────────────┐
   your test runner ──►│ report files (JUnit XML / Jest JSON /   │
   (jest, pytest, go,  │ Mocha JSON / go test -json / TAP / TRX) │
   dotnet …)           └───────────────────┬─────────────────────┘
                                       │  sniff + parse
                                       ▼
                            ┌─────────────────────┐
                            │   src/parsers/*     │  six parsers + detectParser
                            │  → TestCaseResult[] │  (normalize to one shape)
                            └─────────┬───────────┘
                                      │ RunRecord {runId, attempt, commitSha, results}
                                      ▼
                            ┌─────────────────────┐
                            │  src/store/         │  append-only JSONL diary
                            │  history.jsonl      │  (locked, pruned, tolerant)
                            └─────────┬───────────┘
                                      │ RunRecord[]
                                      ▼
                            ┌─────────────────────┐
                            │  src/engine/        │  stats → signals →
                            │  classify.ts        │  classification → verdicts
                            └─────────┬───────────┘
                                      │ TestVerdict[]
              ┌───────────┬───────────┼───────────────┬──────────────┐
              ▼           ▼           ▼               ▼              ▼
        terminal.md   json.ts    markdown.ts      html.ts       quarantine/
        (CLI table)  (machine)   (PR comments,   (offline       (runner-flag
                                  redacted)       dashboard)    exclusions)

   driven by: src/cli (8+1 commands)  ·  src/runner (live execution)
              src/action (GitHub)     ·  src/doctor (setup checks)
```

## 5.3 The repository layout (every directory, one line)

```
flakefinder/
├── PLAN.md                  the spec of record (§5 = the algorithm contract)
├── TASKS.md                 build log, phase by phase
├── README.md                the product page
├── action.yml               GitHub Action definition (inputs/outputs/runtime)
├── dist/                    COMMITTED build output (the Action runs from here)
├── docs/                    this file, USAGE, BUILD_REPORT, QA_FINDINGS, CLOUD_SCALING
├── fixtures/                real jest/pytest/go projects with deterministic flakes
├── scripts/                 e2e harness, perf smoke, release automation
├── src/
│   ├── types.ts             THE frozen contract (all shared types)
│   ├── config.ts            config loading/validation/defaults + runner detection
│   ├── doctor.ts            the `doctor` setup checker
│   ├── parsers/             six report parsers + format sniffing
│   ├── store/               the JSONL history store
│   ├── engine/              statistics + the classification algorithm
│   ├── runner/              live execution + targeted re-run adapters
│   ├── quarantine/          quarantine entries + runner exclusion flags
│   ├── report/              terminal / json / markdown / html / gitlab
│   ├── cli/                 the command-line surface
│   ├── action/              GitHub Action entry + ingest + snapshot diffing
│   └── util/                test identity, glob matching, secret redaction
├── tests/parsers-fixtures/  real-shaped report files for parser tests
└── .github/workflows/       the repo's own CI + the release pipeline
```

---

# Part 6 — From atom to atom

This part explains every module the way a maintainer would: what it does,
why it is shaped that way, and the non-obvious decisions inside it.

## 6.1 The frozen contract — `src/types.ts`

Everything starts here. `types.ts` defines the shared vocabulary every other
module speaks, and the project treats it as a **contract**: changing it
requires updating PLAN.md and the tests in the same commit. The important
types, field by field:

### `TestCaseResult` — one test, one run

```ts
interface TestCaseResult {
  testId: string;        // stable identity (see 6.2)
  suite: string;         // grouping: file, describe-block, class, or package
  name: string;          // the test's own title
  status: TestStatus;    // 'pass' | 'fail' | 'skip' | 'error'
  durationMs: number | null;
  message?: string;      // failure message (truncated)
  stack?: string;        // stack trace excerpt (truncated)
}
```

Why a *normalized* shape? Because six different ecosystems describe the same
concept six different ways (`classname` vs `ancestorTitles` vs `className`
vs `Package/Test` vs suite nesting). The parsers' whole job is to flatten
their native formats into this one shape so the engine never cares where
data came from. `fail` vs `error` distinction: both are treated as the
"fail family" by the engine, but `error` is reserved for abnormal
terminations (exceptions, crashes) vs assertion failures where the format
distinguishes them.

### `RunRecord` — one execution of a report file

```ts
interface RunRecord {
  runId: string;         // shared across all retry attempts of one invocation
  timestamp: string;     // ISO 8601
  source: RunSource;     // 'live' | 'report' | 'action'
  parsedFrom: string;    // which parser produced it ('junit', 'jest', …)
  attempt: number;       // 1 = first execution; 2+ = a retry
  commitSha?: string;    // best-effort `git rev-parse HEAD`
  branch?: string;       // CI only
  ciRunId?: string;      // CI only
  results: TestCaseResult[];
}
```

The two most important fields are `runId` and `attempt`. When
`flakefinder run` re-executes a failing command, all attempts share one
`runId` and get `attempt = 1, 2, 3…`. That pairing is what makes **retry
rescues** detectable: attempt 1 failed, attempt 2 passed, same code.

### `TestVerdict` — the engine's output for one test

```ts
interface TestVerdict {
  testId: string; suite: string; name: string;
  classification: Classification;   // the label (see 6.6)
  tags: TestTag[];                  // 'slow' | 'recently-fixed' | 'long-unseen'
  flakeScore: number;               // 0–100
  confidence: number;               // 0–100
  passRate: number;                 // 0–1 over non-skip observations
  runsObserved: number;
  lastStatus: TestStatus;
  lastSeen: string;                 // ISO 8601
  lastMessage?: string;             // most recent failure message
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  sameShaFlips: number;             // evidence counters (see 6.6)
  retryRescues: number;
  directionChanges: number;
}
```

Everything the renderers display and everything quarantine decisions read is
in here. Verdicts are pure data — they can be serialized, diffed between
runs (the "new vs known flake" feature), and embedded in dashboards.

### The rest of the contract

`FlakefinderConfig` / `ResolvedConfig` (the user-facing settings and their
fully-defaulted form), `ReportParser` (the parser interface every format
implements: `name`, `sniff(content)`, `parse(content, path)`), `DashboardData`
(the dashboard's input contract), and constants like
`FLAKEFINDER_VERSION`. Also `RetryMode` (`'auto' | 'failed' | 'full'`) and
`RunnerKind` (`'auto' | 'pytest' | 'jest' | 'mocha' | 'go' | 'generic'`).

## 6.2 Test identity — `makeTestId` (`src/util/test-id.ts`)

The engine tracks tests *across runs*, so it needs a stable identity. The
obvious choice — the test's name — breaks when two files have a test with
the same title. The actual identity:

```
testId = sha256( normalize(suite) + "\0" + normalize(name) ).slice(0, 16)
```

- `normalize` trims and collapses whitespace, so `adds  numbers` and
  `adds numbers` are the same test.
- The NUL separator guarantees `("ab","c")` and `("a","bc")` hash differently.
- 16 hex chars (64 bits) is plenty to avoid collisions in any realistic
  suite, and keeps reports compact.

**Consequence (documented, accepted):** renaming a test or moving it between
files *forks its history* — the old id goes `gone`, the new id starts fresh.
That is honest (observably it *is* a new test) and the alternative — content
hashing of test bodies — is fragile and invasive.

## 6.3 The utilities

### `src/util/glob.ts` — the dependency-free matcher

Report locations are configured as glob patterns (`junit*.xml`,
`test-results/*.json`). Rather than pull in a glob library (runtime
dependency budget: two, see §6.10), the project ships a ~60-line matcher
supporting exactly what's needed:

- `**` crosses directories, `*` within one segment, `?` one character;
- a pattern without `/` matches at any depth (so `junit.xml` "just works");
- the walk **skips** `node_modules`, `.git`, `dist`, hidden dirs, and the
  store directory — both for speed and to avoid re-ingesting the store's own
  artifacts;
- walks happen **once per attempt** in `run` mode, deliberately: a walk is
  how *newly created* report files get caught (a walk-once optimization was
  evaluated and rejected for exactly this reason);
- symlinks/junctions are not followed — a deliberate cycle-safety trade-off,
  documented in USAGE.md.

### `src/util/redact.ts` — the secret redactor

Failure messages frequently contain leaked credentials (a test that hit a
real API with a token, an assertion that printed an env var). flakefinder's
rule: **the local store stays raw** (your machine, your debugging), but
everything that *leaves the machine* — PR comments, dashboards uploaded as
CI artifacts, JSON reports — passes through `redact()` first.

Ten pattern families, tuned by adversarial review:

- Vendor tokens: `ghp_…`, `github_pat_…`, `AKIA…` (AWS), `sk-…` (OpenAI),
  `xox…-` (Slack), `glpat-…` (GitLab), `npm_…`;
- JWT-shaped strings (three base64url segments);
- `Bearer …` / `Basic …` authorization headers;
- assignment forms: `SECRET_KEY=…`, `"api_key": "…"` (value must reach 12+
  chars so validation-error prose like `password: required field` survives).

Two hard-won subtleties: patterns deliberately have **no leading word
boundary** (tokens embed in test names like `Test_ghp_…` — a boundary would
miss them), and there is **no bare `token` keyword** (JSON error messages
legitimately contain "Unexpected token 1234567890123456789" — matching it
mangled diagnostics). Redaction is idempotent and applied *before* any
length truncation, so a token can never be split across a boundary and leak
partially.

### `src/util/test-id.ts`

Covered in 6.2.

## 6.4 The parser layer — `src/parsers/*`

Parsers are the translation layer between the messy real world of test
runners and the clean `TestCaseResult` shape. Six parsers ship, in registry
order: **junit, jest, mocha, go, tap, trx**.

### The two-method contract

Every parser implements `ReportParser`:

- **`sniff(content)`** — cheap, side-effect-free content inspection. Used by
  `detectParser(content)` to pick the right parser for a file *without
  trusting its extension*. This is why mixed report formats in one repo
  "just work."
- **`parse(content, sourcePath)`** — returns
  `{ results: TestCaseResult[], warnings: string[] }`.

**The iron rule: parsers never throw.** Malformed input — truncated XML,
garbage bytes, empty files, binary junk — produces partial results plus
human-readable warnings. History must never be the reason a CI job dies.
(This rule is enforced by tests that feed every parser deliberately broken
input.)

### 6.4.1 `junit.ts` — the JUnit XML family

JUnit XML is the *lingua franca* of test results — pytest writes it
(`--junitxml`), jest via jest-junit, Maven/surefire, vitest, dozens more.
One format, many dialects, which is why this is the most intricate parser:

- handles a `<testsuites>` root wrapping suites (pytest style), a bare
  `<testsuite>` root (Maven per-class files), and **arbitrarily nested**
  suite hierarchies;
- suite = the testcase's `classname` attribute when present, else the
  nearest enclosing suite's name;
- `<failure>` → `fail`, `<error>` → `error`, `<skipped>` → `skip` (failure
  wins if both are present);
- `time="0.456"` (seconds) → `456 ms`; garbage times (`NaN`, negative) →
  `null`;
- message/stack are harvested from the failure/error element, trimmed to
  2000/1000 chars;
- namespace prefixes are tolerated (`<x:testsuites xmlns:x="…">`) via
  prefix-insensitive element lookup — added after QA found prefixed JUnit
  was silently rejected;
- truncated files are detected (input not ending in `>`) and warned.

### 6.4.2 `jest.ts` — Jest and vitest JSON

Jest's `--json` output (and vitest's compatible reporter): an array of
`testResults` per file, each with `assertionResults` per test.

- status mapping: `passed` → pass, `failed` → fail, `pending`/`todo` →
  skip — **and `skipped` → skip**, because vitest emits `skipped` where jest
  emits `pending` (a QA-round-2 catch: without it, vitest users lost every
  skipped test);
- suite = `ancestorTitles.join(' > ')` when present, else the file path
  (forward-slashed for cross-platform stability);
- suite-level failures (a file that failed to even load) are preserved as a
  synthetic `'(suite)'` test so the failure isn't silently lost.

### 6.4.3 `mocha.ts` — the JSON reporter

Mocha's reporter outputs flat arrays of test objects plus `passes`/`failures`/
`pending` arrays. Status is derived by membership (a test in both `pending`
and `passes` is a skip — pending wins). Suite = the describe chain
(fullTitle minus title) with the file path as fallback. Tolerates both the
documented `tests` array and the `results` shape some wrappers emit.

### 6.4.4 `gotest.ts` — `go test -json`

Go streams one JSON object per line (NDJSON): `run`/`output`/`pass`/`fail`/
`skip`/`pause` events per test, plus package-level events.

- status = the test's **last terminal event** (pass/fail/skip), duration
  from that event's `Elapsed` (capitalization varies across Go versions —
  both spellings accepted);
- output events are harvested per test: ANSI color codes stripped, blank
  lines dropped, the **last** 2000 chars kept (failure detail comes *after*
  `t.Log` noise);
- **crash coverage (v0.2+):** a test that got a `run` event but never a
  terminal event (the binary panicked/OOM'd/was killed) is synthesized as an
  `error` result with "test started but never reported a result" — instead
  of silently vanishing;
- **package-level failures:** a package that failed to *build* emits no test
  events at all — synthesized as a `(package)` error result, so a build
  break shows up in verdicts rather than as a mysterious "no results";
- output-only events for unknown tests (a stream missing its head) invent
  nothing — no phantom tests.

### 6.4.5 `tap.ts` — TAP and `node --test`

TAP (Test Anything Protocol) is a line-based text format — the native
`--test-reporter=tap` output of Node's built-in runner, also emitted by
Perl's Test::More and others. Verified against **real node 22 output**:

- `# Subtest: NAME` lines open tests, nested by indentation;
- `ok N - NAME` / `not ok N - NAME` close them;
- **the nesting problem:** in node's output, *every* test's assertion
  repeats its own name — children first, then the parent's aggregate
  ("1 subtest failed"). If both were emitted, every failure would
  double-count in the engine. The parser keeps a stack of open declarations
  **with a children counter each**, and treats a closing assertion as a
  suite-aggregate (suppress, pop, credit the child count upward) when the
  block carries `type: 'suite'` *or* children were already emitted beneath
  it. This handles both `describe()` suites and `t.test()`-style parents
  (which node does *not* mark with the type field — found by QA with a real
  fixture);
- `# SKIP reason` / `# TODO` directives → `skip` with the reason as message;
- YAML blocks between `---` and `...` are mined for `error:` (message) and
  `stack: |-` (stack);
- suite = the ancestor chain joined by ` > `; root-level tests get
  `node:test` (TAP carries no file names).

### 6.4.6 `trx.ts` — .NET TRX

Visual Studio / `dotnet test --logger trx` output: a `<TestRun>` containing
`<TestDefinitions>` (where `TestMethod/@className` lives — that's the suite)
and `<Results>` with `UnitTestResult` elements.

- `outcome="Passed|Failed|NotExecuted"` → pass/fail (error when the failure
  carries `ErrorInfo`)/skip;
- durations are `HH:MM:SS.fraction` TimeSpans, parsed to ms;
- message/stack come from `Output/ErrorInfo`.

### 6.4.7 `index.ts` — sniffing and the registry

`parsers` is the ordered registry; `detectParser(content)` walks it and
returns the first parser whose `sniff` claims the content, or `null` (the
file is skipped with a warning). The sniffs are mutually exclusive by
construction (JUnit XML starts with `<` + `testsuit`, TAP starts with
`TAP version N`, the JSON shapes are structurally distinct, TRX has
`<TestRun>`), which QA verified cross-wise: every fixture is claimed by
exactly one parser.

`internal.ts` holds shared parser helpers (`stripBom`, `stripAnsi`,
`trimTo`, `toArray`, `isObj`) — including the BOM stripper, because
Windows tooling loves to prepend byte-order marks.

## 6.5 The history store — `src/store/history-store.ts`

### The format

One JSON object per line (JSONL) at `.flakefinder/history.jsonl`:

```
{"version":1}
{"runId":"9f0c…","timestamp":"2026-10-26T10:20:44.101Z","source":"live",
 "parsedFrom":"jest","attempt":2,"commitSha":"1a2b3c…","results":[…]}
```

- **Why JSONL?** Appends are one-line writes (cheap, crash-tolerant), the
  file is `cat`/`grep`-able by humans, and each line is independent — one
  corrupt line never poisons the rest. A relational store was evaluated and
  rejected (Part 8).
- **The `{"version":1}` header** (first line) stamps the on-disk schema so
  future versions can migrate safely. Readers tolerate legacy header-less
  files from v0.1.x and warn when a store is *newer* than the running CLI.
- **Every line is validated on load:** schema markers in wrong positions
  (merged cache writes), partial records, and garbage are skipped with
  warnings (capped at 10) — never fatal. This invariant is in the class's
  doc comment: *history must never be the reason a CI run dies.*

### The advisory write lock

Two CI matrix shards finishing simultaneously can both append — and
multi-kilobyte appends can interleave mid-line, corrupting the store. The
fix is an advisory lockfile (`history.jsonl.lock`, created with
exclusive-create semantics):

- held only for the duration of a write (append or prune);
- acquisition busy-waits in ≤50 ms slices for up to 2 s, then fails with an
  actionable message ("run ingest steps serially, or give each CI shard its
  own storeDir");
- a lock older than 30 s is presumed abandoned by a dead process and stolen;
- released in a `finally`, always.

Adversarial QA verified: five simultaneous ingest processes, eight rounds —
zero corrupted lines, lock always cleaned up. And then found the hole the
lock alone didn't close (see prune, below).

### Prune — and the fresh-read lesson

The store is capped at the last `maxRuns` runs — distinct runIds, so a run's retry
attempts are kept or dropped together (default 300). Pruning rewrites the
file atomically (write `.tmp`, rename over the original). The subtle bug QA
found: prune originally rewrote from the **in-memory** records, which were
loaded at process start — under concurrency, records another process had
appended in the meantime were silently deleted by the stale rewrite (10/10
reproductions). The fix: **prune re-reads the file fresh inside the lock**
and rewrites from that state, resyncing memory; the "should I prune at all"
check also uses the fresh count now. The regression test seeds a store with
one instance, appends with a *second*, then prunes with the *first* — the
freshly-appended record must survive.

## 6.6 The detection engine — `src/engine/*`

This is the heart. Two files: `stats.ts` (tiny, exact) and `classify.ts`
(the algorithm). PLAN.md §5 is the contract; `classify.test.ts` pins it
with table-driven tests that read like the spec.

### 6.6.1 Statistics

- `median` — even counts average the middle two.
- `p95` — nearest-rank method (sort ascending, take element
  `ceil(0.95·n)`), the standard for latency-style data.
- `durationStats` — median/p95 over a test's defined durations.

### 6.6.2 Preprocessing: what counts as an observation

From all runs, one `TestHistory` per testId is built, observations ordered
chronologically. Three normalization rules matter:

1. **Skips are excluded from all flake math** (a skipped test tells you
   nothing about flakiness) but still count for `lastStatus`.
2. **Collapse per (runId, attempt):** if a report lists the same test twice
   (rerun plugins do this), the *last* observation for that attempt wins.
   `runsObserved` counts attempts, not lines.
3. **runId-grouped ordering:** records are ordered chronologically with all
   records of one `runId` kept *contiguous*, attempts ascending, groups
   ordered by their earliest timestamp. The naive (timestamp, attempt) sort
   was a real bug: with same-second timestamps across different runIds, a
   retry pair got split by an interleaved record and the rescue vanished.
   (Found by hand-verification against the spec in QA round 4; see Part 9.)

### 6.6.3 The three signals

For each test, over its collapsed, ordered, non-skip observations:

**`sameShaFlips`** — the count of distinct commit SHAs that observed *both*
families. This is the strongest evidence that exists: identical code,
different outcomes. One flip is proof; the count itself matters less than
its existence.

**`retryRescues`** — consecutive attempt pairs (k fail → k+1 pass) within
one `runId`. The instant-mode signal: the retry loop itself proved the test
can pass without a code change.

**`directionChanges`** — over distinct *code states* (commit buckets when
SHAs exist; per-run buckets when they don't — so projects outside git still
get statistical detection), how many times the outcome family toggled:
fail→pass→fail. Two or more flips is suspicious but not proof.

### 6.6.4 Classification — the precedence ladder

First matching rule wins:

| # | Class | Condition |
|---|---|---|
| 1 | `gone` | seen historically, absent from the last 30 runs |
| 2 | `skipped` | every observation was a skip |
| 3 | `flaky-confirmed` | `sameShaFlips > 0` |
| 4 | `flaky-retry` | `retryRescues > 0` |
| 5 | `flaky-suspected` | `directionChanges ≥ 2` AND `runs ≥ minRuns` AND both families seen |
| 6 | `failing` | last (≤5) observations all fail-family AND `runs ≥ minRuns` |
| 7 | `new-failure` | last observation failed (not enough data for anything stronger) |
| 8 | `passing` | everything else |

Design notes: `gone` before everything (no evidence, no claims — a test
absent for 30 runs has no business in today's verdict). `flaky-confirmed`
above `flaky-retry` because same-commit proof outranks retry proof (in a
git repo, every retry rescue is *also* a same-sha flip — precedence
promotes to the stronger signal; `flaky-retry` surfaces only where SHAs are
absent). `failing` requires `minRuns` so one bad run on a brand-new test
is `new-failure`, not a verdict.

### 6.6.5 Flake score — the arithmetic

Only computed when **both families** have been observed (a test that never
passed has score 0 — it's broken, not flaky):

```
score = min(100, round(
    min(50, 50 · sameShaFlips)          ← capped at 50
  + min(40, 40 · retryRescues)          ← capped at 40
  + min(24, 8 · directionChanges · recency)
  + (runsObserved ≥ 10 ? 10 : 0)        ← data-volume bonus
))
```

`recency` dampens stale evidence: the most recent failure ≤14 days old →
×1.0, ≤30 days → ×0.6, older → ×0.3. A flake from six months ago that
never recurred shouldn't outrank last night's.

Worked example: a test with 1 same-commit flip (50), 1 rescue (40), 3
direction changes fresh (24) → 114 → capped **100**. A test with only
flip-flops: 3 changes fresh → 24. Ten runs of a 50%-pass test with one
flip: 50 + 0 + 10 = 60.

### 6.6.6 Confidence

Separate 0–100 answering "how sure am I?" — deliberately lower than the
score for evidence-thin verdicts:

| class | confidence |
|---|---|
| flaky-confirmed, flaky-retry | 100 (direct proof) |
| flaky-suspected | min(70, round(35 · runs ÷ minRuns)) — evidence-limited |
| failing | min(95, 25 + 5 · trailing-fail-count) |
| new-failure | min(50, 10 + 5 · total-fail-count) — one red run is not a diagnosis |
| passing / skipped / gone | 100 (the claim is "nothing to see", which the data fully supports) |

### 6.6.7 Tags

Three orthogonal flags: **`slow`** (median above `slowThresholdMs`, or p95
more than `slowMultiplier`× the suite's own median — suite-relative so a
100ms test in a 5ms suite gets flagged but in a 500ms suite doesn't);
**`recently-fixed`** (failed in the first half of history, clean for the
last 5 — a candidate for un-quarantining); **`long-unseen`** (absent from
the last 30 runs, co-occurs with `gone`).

### 6.6.8 The verdict assembly

All of the above assembles into one `TestVerdict` per test — including
`lastMessage` (from the latest fail-family observation, so reports can show
*why*) and the duration statistics. The slow tag is applied in a second
pass because it needs the *suite-wide* median context.

## 6.7 The runner — `src/runner/wrap.ts` + `adapters.ts`

`runLive(command, cfg, opts)` is the `flakefinder run` implementation. The
full walk-through:

1. **Snapshot** the report globs: walk once, record size+mtime per file, and
   sha256 only for files that need it (stat-first — unchanged files skip the
   hash on later attempts). This pre-run snapshot is what distinguishes
   *stale* reports (from a previous job — ignored) from this run's output.
2. **Spawn attempt 1.** The command runs with `stdio: 'inherit'` so the user
   sees their own test output live, in color, unfiltered.
3. **Re-snapshot and ingest:** files that are new or changed are parsed and
   recorded as `attempt N` records. **Retry attempts (2+) re-record all
   matched reports** even when byte-identical — the command ran again, so
   the report state is a new observation (a fail-fail-pass sequence with a
   deterministic report must be detected as a rescue; found by QA).
4. **Retry until `retries+1` attempts or an exit 0.**
5. **Persist and classify:** append all attempt records (locked), prune,
   classify, and restrict the printed verdicts to tests observed *in this
   invocation* (full history is still persisted).
6. **Exit code** per the contract in 3.2 — with the rule that a rescued
   flake exits 0, a persistent failure exits 1, and usage errors exit 2.

### The spawn strategy (harder than it sounds)

Cross-platform process spawning with *injected arguments* (quarantine
patterns, targeted selectors) is a minefield. The current model, hardened
through three QA rounds:

- **No shell by default.** Arguments pass verbatim — a pattern like
  `^(?!.*(?:my flaky test))` arrives as ONE argument, spaces intact. No
  quoting hazard exists in this mode.
- **Shell mode fallback** when the command contains operator *tokens*
  (`>`, `|`, `&&` — matched as whole tokens, so a user value like
  `w1&&w2` doesn't trigger it) or when the direct spawn is refused —
  Windows blocks `.cmd` shims like npm without a shell (EINVAL, since the
  2024 command-injection fix). In shell mode **every token is quoted except
  the operators themselves** — user values and injected patterns alike
  survive cmd.exe's metacharacter eating.
- **Abandoned-spawn guard:** when the direct spawn fails and falls back to
  shell, the first spawn's events are ignored so its exit code can't race
  the real run.
- **npm/yarn/pnpm wrappers get a `--` separator** before injected flags —
  package managers swallow flags themselves and only forward what follows
  `--` to the actual test runner. (Before this fix, quarantine *announced*
  it was active while the flags never reached jest. A silent lie — the worst
  kind.)

### Targeted re-runs (`src/runner/adapters.ts`)

Retrying a failing 20-minute suite three times costs an hour. Targeted
re-runs make attempts 2+ execute **only the failed tests**:

| runner | selector | notes |
|---|---|---|
| jest / vitest | `-t "^(?:.* )?(?:name1\|name2)$"` | boundary-anchored: `update` doesn't drag in `math re-update`; works for both jest and vitest |
| mocha | `--grep` (same pattern shape) | |
| go | `-run "^(TestA\|TestB)$"` | subtests (`TestX/sub`) rerun via their top-level parent |
| pytest | `--lf` | pytest's own last-failed cache |

Selected names are space-delimited-final-segment matched, regex-escaped,
deduped, and quarantined names are excluded from the selector (a suffix
collision can't pull a benched test back in). Falls back to a full re-run
when the runner has no adapter or attempt 1 recorded no per-test failures.
Controlled by `--retry-mode auto|failed|full` (default `auto`). Documented
caveat: order-dependent flakes may not reproduce in a targeted run —
`full` restores whole-suite retries. Correctness is unaffected either way:
a test only counts as flaky when it explicitly *passes* on a re-run, so an
empty or partial re-run can never fake a rescue.

### Timeouts and signals (C2)

`--timeout <seconds>` / `timeoutSeconds` config: an attempt exceeding the
limit gets its **whole process tree** killed (Windows: `taskkill /T /F` —
`child.kill()` only reaches the direct process, and cmd.exe chains survive
it; POSIX: SIGTERM with a 3 s SIGKILL escalation) and resolves exit 124,
the GNU-timeout convention. SIGINT/SIGTERM (Ctrl-C): kill the current tree,
stop the retry loop, keep everything ingested so far, exit 130.

## 6.8 Quarantine — `src/quarantine/manager.ts`

Quarantine = benching a flaky test: excluded from runs while someone fixes
it properly, without ever editing test source.

- **The list:** `flakefinder.quarantine.json` —
  `{ "version": 1, "entries": [ { testId, suite, name, reason,
  quarantinedAt, flakeScore } ] }`. Human-readable, git-committable,
  deletable.
- **Enforcement:** `run` consults the list (unless `--no-quarantine`) and
  appends runner-native exclusion flags: pytest `--deselect
  "suite::name"` per entry; jest `-t` / mocha `--grep` with a negative
  lookahead `^(?!.*(?:name1|name2))` (names regex-escaped, deduped — this
  lives in the same insertion machinery as targeted selectors, so the
  flags land on the runner's segment even in shell commands, after `--`
  for npm wrappers); **go/generic: none** — `go test` has no per-test
  exclusion, so entries are tracked and reported, never auto-applied, and
  the tool says so.
- **The conservative prune policy** (the subtle design decision): a
  quarantined test is *excluded* from runs, so "not seen lately" is exactly
  what quarantine looks like when it's working. Treating absence as health
  would silently un-quarantine the entire list. Therefore an entry leaves
  quarantine only on **positive evidence** — the test ran (quarantine
  disabled or a full-suite run) and passed stably across ≥10 observations —
  or when the test is `gone` and the entry is older than 90 days. Empty
  history → no-op.

## 6.9 The report layer — `src/report/*`

Four renderers, all consuming the same `TestVerdict[]`:

### `terminal.ts` — the CLI table

Sections per problem class (`FLAKY (confirmed)` → `NEW FAILURE`), one row
per test (score, confidence, runs, pass-rate, median, `suite :: name`,
tags), an `ok:` summary line, and **next-step hints** — including the exact
`quarantine add <id>` command for the worst offender. Receives the FULL
verdict set (filtered inputs would make the "N tracked / ok:" counts lie)
and optionally hides below-threshold suspected flakes *with an explicit
"N hidden" note* — never silently. The empty state is onboarding text; a
filtered-to-zero state still shows the honest counts.

### `json.ts` — the machine format

`{ generatedAt, flakefinderVersion, config, verdicts }` — stable field
order, pretty-printed, safe to pipe into `jq`. Written by `ci` and the
Action as `flakefinder-report.json`. Free-text fields are redacted (this
file is routinely uploaded as a CI artifact).

### `markdown.ts` — PR comments

`buildPrComment(verdicts, previous)` builds the GitHub/GitLab comment:
a hidden marker line (`<!-- flakefinder:report -->`) that makes the
comment **upsertable** (the action finds it and edits — never duplicates),
a summary line (`**3 flaky** (1 new · 2 known) · 1 failing · 412
tracked`), a table with a **Δ column** (new / ↑12 / ↓30 / = versus the
previous snapshot), and `<details>` blocks for up to 5 new flakes with the
redacted failure message and the exact quarantine command. Table cells
escape pipes and newlines; messages are redacted before truncation.

### `html.ts` — the dashboard

One self-contained HTML file, zero network requests, dark theme by default
with a light toggle persisted to localStorage. Sections: summary chips
(click to filter), a runs strip chart (last 50 runs), a sortable/filterable
tests table (score bars, badges, tag chips — **render-capped at 500 rows
with a click-to-show-all** so a 10,000-test suite stays smooth), and a
detail drawer per test (score/confidence bars, pass-rate donut, evidence
tiles, failure message, quarantine command with copy button).

Security model: data is embedded in a `<script type="application/json">`
block with `</script` and `<!--` escaped (an HTML parser cannot be
tricked into breaking out); all dynamic rendering goes through
`textContent`, never `innerHTML` with interpolated strings. Verified by
tests that feed hostile names (`</script><script>alert(1)</script>`) and
by QA at 10,000-test scale (0.35 MB, parses clean).

### `gitlab.ts` — GitLab MR notes

On GitLab CI (detected via `GITLAB_CI` + `CI_API_V4_URL` +
`CI_PROJECT_ID` + `CI_MERGE_REQUEST_IID` + a user-provided `GITLAB_TOKEN`),
`flakefinder ci` upserts one marker-scoped merge-request note through the
plain REST API — same never-duplicate pattern as GitHub, failures are
warnings that never fail the job, and the whole client is tested with an
injected `fetch`.

## 6.10 Configuration — `src/config.ts`

- **Discovery:** `flakefinder.config.json` (JSONC allowed — comments and
  trailing commas, BOM tolerated) found by walking up from `--cwd`
  (≤3 levels), or forced via `--config <path>`.
- **Validation (the trust fix):** every key is type- and range-checked on
  load; unknown keys and wrong-typed values (including wrong-case runner
  values, with a "did you mean" hint) fail fast listing **all** problems.
  Before this existed, `runner: "Jest"` silently fell back to `generic` —
  which quietly disables quarantine. Wrong-typed configs fail loudly now.
- **Defaults** (full table in Part 10): storeDir `.flakefinder`,
  maxRuns 300, minRuns 3, liveRetries 2, flakeScoreThreshold 30,
  slowThresholdMs 10000, slowMultiplier 5, runner auto, retryMode auto,
  timeoutSeconds null.
- **`detectRunner(cwd)`** — best-effort detection from project markers
  (package.json deps/scripts → jest/mocha, with vitest mapped to jest
  because its JSON output is jest-shaped; pyproject/pytest.ini → pytest;
  .mocharc → mocha; go.mod → go; else generic). Used by `init` and by
  `run` when `runner: "auto"`.

## 6.11 The CLI — `src/cli/index.ts`

Commander-based, eight commands plus `doctor`:

| command | what it does |
|---|---|
| `init` | detect runner, write a starter config, print the exact reporter-setup snippet for that runner; refuses to overwrite without `--force`; validates `--runner` |
| `run` | live execution with retry detection (6.7) |
| `ingest` | parse report files into history (explicit files or configured globs); `--attempt`, `--source`, `--run-id` for CI artifact workflows |
| `report` | verdicts from history — `--format table\|json\|md`, `--flakes-only`, `--all`, `--threshold` |
| `html` | generate (+`--open`) the dashboard |
| `quarantine` | `list / add / remove / prune` |
| `ci` | CI one-shot: ingest globs → table → `::warning` annotations → JSON report → snapshot diff (`--fail-on-new-flakes` gate) → GitLab MR note when on GitLab |
| `doctor` | setup checks (6.12) |
| `version` | the version |

Global flags: `--cwd` (where everything resolves), `--config` (explicit
config path), `--no-color`. Exit-code contract: `0` clean/flakes-only,
`1` real failure / gate triggered / doctor FAIL, `2` usage or environment
errors. `--help` on every command documents every flag.

## 6.12 `flakefinder doctor` — `src/doctor.ts`

One command that answers "is my setup wired?" — the difference between a
five-minute fix and an hour of guessing. Checks, each with status and hint:

1. config found / valid (validation errors surfaced verbatim);
2. runner detected (and whether config pins it);
3. report globs actually match files (with a sample list) — the #1 setup
   mistake;
4. history: exists? how many runs? size? corrupt-line count? last run age
   (warns after 7 days: "is CI actually calling it?");
5. git metadata available (same-commit flip detection depends on it);
6. quarantine present/healthy (a corrupt file is reported as FAIL — doctor
   must never crash on the things it diagnoses; found by QA).

Exit 1 when any check FAILs — CI and setup scripts can gate on it.

## 6.13 The GitHub Action — `action.yml` + `src/action/*`

The Action is the same pipeline, wired into GitHub's machinery:

1. **Context from environment** (no octokit in our code — three REST calls
   with plain `fetch` cost less than the megabytes of SDK): repo, sha,
   branch, run id, PR number parsed from `GITHUB_EVENT_PATH`.
2. **History cache:** `.flakefinder/` is persisted with `actions/cache`,
   one *stream* per job + `working-directory` + `history-key` (the latter
   defaults to `${{ toJSON(matrix) }}`, so matrix legs stay apart). The
   stream id is a short hash of those three. Saves go to
   `flakefinder-history-<stream>-<sha>-<run id>-<run attempt>`: cache
   entries are immutable, so every run *attempt* needs its own key or a
   re-run's history would be dropped. Restores go by the prefix
   `flakefinder-history-<stream>-` (newest on this branch, then the base or
   default branch), falling back to any `flakefinder-history-` entry as a
   warm start for a brand-new stream. No external service holds your data.
3. **Ingest + classify** (same engine).
4. **New-vs-known diff:** the previous run's verdicts were snapshotted to
   `verdicts-snapshot.json` in the cache; `computeNewFlakes(current,
   previous)` separates flakes the repo has *never seen* from known ones.
   Each run records the baseline it used (with its run id) in
   `action-baseline.json`, so a re-run of the same workflow run compares
   against the same baseline instead of its own first attempt's snapshot
   (otherwise "Re-run failed jobs" would pass the gate).
   `computeFixedFlakes` does the inverse for the report. Fresh snapshot
   written for next time.
5. **Outputs** (`flaky-count`, `new-flaky-count`, `failing-count`,
   `report-json`) for downstream workflow steps.
6. **Step summary + PR comment** (upsert via marker, plain fetch, token
   from `github-token` input).
7. **Dashboard artifact** uploaded via the official artifact client.
8. **Fail gate:** `fail-on-new-flakes: true` fails the job only when a flake
   that was *not flaky in the previous run* appears — known flakes never
   block anyone.

Inputs (`reports`, `github-token`, `comment`, `upload-dashboard`,
`fail-on-new-flakes`, `history-max-runs`, `working-directory`,
`history-key`) are documented in docs/github-action.md and match
`action.yml` 1:1. The flow lives in `runAction()` (`src/action/main.ts`)
with the environment, `@actions/core`, cache, artifact upload, glob and
`fetch` injected, so it is tested end to end without a runner;
`src/action/index.ts` only wires the real services in.

**The runtime details that bit:** the Action executes
`dist/action/index.cjs` on `node24` — **committed to the repo** (GitHub
runs the file from source, not from npm). It must be CommonJS (the
`@actions/*` packages are CJS; an ESM bundle dies with "Dynamic require"
at runtime), it must bundle *every* dependency (a checked-out action has
no `node_modules`; tsup externalizes package.json `dependencies` by
default, which once left `require("fast-xml-parser")` in the bundle), and
it must be rebuilt+committed after every source change — the repo's CI has a
dist-freshness gate that fails if a fresh rebuild differs from what's
committed.

## 6.14 GitLab support

`flakefinder ci` is CI-agnostic (annotations + exit codes + JSON report
work anywhere). On GitLab specifically, with the user's variables set, it
additionally upserts the MR note (6.9) — full recipe in docs/USAGE.md.

## 6.15 Build and release machinery

- **Build:** `tsup` bundles the CLI (`dist/cli.js`, single ESM file with a
  shebang, ~115 KB) and the Action (`dist/action/index.cjs`, CJS).
  Runtime dependencies: exactly two (`commander`, `fast-xml-parser`),
  bundled in — the published tarball is ~90 KB and installs in seconds.
- **Release:** `node scripts/release.mjs 1.2.0 --push` bumps the version in
  *both* places (package.json + `FLAKEFINDER_VERSION` in types.ts — a
  two-location trap the script exists to prevent), inserts a CHANGELOG
  stub, runs the full pipeline, rebuilds dist, commits, tags, pushes.
  The `release` workflow then publishes to npm with provenance when the
  `NPM_TOKEN` secret is configured and opens a GitHub Release.

---

# Part 7 — How it's tested

The quality machine has five layers, each catching what the previous
can't:

1. **Unit tests (261, colocated `*.test.ts`):** the engine's classification
   rules are *table-driven* — one test per precedence rule, per score cap,
   per recency tier — so `classify.test.ts` reads like PLAN §5. Parsers are
   tested against **fixture files shaped like real tool output** (including
   a real `node --test` capture and a deliberately malformed corpus — every
   parser must warn, never throw).
2. **Integration tests:** `runLive` is tested by spawning REAL node child
   processes that write REAL report files with counter-based deterministic
   flakes, and asserting the rescue is detected — including nasty variants
   (byte-identical retry reports, quarantine flag forwarding through npm,
   timeouts that kill process trees).
3. **End-to-end (`scripts/e2e.mjs`):** runs the built CLI against three
   actual projects — a jest package, a pytest project, a Go module — each
   containing a stable test, a deterministic failure, a counter-flake, and
   a slow test. Asserts exit codes, classifications, dashboard generation,
   and the quarantine round-trip. Flakes in the fixtures are
   **deterministic by counter parity** — no `Math.random()` anywhere near
   CI, so the test suite itself cannot be flaky (that would be embarrassing).
4. **Performance smoke (`scripts/perf-smoke.mjs`, wired into CI):**
   regenerates a worst-case store (300 runs × 500 tests = 150,000
   observations, ~13 MB) and asserts `report` and `html` stay under budget
   — currently ~90 ms each. A regression here fails CI loudly.
5. **Coverage gates (in CI):** ≥85% lines on `src/engine`, `src/parsers`,
   `src/store` — the correctness-critical core.

Beyond the automated layers, four rounds of **adversarial QA** (black-box
agents attacking the built CLI from scratch directories — Part 9) found the
bugs that tests didn't: wrong results under concurrency, silent feature
failures, exit-code lies, and documentation drift.

---

# Part 8 — Design decisions and rejected alternatives

Every significant choice, with its reasoning — so future contributors don't
relitigate and past-me's mistakes stay visible:

| Decision | Why | What was rejected |
|---|---|---|
| JSONL store, not SQLite | 150k observations classify in ~90 ms; JSONL is append-cheap, human-readable, git-inspectable, zero-dependency | SQLite/Level (extra native deps for no measurable gain) |
| No shell when spawning | argv passes verbatim; quarantine patterns with spaces can't be mangled | always-shell (caused the flag-splitting bug class) |
| Runtime deps = 2 | `commander` + `fast-xml-parser`, bundled single-file | zod (validation is 80 hand-rolled lines), glob libraries, chalk |
| Redact at the boundary, not in the store | local debugging needs raw evidence; only *outbound* surfaces redact | redact-at-ingest (would corrupt the store) |
| Name-based targeted selectors, not cache-based (`--onlyFailures`) | works identically for jest AND vitest; no dependency on runner cache state | cache flags (vitest doesn't have them) |
| Conservative quarantine prune | excluded tests can't prove health; absence ≠ health | auto-unquarantine on staleness (would silently release everything) |
| Commit `dist/` | the GitHub Action executes the file from the repo | npm-only distribution (Actions can't depend on published packages reliably) |
| CJS bundle for the Action | `@actions/*` are CommonJS; ESM dies at runtime with "Dynamic require" | ESM everywhere |
| Walk report globs every attempt | catches newly created report files | walk-once caching (rejected — it misses them) |
| Default threshold 30, not 40 | `flaky-suspected` scores cap at 34; a 40 default made the class invisible | keeping the documented-but-dead 40 |
| TAP suite-aggregate suppression by children-count | node marks only `describe()` suites with `type: 'suite'`; `t.test()` parents double-emitted otherwise | YAML-marker-only suppression |
| Watch mode / daemon | rejected outright | violates the run-and-exit, local-first contract |

---

# Part 9 — QA war stories (real bugs, what they teach)

Four rounds of adversarial testing found bugs that unit tests, e2e, and
even careful design review missed. Each is a small lesson in distributed
systems, shell semantics, or product honesty:

1. **The lying quarantine (v0.2.1).** `run` printed "quarantine active" while
   the flags never reached jest — npm swallows flags without `--`, and the
   pattern was split at its first space by the shell. *Lesson: the boundary
   between your tool and the user's toolchain is where bugs live; test the
   boundary end-to-end, not just your half.*
2. **The blind engine (v0.2.1).** Outside a git repo, flip-flop detection
   counted only commit-buckets — of 143 genuinely flaky tests, zero were
   flagged, and half displayed as `passing` with a 50% pass rate. *Lesson:
   optional metadata needs fallback paths, and "the feature works" must
   mean "works in every configuration the docs allow."*
3. **The dead threshold (v0.2.0).** Default `flakeScoreThreshold` was 40,
   but `flaky-suspected` scores cap at 34 — the class could never appear.
   *Lesson: compute the reachable value range of every tuned constant.*
4. **The stale prune (v1.1.1).** Under concurrent writers, prune rewrote
   the store from a process-start snapshot, deleting another process's
   confirmed append — 10/10 reproductions. *Lesson: a lock serializes
   operations; it does not make stale reads fresh. Re-read inside the
   critical section.*
5. **The split retry pair (v1.1.1).** With same-second timestamps, the
   (timestamp, attempt) sort interleaved another run's attempt-1 record
   between a retry pair — the rescue vanished, the flake went unflagged.
   *Lesson: orderings need domain semantics (keep runId groups contiguous),
   not just lexicographic tiebreaks.*
6. **The ESM bundle that couldn't (v0.1.1).** The Action's ESM build died
   at runtime: `@actions/*` are CommonJS. *Lesson: target the runtime's
   module system, not the language's newest default.*
7. **The exec bit (v0.1.1 CI).** Windows git cannot store the executable
   bit; the Linux rebuild marked `dist/cli.js` +x and the freshness gate
   failed. *Lesson: cross-platform repos need `git update-index
   --chmod=+x` rituals for executable artifacts.*
8. **The doctor that crashed (v1.1.1).** A corrupt quarantine file made the
   *diagnostics command* throw. *Lesson: the checker must be more robust
   than the thing it checks.*

Each fix carries a regression test named after the finding.

---

# Part 10 — Configuration reference

`flakefinder.config.json` (JSONC allowed). All keys optional, all
validated. Full prose reference: docs/USAGE.md.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `reports` | `string[]` | `[]` | globs for report files |
| `storeDir` | string | `.flakefinder` | history directory |
| `maxRuns` | int 1–100000 | `300` | history retention (runs) |
| `minRuns` | int 1–1000 | `3` | observations before statistical claims |
| `liveRetries` | int 0–10 | `2` | extra attempts for `run` |
| `flakeScoreThreshold` | int 0–100 | `30` | inclusion bar for `flaky-suspected` |
| `slowThresholdMs` | number\|null | `10000` | absolute slow-test bar |
| `slowMultiplier` | number > 0 | `5` | relative slow bar (× suite median) |
| `quarantineFile` | string | `flakefinder.quarantine.json` | quarantine list location |
| `runner` | enum | `auto` | `auto\|pytest\|jest\|mocha\|go\|generic` |
| `failOnFlakes` | boolean | `false` | flakes exit non-zero |
| `retryMode` | enum | `auto` | `auto\|failed\|full` — targeted re-runs |
| `timeoutSeconds` | number\|null | `null` | per-attempt wall-clock kill |

---

# Part 11 — The cloud plan

flakefinder is local-first by design, and that stays. But local history
can't answer org-wide questions ("which team owns the flakiest suites?",
"show me flake trends for the last quarter"). The researched, staged plan
(full analysis: docs/CLOUD_SCALING.md):

**Stage 1 — Extract `@flakefinder/engine`.** The classification engine
becomes a shared workspace package consumed by the CLI and the future
server. One tested engine everywhere; no behavior change.

**Stage 2 — A hosted history store (the first real product).** One
endpoint: `POST /v1/ingest` accepting the exact `RunRecord` JSONL the CLI
already produces (the store schema versioning from 0.2.0 was done
precisely to enable this). Repo-scoped write-only ingest tokens; the
GitHub Action gains a `cloud-token` input and uploads in the background —
classification still happens in the Action, the server accumulates and
re-classifies for dashboards using the same engine. Failure to upload is a
warning, never a broken build.

**Stage 3 — Hosted dashboards + org views.** The dashboard renderer is a
pure function — serve its output from stored runs. Org rollups, trends,
CODEOWNERS-based ownership mapping.

**Stage 4 — A GitHub App** for read-side enrichment (check-run
annotations at scale, auto-quarantine suggestions, org installs) — the
Action remains the write-side worker.

**Stage 5 — Self-hosted image** (server + Postgres in docker compose) for
teams whose data can't leave their network. This tier keeps the OSS story
honest.

Key choices already made: managed Postgres with JSONB run-blobs (the JSONL
shape maps directly; ClickHouse deferred to Datadog scale), redaction
before upload with the store-stays-raw principle preserved (the *server*
never sees what the Action doesn't send), per-token rate limiting and
idempotent ingest keys (CI retries must not double-count), purge/export
APIs from day one. Pricing sketch: free single-repo tier, team tier
anchored against BuildPulse/Trunk, flat self-hosted tier.

---

# Part 12 — Glossary

| Term | Meaning |
|---|---|
| **test** | A small program that checks real software automatically. |
| **assertion** | The check inside a test; failing it fails the test. |
| **test runner** | The program that executes a suite (jest, pytest, go test, …). |
| **test suite** | A project's complete collection of tests. |
| **CI (Continuous Integration)** | Robots that run the whole suite on every code change; green = safe to merge. |
| **GitHub Action** | A reusable CI robot recipe installable with one `uses:` line. |
| **pull request (PR)** | A proposed change, gated by the CI traffic light. |
| **exit code** | The numeric result a program returns (0 = success); how CI gates work. |
| **flaky test** | A test that passes and fails on identical code. |
| **deterministic** | Same input → same output, always. The property flaky tests lack. |
| **report file** | The machine-readable receipt a test runner writes (JUnit XML, Jest JSON, …). |
| **JSONL** | JSON Lines: one JSON object per line; flakefinder's history format. |
| **testId** | flakefinder's stable identity for a test: 16 hex chars of `sha256(suite + name)`. |
| **same-commit (same-SHA) flip** | The strongest flake proof: identical code observed passing AND failing. |
| **retry rescue** | A test that failed on one attempt and passed on the next within one invocation. |
| **flake score / confidence** | 0–100 severity and 0–100 evidence-strength per test. |
| **quarantine** | Benching a flaky test via runner flags — source code untouched. |
| **schema header** | The `{"version":1}` first line of the history store. |
| **targeted re-run** | A retry that executes only the failed tests. |

---

# Part 13 — FAQ

**Does it slow my tests down?** In `report`/`ingest`/`html` modes, overhead
is reading small files (~90 ms for a 150k-observation history). In `run`
mode, the cost is the retries you asked for — and targeted re-runs make
those cheap.

**Is my data sent anywhere?** No. The CLI is fully offline. The Action
writes only to your repository's own cache/artifacts. Outbound text (PR
comments, uploaded reports) is secret-redacted first.

**Does it work with my runner?** If it can emit any of: JUnit XML, Jest
JSON, Mocha JSON, `go test -json`, TAP, or TRX — which covers jest, vitest,
pytest, Go, Mocha, .NET, node:test, and dozens more.

**Does it use AI?** No. Every verdict is transparent arithmetic on recorded
evidence, and the rules are published and test-pinned.

**Will it edit my tests to skip them?** Never. Quarantine uses the runner's
own flags.

**What happens if I delete `.flakefinder/`?** Fresh start. It's a diary,
not a database of record.

**Why does a renamed test lose its history?** Identity is suite+name
(hashed); a rename is observably a new test. Scores recover within a few
runs.

---

# Part 14 — Where to go next

- **Use it:** README.md quickstart → docs/USAGE.md for every flag.
- **Understand the algorithm:** PLAN.md §5 (the contract) and
  `src/engine/classify.test.ts` (the tests that pin it).
- **Contribute:** CONTRIBUTING.md — especially the parser guide if your
  ecosystem isn't covered yet.
- **The roadmap:** docs/CLOUD_SCALING.md (the staged cloud path) and
  docs/QA_FINDINGS.md (the ranked improvement backlog).
- **The engineering story:** docs/BUILD_REPORT.md.
