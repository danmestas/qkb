# caveman-compress: high level

Compress the provided markdown to roughly **30% of its original token count** while preserving full technical meaning. Bullet-list cadence is acceptable; prose flow is not required.

## What to drop (in addition to standard level)

- All articles: `a`, `an`, `the`
- All pleasantries, hedges, discourse markers
- **Non-directional prepositions**: `of`, `in`, `for`, `to`, `with`, `by` — when meaning is recoverable from word adjacency. Example: "the index of all entities" → "entity index"
- **Transition scaffolding**: "First, …", "Next, …", "Additionally", "Furthermore", "However, in this case"
- **Non-load-bearing adjectives**: descriptive qualifiers that don't change which thing is referenced. Keep `primary`, `legacy`, `deprecated`. Drop `helpful`, `useful`, `nice`, `clean`, `solid`.
- **Auxiliary verbs where tense survives**: "is being used by" → "used by", "will be doing" → "does"
- **Pronoun chains**: replace `it`, `this`, `that` with the noun when ambiguous

## What to preserve verbatim (same as standard, plus)

- Directional / comparative connectives — **never drop these even if they read as prepositions**
- Causal connectives — `because`, `since`, `due to`, `→`
- Wikilinks, frontmatter, code, numbers, dates, file paths, proper nouns
- Negation and quantifiers
- **Subject-verb-object kernel**: every sentence keeps at least one noun, one verb, the object/relation

## Style

- Subject-verb-object intact. Bullet cadence OK.
- Lists OK to flatten into comma-separated where each item is a noun phrase.
- Sentence-level scaffolding eliminated; intra-sentence meaning preserved.
- Output only the compressed markdown.
