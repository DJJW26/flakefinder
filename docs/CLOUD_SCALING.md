# flakefinder → Cloud: Architecture Research

> The overnight-loop's final deliverable (asked for explicitly by the owner):
> how to scale flakefinder from a local-first CLI toward a cloud offering,
> what exists commercially, and a concrete, staged migration path.
> Written 2026-10-25 after a competitive/architecture research pass.
> Status: RESEARCH + DESIGN — nothing here is implemented yet.

## 1. Why cloud at all (and why not immediately)

The local-first design is a feature (privacy, zero-config, deterministic).
What it *cannot* do:

- **Cross-repo / org-wide views** — "which teams own the flakiest suites?"
- **Zero-setup CI history** — today every repo must wire `actions/cache`;
  a hosted store makes `uses: DJJW26/flakefinder@v1` work with no cache step.
- **Cross-service correlation** — "test X became flaky after commit Y in
  service A" across repos sharing a monorepo dependency.
- **Trend dashboards that outlive 300-run retention** and survive cache eviction.

The commercial field (researched): **BuildPulse**, **Trunk Flaky Tests**,
**Datadog Test Visibility**, **Buildkite Test Engine** all follow the same
shape — a CI-side uploader, server-side detection, a hosted dashboard, and
quarantine workflows. The wedge for flakefinder: the detection engine already
exists as tested OSS, is fully deterministic (no black-box "AI scoring"), and
is local-first by default — "the same engine, hosted if you want it" is a
credible differentiator against closed SaaS.

## 2. Product shape recommendation: BYO-key hosted store, not a platform

Do NOT start with a multi-tenant SaaS platform (auth, billing, compliance,
on-call — months before first value). Start with:

**Tier 1 (ship first): "Hosted history store" — a dumb, fast ingestion API.**

- One endpoint: `POST /v1/ingest` with a batch of `RunRecord`s (the exact
  JSONL schema already shipped, schema-versioned since 0.2.0 — the store
  header work was done precisely to make this migration possible).
- Auth: per-repo **ingest token** (random 32-byte, stored hashed) issued by a
  tiny dashboard or CLI (`flakefinder cloud init`).
- The GitHub Action gains a `cloud-token` input: when set, it POSTs the same
  records it already computes — zero new logic server-side, classification
  still happens **in the action** (stateless) while the server accumulates.
- Server: stateless containers + managed Postgres (see §3). Classification
  for *dashboards* recomputes server-side from stored runs using the SAME
  engine code — extract `src/engine` into a shared package (`@flakefinder/engine`)
  consumed by CLI and server. This is the core architectural move.
- Deletion/privacy: per-repo purge endpoint + 30-day default retention tier.
  The local store stays authoritative for users who never opt in.

**Tier 2: dashboards + org views.** Hosted read-only HTML dashboard per repo
(the self-contained dashboard renderer is already a pure function — serve its
output), org rollups, flake-rate trends, ownership mapping via CODEOWNERS.

**Tier 3: GitHub App.** Only when needed for: per-check-run annotations at
scale, auto-quarantine PR suggestions, org-wide install. A GitHub App
installation token also lets the server fetch `flakefinder-report.json`
artifacts directly (see §4).

## 3. Storage decision

| option | verdict |
|---|---|
| Managed Postgres (Neon/Supabase/RDS) | **chosen** — JSONB columns for `RunRecord.results` (the store schema is already JSONL-shaped; JSONB keeps write-path identical), normal columns for (repo_id, test_id, commit_sha, timestamp) with a BRIN index on time and a btree on (repo_id, test_id, timestamp). Partition by month. 1M runs ≈ a few GB. |
| ClickHouse | revisit at >100M observations (Datadog-scale). Overkill for tier 1. |
| Object storage + Parquet | for cold archival + bulk analytics export only. |
| SQLite-per-tenant on a volume | simple but fights multi-writer CI bursts — the exact problem the C1 lock papered over locally. No. |

Ingest is append-heavy and bursty (one burst per CI run repo-wide). Size for
~50 writes/s at modest adoption; Postgres handles this trivially. The
classification query (per-test timelines) is the expensive one — cache
computed verdicts per (repo, branch) with invalidation on new ingest.

## 4. GitHub App vs GitHub Action data flow

**Keep the Action as the ingestion worker.** It already runs where the
reports are, has the token, and works for every CI via `flakefinder ci`.
The App's role is *read-side enrichment* (fetch artifacts for repos that
misconfigure ingestion, post comments as the app identity with org policy),
not write-side. Reasons:

- The Action path is proven (this repo runs it daily); App webhook infra
  (SMIME verification, delivery retries, rate budgets) is net-new surface.
- Apps can't see logs/reports unless installed with broad permissions —
  the Action already holds exactly the needed scope.
- Hybrid later: App ingests *check-run conclusions* as a fallback signal for
  repos without the Action, feeding the same `POST /v1/ingest`.

Artifact-based ingestion (server pulls `flakefinder-report.json` from
`actions/artifact`) is feasible via the REST artifact API but adds
permission plumbing; prefer direct upload from the Action and keep artifact
pull as a gap-filler for other CIs (CircleCI/GitLab artifacts have plain APIs).

## 5. Security & privacy requirements (non-negotiable)

1. **Ingest tokens are repo-scoped and write-only** (upload, never read other
   repos). Rotation + last-used metadata.
2. **Redaction happens before upload** — the v0.2 redaction pass runs in the
   Action; the server re-runs it defensively but never stores what it
   doesn't receive. Docs must state plainly what leaves the machine.
3. **No test source code ever uploaded** — only the normalized
   `TestCaseResult` shape (names, statuses, durations, truncated messages).
4. **Purge + export APIs** from day one (GDPR posture); self-hosted option
   later via the same server in a Docker image for companies that won't
   send data anywhere.
5. **Rate limiting per token** (a runaway CI matrix must not DDoS the store);
   idempotency via (repo, commit_sha, run_id) dedup keys — retries after a
   network blip must not double-count observations.

## 6. Pricing sketch (validation-level, not pricing research)

- **Free**: single repo, 30-day retention, hosted dashboard — the wedge.
- **Team (~$15–30/repo/mo)**: unlimited retention, org views, quarantine
  automation, Slack/PR digests. Anchor against BuildPulse/Trunk list prices.
- **Self-hosted (flat)**: the same server image; for enterprises where
  data egress is the blocker. This tier also keeps the OSS story honest.
- Local CLI stays free forever — it's the funnel and the moat.

## 7. Migration path (ordered, each step independently shippable)

1. **Extract `@flakefinder/engine`** (classify/stats/parsers/types) as a
   workspace package — CLI and future server share one tested engine. (No
   behavior change; unblocks everything else.)
2. **`POST /v1/ingest` + token issuance** behind a flag; Action `cloud-token`
   input uploads in the background (failure = warn, never break CI).
3. **Hosted read dashboard** serving the existing `renderDashboard` output
   from stored runs.
4. **Org views + retention tiers**; then the **GitHub App** for enrichment.
5. **Self-hosted image** (docker compose: server + Postgres).

Each step keeps the local CLI as the zero-dependency fallback — the cloud is
an additive layer, not a replacement.

## 8. Competitor references (researched 2026-10-25)

- [BuildPulse — CI observability for flaky tests](https://docs.buildpulse.io/flaky-tests/overview)
- [Mergify — flaky test tools compared](https://mergify.com/compare/flaky-test-tools)
- [Datadog Test Visibility / Flaky Tests Management](https://docs.datadoghq.com/tests/flaky_management)
- [Buildkite Test Engine](https://buildkite.com/platform/test-engine)
- [GitHub Actions artifact API (upload mechanics)](https://github.com/actions/upload-artifact/issues/180) ·
  [artifact REST endpoints](https://www.getorchestra.io/guides/github-actions-api-rest-api-endpoints-for-github-actions-artifacts) ·
  [non-zipped artifacts changelog](https://github.blog/changelog/2026-02-26-github-actions-now-supports-uploading-and-downloading-non-zipped-artifacts)
