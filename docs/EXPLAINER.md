# flakefinder, explained from scratch

> This document assumes **zero background knowledge**. If you have never heard
> of a "test", "CI", or a "flaky test", you are exactly the right reader.
> (For the pitch-version, see README.md. For every command and setting, see docs/USAGE.md.)

---

## Part 1 — The background you need (2 minutes)

### What is a "test"?

When programmers write software, they also write small programs that **check
the software automatically**. Each of these checks is called a *test*. One test
might say: "when I add 2 + 2, the calculator must show 4". Another might say:
"when I click 'Buy', the shopping cart must have one item".

A real project has hundreds or thousands of these tests, and they all get run
together, all the time. If every test passes, the software is healthy. If any
test fails, something is broken and needs fixing.

Think of tests like **smoke alarms in a building**: they constantly watch for
trouble, and when one goes off, you trust that there's a fire.

### What is "CI"?

CI (Continuous Integration) is the habit — enforced by robots — of running
**all** the tests automatically, every single time a programmer saves or
submits code. Platforms like GitHub run your tests in the cloud within
seconds of a submission.

The result is a simple traffic light:

- **Green** — all tests passed. Safe to merge.
- **Red** — at least one test failed. Stop and fix first.

Teams live and die by this traffic light. When it's trustworthy, shipping is
fast and calm.

---

## Part 2 — The problem: the flaky test

### What is a "flaky" test?

A flaky test is a test that **sometimes passes and sometimes fails on the
exact same code**. Nothing changed. Nobody broke anything. The test just...
rolls dice. It might fail because of timing ("the page took 0.3 seconds
instead of 0.2"), leftover files from a previous run, random ordering,
network hiccups, or a dozen other invisible causes.

Picture a smoke alarm that goes off **randomly**, with no fire. At 3 AM. Every
few nights. Sometimes several times a night.

### Why this is poison (the real damage)

One flaky test sounds minor. It isn't. Here's what it does to a team:

1. **The boy who cried wolf.** The traffic light turns red, everyone sighs
   "oh, it's THAT test again, just re-run it". Do this for a month and people
   stop trusting red lights *in general*. Then one day the red light is real —
   an actual bug — and nobody looks. **This is how flaky tests let genuine
   bugs reach users.**

2. **Wasted time and money.** Because "just re-run it" is the standard fix,
   teams re-run entire test suites (sometimes 30–60 minutes of cloud
   computing) just to get a green light they should have gotten the first
   time.

3. **Random blocked work.** Merges get held up for hours because test #417
   decided to fail today. Not because the code was wrong — because the *test*
   was unreliable.

4. **It's nearly impossible to find by hand.** If a test fails only 10% of the
   time, you'd have to re-run it ~10 times just to catch it once. Multiply by
   a thousand tests and it's a needle-in-a-haystack hunt that nobody has time
   for. So most teams *know* they have flaky tests but can't even name them.

### What people do about it today (and why it's not enough)

- **Re-run and hope** — the above, forever.
- **Delete the test** — throwing away real protection because it's annoying.
- **Buy a SaaS product** — several companies sell flaky-test dashboards, but
  they're paid, cloud-hosted, and your test results leave your company.

What was missing: a **free, open-source, runs-on-your-own-machine** tool that
just tells you which tests are flakes. That is exactly the gap flakefinder
fills.

---

## Part 3 — What flakefinder does

flakefinder is a small command-line program (you type one command in the
terminal) that answers two questions:

1. **"Is this failing test a flake, or a real bug?"** — answered *right now*,
   in minutes.
2. **"Which tests in my project are flakes?"** — answered *over time*, with
   evidence and a severity score.

It works with the four most common testing ecosystems (JavaScript's Jest and
Mocha, Python's pytest, and Go's built-in tests) and needs no accounts, no
cloud, and no internet. Here's how each superpower works.

### Superpower 1: The instant detective (retry mode)

You run your tests through flakefinder:

```
flakefinder run -- npm test
```

flakefinder runs your normal test command. **If it fails, flakefinder simply
runs it again** (twice more, by default) — the same code, unchanged. Then it
reads the results and separates the failures into two buckets:

- A test that **failed, then passed on a re-run** → it's a *flake*. It failed
  on identical code, which a genuinely broken test can never do. Proven,
  today, in minutes.
- A test that **failed every single time** → it's a *real failure*. Go fix it.

And it tells your tools this, through the program's exit code: flakes alone →
exit 0 ("you're fine"), real failures → exit 1 ("stop and fix"). So your CI
robot can treat them differently — which is the whole point.

> How does it read the results? Test runners can write a "receipt" file of
> their run (a machine-readable results file — like JUnit XML). flakefinder
> reads those receipts. It never changes how your tests run.

### Superpower 2: The long-term memory (history mode)

Every time flakefinder sees a test run, it appends one line to a private
diary: a file called `.flakefinder/history.jsonl` in your project. Over days
and weeks, this diary contains the entire biography of every test.

From this history it derives **mathematical proof** of flakiness. The
strongest signal: the **same version of the code** (the same Git commit —
literally identical bytes) produced both a pass and a fail for the same test
at different times. A healthy test cannot do that. Only a flake can.

Weaker-but-real signals are also counted: rescued-by-retry failures, and
tests that flip-flop pass/fail across versions without any change being
related to them. (Don't use Git? The flip-flop tracking falls back to
comparing individual runs instead of commits — projects outside Git get
detection too.)

All of this adds up to two numbers per test:

- **Flake score, 0–100** — how flaky is this test? (Same-code flip: up to 50
  points. Retry rescue: up to 40. Flip-flop pattern: up to 24. Bonus for lots
  of evidence.)
- **Confidence, 0–100** — how sure are we? (Two data points = low confidence.
  A same-code flip = mathematically certain.)

Each test then gets a label you can act on:

| Label | Plain meaning |
|---|---|
| **flaky (confirmed)** | Same code both passed and failed it. Guilty beyond doubt. |
| **flaky (retry-rescued)** | Failed, then passed on an automatic re-run. Caught red-handed. |
| **flaky (suspected)** | Keeps flip-flopping over time. Strong suspicion, building evidence. |
| **failing** | Fails consistently. Not a flake — a real bug. |
| **new failure** | First failure ever seen. Watching it. |
| **slow** (tag) | Not broken, but suspiciously slow compared to its neighbors. |
| **recently fixed** (tag) | Used to fail, now clean for a while. |

### What you get out of it

- **A terminal report** — color-coded, sorted worst-first, with the exact
  command to deal with each offender.
- **An HTML dashboard** — a single file you double-click to open in a
  browser: every test's score, history, and trends, with charts. Works
  offline; nothing is uploaded anywhere.
- **A PR comment robot (GitHub Action)** — in GitHub, flakefinder can comment
  on every pull request: "3 flaky tests detected — 1 is NEW this week" with
  the evidence. It remembers last week's verdicts, so it distinguishes
  *new* flakes from *known* ones — you only get pinged when things get worse.
- **Quarantine** — see below.

### Quarantine: benching the sick player

Once you *know* a test is flaky, you usually can't fix it immediately (it may
take a day of proper debugging). Meanwhile it keeps crying wolf. So:

```
flakefinder quarantine add <test-id>
```

From now on, when you run tests through flakefinder, that specific test is
**left out** — using the test runner's own built-in "skip these" flags. The
test stays in your code, untouched and unedited; it's just benched from
blocking the team while someone fixes it properly. When it has proven healthy
again (passing stably across many runs), `flakefinder quarantine prune`
clears it to return to play. Deliberately cautious — a benched player isn't
judged on games he didn't play.

---

## Part 4 — What it works with, and what it does NOT do

**Works with:** any project whose test runner can write a results receipt —
Jest and vitest (JavaScript/TypeScript), pytest (Python), Go's built-in
tests, Mocha, and anything that emits JUnit XML (the most common "receipt"
format in the industry — used by dozens of tools).

**Does NOT:**
- **Change your tests or your code.** Ever. Quarantine uses official runner
  flags, not file edits.
- **Send anything anywhere.** No cloud, no accounts, no telemetry, no
  network calls. All data lives in one small file (`.flakefinder/history.jsonl`)
  inside your project. Delete it and you're back to a blank slate.
  (When report data *does* leave your machine — a PR comment or CI artifact —
  flakefinder first redacts credential-shaped strings like API tokens that
  leaked into a failure message.)
- **Use AI or guesswork.** Every verdict is deterministic math on recorded
  evidence, and the rules are published (PLAN.md §5, implemented and tested
  to the letter).
- **Slow you down.** It's one 85 KB program with two dependencies, and its
  overhead is reading small receipt files (plus optional re-runs you asked
  for).

---

## Part 5 — Try it in 60 seconds

```
npx flakefinder init              # one-time: detect your test runner, write a small config
npx flakefinder run -- npm test   # run tests WITH flake detection (retries failures, names names)
npx flakefinder report            # see the verdicts from all accumulated history
npx flakefinder html              # get the pretty dashboard file
```

For CI robots, GitHub recipe and every knob and flag: **docs/USAGE.md**.
For how this was engineered (the interesting internals): **docs/BUILD_REPORT.md**.

---

## Glossary (the ten words that matter)

| Word | Meaning |
|---|---|
| **test** | A small program that automatically checks one piece of your software. |
| **test suite** | All your tests, run together. |
| **flaky test** | A test that randomly passes/fails on identical code. The villain of this story. |
| **CI** | Robots that run your whole test suite on every code change (e.g., on GitHub). |
| **report file** | The machine-readable "receipt" a test runner can write (e.g., JUnit XML). flakefinder reads these. |
| **history** | flakefinder's private diary of every test result it has ever seen (`history.jsonl`). |
| **flake score** | 0–100 severity for "how flaky is this test". |
| **confidence** | 0–100 for "how much evidence backs this verdict". |
| **quarantine** | Temporarily benching a flaky test via official runner flags — code stays untouched. |
| **GitHub Action** | A small robot you can install into a GitHub repository with ~8 lines of config. flakefinder ships as one. |
