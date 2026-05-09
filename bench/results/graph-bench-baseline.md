# Graph-query benchmark — flight-planner-kb

**Run**: 2026-05-09T03:57:32.612Z
**Modes**: bm25, hybrid, hybrid-graph
**Skip rerank**: false
**Questions**: 10

## Summary

| Mode | Mean recall@5 | Mean recall@10 | Top-1 hit rate | Mean first-hit rank | Mean latency | Failed |
|------|--------------:|---------------:|---------------:|--------------------:|-------------:|-------:|
| bm25 | 0% | 0% | 0% | — | 306.2ms | 0/10 |
| hybrid | 52% | 58% | 30% | 2.1 | 1.4s | 0/10 |
| hybrid-graph | 52% | 61% | 30% | 2.1 | 1.4s | 0/10 |

## Per-question

### q01-international-notam — multi-hop-conceptual

**Q**: What are the international NOTAM coverage requirements?

**Expected**: `wiki/concepts/NOTAM-Reform.md`, `wiki/entities/ICAO.md`, `wiki/concepts/NOTAM-Q-Code.md`, `wiki/entities/FAA-NMS.md`

> International coverage requires hopping from NOTAM concepts to ICAO (the international body). Pure BM25 may miss ICAO since the page doesn't always say 'NOTAM'.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 450ms | wiki/questions/Research-Public-Aviation-Datasets.md<br/>wiki/comparisons/Free-vs-Paid-Data-Sources.md<br/>sources/strategy/execution-priorities.md<br/>wiki/concepts/Service-Arrangement-Layer.md<br/>sources/market/technical-capabilities-research-deep-dive.md |
| hybrid | 50% | 50% | ✓ | 1 | 1.4s | **wiki/entities/ICAO.md**<br/>wiki/sources/jeppesen-eiwac-2013-integrated-gate-to-gate.md<br/>**wiki/entities/FAA-NMS.md**<br/>sources/lou-kb/notam-structure.md<br/>wiki/sources/resources-for-flight-planning-briefs.md |
| hybrid-graph | 50% | 50% | ✓ | 1 | 1.4s | **wiki/entities/ICAO.md**<br/>wiki/sources/jeppesen-eiwac-2013-integrated-gate-to-gate.md<br/>**wiki/entities/FAA-NMS.md**<br/>sources/lou-kb/notam-structure.md<br/>wiki/sources/resources-for-flight-planning-briefs.md |

### q02-faa-nms-contractor — entity-relation

**Q**: Who built the FAA NMS API?

**Expected**: `wiki/entities/CGI-Federal.md`, `wiki/entities/FAA-NMS.md`, `wiki/sources/nms-api-faq.md`

> CGI Federal is the contractor. The CGI-Federal page mentions FAA-NMS via wikilink; graph should surface it even when query says 'contractor' not 'CGI'.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 285ms | wiki/sources/firestorm-dataworks-session-2026-05-02.md<br/>wiki/sources/nms-api-soapui-project.md<br/>sources/specs/nms-api-integration-guide.md<br/>sources/notes/2026-05-02-firestorm-dataworks-session.md<br/>wiki/sources/dataworks-api-v1-rollout-progress-report-2026-05-05.md |
| hybrid | 67% | 100% | ✓ | 1 | 1.4s | **wiki/entities/FAA-NMS.md**<br/>wiki/log.md<br/>wiki/sources/nms-api-initial-load-response.md<br/>**wiki/entities/CGI-Federal.md**<br/>wiki/entities/FAA-SWIM.md |
| hybrid-graph | 67% | 100% | ✓ | 1 | 1.4s | **wiki/entities/FAA-NMS.md**<br/>wiki/log.md<br/>wiki/sources/nms-api-initial-load-response.md<br/>**wiki/entities/CGI-Federal.md**<br/>wiki/entities/FAA-SWIM.md |

### q03-schema-drift — domain-concept

**Q**: What are the guardrails around schema drift in our aviation data sources?

**Expected**: `wiki/concepts/Schema-Drift-Manifest.md`, `wiki/concepts/Canonical-Silver-Layer.md`, `wiki/sources/aircraft-performance-data-sources.md`

> Originally from vault-query-qmd's example. Tests vocabulary mismatch — 'guardrails' isn't on the manifest page directly.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 302ms | sources/research/preflightapi-backend-headstart-plan-2026-04-23.md<br/>wiki/hot.md |
| hybrid | 33% | 33% | ✗ | 2 | 1.4s | sources/research/preflightapi-backend-headstart-plan-2026-04-23.md<br/>**wiki/concepts/Schema-Drift-Manifest.md**<br/>wiki/entities/NOAA-Aviation-Weather-API.md<br/>wiki/concepts/Transient-Aeronautical-Data.md<br/>wiki/sources/awc-weather-pipeline-build-2026-05-02.md |
| hybrid-graph | 33% | 33% | ✗ | 2 | 1.4s | sources/research/preflightapi-backend-headstart-plan-2026-04-23.md<br/>**wiki/concepts/Schema-Drift-Manifest.md**<br/>wiki/entities/NOAA-Aviation-Weather-API.md<br/>wiki/concepts/Transient-Aeronautical-Data.md<br/>wiki/sources/awc-weather-pipeline-build-2026-05-02.md |

### q04-aixm-version — exact-entity

**Q**: What version of AIXM does the system use and how is the schema structured?

**Expected**: `wiki/concepts/AIXM-5-1.md`

> Strong lexical match. Both BM25 and graph should find this trivially. Used to verify the bench doesn't regress on easy cases.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 280ms | sources/specs/nms-api-integration-guide.md<br/>wiki/sources/nms-api-soapui-project.md<br/>wiki/questions/Research-NOTAM-Reform.md<br/>sources/research/firestorm-gap-analysis-2026-04-23.md<br/>wiki/hot.md |
| hybrid | 100% | 100% | ✗ | 2 | 1.4s | sources/specs/nms-api-integration-guide.md<br/>**wiki/concepts/AIXM-5-1.md**<br/>wiki/sources/nms-api-checklist-response.md<br/>sources/research/preflightapi-backend-headstart-plan-2026-04-23.md<br/>wiki/concepts/NOTAM-Field-Structure.md |
| hybrid-graph | 100% | 100% | ✗ | 2 | 1.4s | sources/specs/nms-api-integration-guide.md<br/>**wiki/concepts/AIXM-5-1.md**<br/>wiki/sources/nms-api-checklist-response.md<br/>sources/research/preflightapi-backend-headstart-plan-2026-04-23.md<br/>wiki/concepts/NOTAM-Field-Structure.md |

### q05-data-source-priority — domain-concept

**Q**: How does the system prioritize between official and unofficial flight data sources?

**Expected**: `wiki/concepts/Data-Source-Hierarchy.md`, `wiki/sources/official-aircraft-data-sources.md`, `wiki/sources/official-weather-data-sources.md`

> Hierarchy is a wiki concept; expected to show as top hit. Other sources are graph-connected.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 303ms | (no hits) |
| hybrid | 33% | 33% | ✗ | 4 | 1.4s | wiki/sources/resources-for-flight-planning-briefs.md<br/>wiki/comparisons/NOTAM-Sources.md<br/>wiki/sources/data-sources-and-rate-limits.md<br/>**wiki/sources/official-weather-data-sources.md**<br/>wiki/index.md |
| hybrid-graph | 33% | 67% | ✗ | 4 | 1.4s | wiki/sources/resources-for-flight-planning-briefs.md<br/>wiki/comparisons/NOTAM-Sources.md<br/>wiki/sources/data-sources-and-rate-limits.md<br/>**wiki/sources/official-weather-data-sources.md**<br/>wiki/index.md |

### q06-engine-out — procedure

**Q**: What's the procedure for engine-out emergencies during cruise?

**Expected**: `sources/specs/2026-04-15-checklist-engine-design.md`, `sources/research/aviationlessons-2017/aviationlessons-fuel-management-inflight-replanning-2015-2026-05-04.md`

> Lexical signal on 'engine' is strong. Tests whether graph adds noise on already-good queries.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 301ms | (no hits) |
| hybrid | 100% | 100% | ✗ | 2 | 1.4s | wiki/concepts/Flight-Crew-Qualifications.md<br/>**sources/research/aviationlessons-2017/aviationlessons-fuel-management-inflight-replanning-2015-2026-05-04.md**<br/>**sources/specs/2026-04-15-checklist-engine-design.md**<br/>wiki/concepts/Fuel-Calculations.md<br/>sources/lou-kb/golden-brief-example-KTEB-EGGW-2026-04-17.md |
| hybrid-graph | 100% | 100% | ✗ | 2 | 1.4s | wiki/concepts/Flight-Crew-Qualifications.md<br/>**sources/research/aviationlessons-2017/aviationlessons-fuel-management-inflight-replanning-2015-2026-05-04.md**<br/>**sources/specs/2026-04-15-checklist-engine-design.md**<br/>wiki/concepts/Fuel-Calculations.md<br/>sources/lou-kb/golden-brief-example-KTEB-EGGW-2026-04-17.md |

### q07-notam-reform-timeline — temporal-multi-hop

**Q**: When does NOTAM Reform cut over and what are the dependencies?

**Expected**: `wiki/concepts/NOTAM-Reform.md`, `wiki/sources/nms-api-openapi-spec.md`, `wiki/sources/nms-api-faq.md`

> Date-anchored question; dependencies require traversing from Reform to NMS-API to FAQ.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 298ms | wiki/log.md<br/>wiki/index.md<br/>wiki/hot.md |
| hybrid | 33% | 33% | ✗ | 4 | 1.4s | wiki/index.md<br/>sources/notes/notam-classification-analogs-and-operator-criticality-data-2026-05-07.md<br/>wiki/entities/FAA-NMS.md<br/>**wiki/sources/nms-api-openapi-spec.md**<br/>wiki/concepts/NOTAM-Types.md |
| hybrid-graph | 33% | 33% | ✗ | 4 | 1.4s | wiki/index.md<br/>sources/notes/notam-classification-analogs-and-operator-criticality-data-2026-05-07.md<br/>wiki/entities/FAA-NMS.md<br/>**wiki/sources/nms-api-openapi-spec.md**<br/>wiki/concepts/NOTAM-Types.md |

### q08-zambia-landing — geographic-rare

**Q**: What are the landing requirements for flights operating into Zambia?

**Expected**: `wiki/sources/flight-routing-and-restrictions.md`, `wiki/entities/ICAO.md`

> Hard question. The vault may not have a Zambia-specific page. Tests whether retrieval falls back gracefully to ICAO/general restrictions docs.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 270ms | (no hits) |
| hybrid | 0% | 0% | ✗ | — | 1.4s | sources/lou-kb/weather-assessment-heuristics.md<br/>sources/lou-kb/country-united-states.md<br/>sources/specs/2026-04-15-mcp-server-interface-design.md<br/>wiki/concepts/Weather-Assessment-Heuristics.md<br/>site/docs/features/graph-view.md |
| hybrid-graph | 0% | 0% | ✗ | — | 1.4s | sources/lou-kb/weather-assessment-heuristics.md<br/>sources/lou-kb/country-united-states.md<br/>sources/specs/2026-04-15-mcp-server-interface-design.md<br/>wiki/concepts/Weather-Assessment-Heuristics.md<br/>site/docs/features/graph-view.md |

### q09-jetblue-partnership — entity-strategy

**Q**: What's the relationship between JetBlue Tech Ventures and our partnership strategy?

**Expected**: `wiki/entities/JetBlue-Tech-Ventures.md`, `wiki/domains/Partnership-Opportunities.md`, `sources/strategy/collaboration-and-partnership-opportunities.md`

> Entity-relation question. Graph LINKS_TO from JetBlue to Partnership-Opportunities should help.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 295ms | (no hits) |
| hybrid | 67% | 67% | ✓ | 1 | 1.4s | **wiki/entities/JetBlue-Tech-Ventures.md**<br/>wiki/entities/Jetstream-Aviation-Software.md<br/>wiki/sources/autoresearch-collaborator-deep-dive.md<br/>**wiki/domains/Partnership-Opportunities.md**<br/>wiki/index.md |
| hybrid-graph | 67% | 67% | ✓ | 1 | 1.4s | **wiki/entities/JetBlue-Tech-Ventures.md**<br/>wiki/entities/Jetstream-Aviation-Software.md<br/>wiki/sources/autoresearch-collaborator-deep-dive.md<br/>**wiki/domains/Partnership-Opportunities.md**<br/>wiki/index.md |

### q10-international-regs — broad-conceptual

**Q**: Which international bodies regulate flight safety and what are their roles?

**Expected**: `wiki/entities/ICAO.md`, `wiki/entities/IATA.md`, `wiki/entities/EASA.md`, `wiki/entities/FAA.md`, `wiki/concepts/Part-135.md`

> The poster-child query for graph value. 'Regulate' is a vague term; ICAO is the canonical answer but its page may not say 'regulate' verbatim. This is the query that proved the bug-fix in PR #54.

| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |
|------|---------:|----------:|----------:|---------------:|--------:|------------|
| bm25 | 0% | 0% | ✗ | — | 278ms | wiki/log.md |
| hybrid | 40% | 60% | ✗ | 2 | 1.4s | wiki/log.md<br/>**wiki/entities/EASA.md**<br/>wiki/entities/DGAC.md<br/>**wiki/entities/FAA.md**<br/>wiki/entities/IS-BAH.md |
| hybrid-graph | 40% | 60% | ✗ | 2 | 1.4s | wiki/log.md<br/>**wiki/entities/EASA.md**<br/>wiki/entities/DGAC.md<br/>**wiki/entities/FAA.md**<br/>wiki/entities/IS-BAH.md |

## Methodology

- **recall@K**: fraction of the question's `expected_docs` that appear in the top-K results.
- **top-1 hit**: did the top result match an expected doc?
- **first-hit rank**: 1-indexed rank of the first expected doc in the result list (lower is better).
- **expected_docs**: hand-curated per-question, see `bench/fixtures/flight-planner-questions.json`.
- Quality scoring is deterministic — no LLM judge — so iterating on the question fixture changes scores.

## Limits / known caveats

- Only tests retrieval quality, not synthesis quality. The actual `vault-query-graph` skill includes LLM synthesis on top of these retrieved hits.
- `expected_docs` are best-guess curations; missing entries can make a mode look worse than it is. Iterate.
- `vault-query` (manual file-reading skill) is not benchmarked — it's procedural and not directly CLI-runnable.
