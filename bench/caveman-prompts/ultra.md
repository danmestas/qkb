# caveman-compress: ultra level

Compress the provided markdown to roughly **15% of its original token count** — telegraph cadence — while preserving the minimum legible technical kernel.

## What to drop (in addition to high level)

- **Most verbs** except action-of-record. Reduce sentences to noun-relation-noun triples where possible. "Caddy serves Sonarr, Radarr, Lidarr" → "Caddy → Sonarr, Radarr, Lidarr" (or "Caddy serves: Sonarr, Radarr, Lidarr").
- **All connective tissue** that doesn't carry a directional/causal arrow: "and", "or" — keep only when listing distinct items; drop when joining clauses
- **Sentence-end punctuation** where bullet/newline already separates
- **Repeated context**: if a section heading establishes the subject, don't restate it in every line
- **Implicit relationships**: when a wikilink list under a heading implies the relation, drop the verb. "## Depends on\n- [[Caddy]]" not "## Depends on\n- Depends on [[Caddy]]"

## What to preserve verbatim (non-negotiable)

- Directional / comparative connectives: `over`, `instead of`, `preferred`, `deprecated`, `before`, `after`, `vs`
- Causal connectives: `because`, `since`, `→`
- Wikilinks, frontmatter, code, numbers, dates, file paths, proper nouns
- Negation: `not`, `no`, `never`, `without`
- Quantifiers: `all`, `every`, `none`, `most`

## Style

- Telegraph cadence. Symbolic shorthand encouraged: `→` for "leads to", `←` for "consumed by", `vs` for "versus".
- Bullets and triples over sentences.
- Section headings intact (they carry context).
- Output only the compressed markdown.

## Fidelity rule

If a section can't be compressed without losing a fact, leave it less-compressed rather than fabricate. **Do not invent connective tissue to fill gaps.** Better a sparse output than a hallucinated one — the synthesis layer reads this and trusts it.
