# Skill-comparison benchmark prompt template

Reusable template for benchmarking qkb-backed retrieval skills against a vault.
Copy this prompt into a fresh Claude Code session pointed at the vault you want
to benchmark; the agent will execute the full bench (run + rigorous eval + HTML
report) end-to-end.

## When to use this template

- Comparing two or more retrieval skills on the same vault
- Validating that a skill change improved (or didn't break) behavior
- Establishing a baseline before introducing a new retrieval strategy
- Sanity-checking a skill cohort after vault growth or schema changes

Don't use this for:
- Microbenchmarks of a single qkb command (use `bench/bench.ts` instead)
- Index-level performance (latency at 10K vs 100K docs) — different test shape

## Methodology in one paragraph

For each of N questions, dispatch one subagent per skill in parallel. Each
agent reads its `SKILL.md`, follows it end-to-end (real retrieval + real file
reads + real synthesis), and times itself. After all runs complete, dispatch
one evaluation agent per question — it reads the canonical vault pages,
extracts a 10–15 item ground-truth fact list, scores each answer against it
(paraphrasing OK), and verifies wikilink citations resolve. Aggregate
coverage + latency + token cost into an HTML report.

## Filling the template

Replace these placeholders before running:

| Placeholder | Example | What it is |
|---|---|---|
| `<VAULT_ROOT>` | `/Users/dmestas/projects/flight-planner-kb` | Absolute path to the vault |
| `<SKILL_DIR>` | `<VAULT_ROOT>/.claude/skills` | Where the skills live |
| `<SKILLS>` | `vault-query, vault-query-bm25, vault-query-qkb, vault-query-graph` | Comma-separated skill names |
| `<QUESTIONS>` | see "Question selection" below | 3–6 questions spanning different shapes |
| `<OUT_HTML>` | `/Users/dmestas/projects/qkb/bench/results/skill-bench-YYYY-MM-DD.html` | Where to write the report |

## Question selection — pick a shape mix

A good bench has ≥1 question from each shape:

1. **Proper-noun anchor** — answer lives on one page named like the question. Tests baseline retrieval.
2. **Distinctive vocabulary** — vault uses dense, specific terms. Tests BM25's strength.
3. **Vocabulary mismatch** — user's words ≠ vault's words (e.g. "too long" vs "cap"). Tests LLM query expansion.
4. **Cross-source pattern** — answer is scattered across many pages, never named as a concept. Tests synthesis.
5. **Multi-hop / hypothetical** — requires combining entity pages + comparison pages. Tests graph expansion.
6. **Pairwise comparison** — "X vs Y, same and different". Tests retrieving both anchors.

Avoid:
- Yes/no factual questions (low ceiling for retrieval)
- Questions the vault demonstrably can't answer (measures vault coverage, not retrieval)
- Questions tied to ephemeral state (today's hot.md, recent commits)

---

## Phase 1: per-question run-agent prompt (run N×K agents in parallel, one batch per question)

Dispatch K agents per question (where K = number of skills), all in one Agent tool call so they run in parallel. Use this prompt template, substituting `<SKILL>`, `<SKILL_PATH>`, `<VAULT_ROOT>`, `<QUESTION>`:

```
You are running a reproducible benchmark of the `<SKILL>` skill against a live
qkb index. Read the skill, follow it end-to-end, time yourself, return a
structured report. No vault edits, no `qkb update`/`embed`/`graph link`.

SKILL: `<SKILL>`
SKILL_PATH: `<SKILL_PATH>`
VAULT_ROOT: `<VAULT_ROOT>`

QUESTION: "<QUESTION>"

Mechanics:
1. Read <SKILL_PATH> in full.
2. Run `date +%s.%N` and record T_START immediately before your first
   retrieval/read action driven by the skill (don't count reading SKILL.md).
3. Follow the skill's documented flow. Standard / default mode unless directed
   otherwise.
4. Apply the skill's result-hygiene/triage rules. Read 3–5 vault pages with
   the `Read` tool (don't exceed 5).
5. Synthesize an answer (150–300 words) with `[[wikilink]]` citations per the
   skill.
6. Run `date +%s.%N` and record T_END immediately after composing the answer.
7. ELAPSED = T_END − T_START (seconds, 1 decimal).
8. Skip "file back" / "escalate to user" steps if the skill describes them —
   note under GAPS instead.

Return EXACTLY this format, no preamble or trailing text:

ELAPSED_SECONDS: <float>
QKB_COMMANDS_USED:
- <command 1, or "none">
- ...
FILES_READ:
- <vault-relative path 1>
- ...
CITATIONS_COUNT: <int>
SELF_CONFIDENCE: <1–5>
GAPS: <one line or "none">

ANSWER:
<150–300 words with [[wikilinks]]>

Stay strictly inside your assigned skill's discipline. Do not mix tactics from
other skills.
```

**Parallel batching:** Send all K agents for one question in a single message
(one Agent tool call per agent within the same `<function_calls>` block).
Sequence questions serially — running all N×K agents at once causes reranker
contention that inflates wallclock unrealistically.

**Capture the timing + answer text from each agent's response** — you'll need
both for Phase 2 and the HTML report.

---

## Phase 2: per-question rigorous-eval-agent prompt (run N agents in parallel)

After all run-agents finish, dispatch one evaluation agent per question
(parallel — they don't share resources). Substitute `<QUESTION>`,
`<CANONICAL_PAGES>` (list of 2–4 pages, picked by reading what the run-agents
read OR by hand from your knowledge of the vault), and `<ALL_FOUR_ANSWERS>`:

```
You are rigorously evaluating <K> benchmark answers to a question against the
vault's ground truth.

QUESTION: "<QUESTION>"

PHASE 1 — Build ground truth. Read these canonical pages with the Read tool:
- <VAULT_ROOT>/wiki/concepts/<PAGE_1>.md
- <VAULT_ROOT>/wiki/entities/<PAGE_2>.md
- ...

From them, extract a numbered fact list of 10–15 SPECIFIC facts a correct,
complete answer should mention. Each fact must be:
- specific (a concrete claim, not "discusses the topic")
- directly verifiable in the page text
- material to the question
- ≤25 words

PHASE 2 — Score the <K> answers below. For each:
- Coverage = (facts mentioned, paraphrasing OK) / (total facts), as N/total = X%
- Verify each [[wikilink]] citation maps to a real file under <VAULT_ROOT>/wiki/
  (use `find wiki/ -iname '<name>.md'`). Report resolved / total.
- Flag any unsupported claim (specific fact not in canonical pages).

ANSWERS:

=== <skill-1> ===
<answer text>

=== <skill-2> ===
<answer text>

=== ... ===

Output exactly this structure, no preamble:

FACT_LIST:
1. <fact>
2. <fact>
...

<SKILL-1>:
  coverage: <X>/<N> = <%>
  citations_resolved: <X>/<N>
  unsupported_claims: <list or "none">
  one_line_note: <observation>

<SKILL-2>:
  ...

RANKING: <skill > skill > skill > skill>
KEY_DIFFERENTIATOR: <one sentence>
ONE_LINE_PER_ANSWER:
  <skill-1>: <summary>
  <skill-2>: <summary>
  ...
```

---

## Phase 3: HTML report

Compile results into a single self-contained HTML file at `<OUT_HTML>`. Use
`bench/results/skill-bench-2026-05-13.html` in this repo as the structural
template — copy its CSS verbatim (dark/light mode, bar charts via div
widths). Required sections:

1. **Header** — title, vault path, doc/vector/edge counts, run date
2. **Legend** — color-code each skill, name + one-line description
3. **Headline summary** — 4 stat cards: avg coverage, avg latency, hallucination count, wikilink resolution rate
4. **Aggregate table** — per-skill: avg coverage, avg latency, avg tokens, wins, ≤50% questions
5. **TL;DR bullets** — 3–5 sentence findings, prepared for someone who won't read the per-question detail
6. **Methodology** — 5 numbered steps explaining what was measured and how
7. **Per-question blocks** (one each):
   - Question text + shape tag (proper-noun, vocab mismatch, etc.)
   - Two charts side-by-side: coverage bars + latency bars
   - Score table: per-skill coverage, citations, one-line notes
   - Collapsible `<details>` for the ground-truth fact list
   - Collapsible `<details>` for per-skill answer summaries
   - Verdict paragraph with explicit ranking
8. **Triage guidance** — table mapping question shape → recommended skill → why
9. **Action items** — concrete fixes the bench surfaced

Style discipline: embedded CSS only (no fetched fonts, no JS, no external
images). Self-contained file that opens directly in a browser, ≤100 KB.

---

## Caveats to surface in every report

- **Reranker contention** — if two `qkb query` agents run in parallel, both
  serialize on the local LLM. Their reported elapsed times inflate ~2× over
  solo runs. Note this in the Methodology section.
- **Ground-truth subjectivity** — the fact list is constructed by one agent
  reading 2–4 pages. Pick canonical pages carefully; if a question's "correct"
  answer is genuinely contested in the vault, the bench can't tell.
- **Question shape ≠ retrieval shape** — a question that LOOKS like a
  vocabulary mismatch may have a single canonical page that BM25 hits
  perfectly. Bench results describe *this vault on this date*, not retrieval
  in general.
- **Skill discipline violations** — sometimes an agent following a no-engine
  skill (like vault-query) falls back to running qkb commands when meta-files
  exceed read budget. Note these in the per-skill row; they're real signal
  about skill robustness at scale.

## Action checklist for a new bench run

```
[ ] Pick 3–6 questions covering ≥3 of the 6 shape categories
[ ] Identify the 2–4 canonical vault pages per question (these become Phase 2 ground truth)
[ ] Dispatch Phase 1: N×K run-agents, batched per question, in parallel within batch
[ ] Collect each agent's structured report (timing, files read, answer text)
[ ] Dispatch Phase 2: N eval-agents, fully parallel
[ ] Compile HTML to bench/results/skill-bench-YYYY-MM-DD.html
[ ] Open the file in a browser to sanity-check rendering
[ ] Surface action items: which skills need fixes? URI bugs? Skill descriptions?
```

## See also

- `bench/results/skill-bench-2026-05-13.html` — first run of this template
- `CLAUDE.md` — qkb development guidance
- `vault-ingest`, `vault-query*` skills in the target vault — the units under test
