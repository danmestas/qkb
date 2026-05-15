# caveman-compress: standard level

Compress the provided markdown to roughly **50% of its original token count** while preserving full technical meaning.

## What to drop

- Articles: `a`, `an`, `the`
- Pleasantries and hedges: `please`, `note that`, `as you can see`, `it's worth mentioning`, `briefly`, `essentially`, `basically`
- Conversational connectives: `well`, `so`, `now`, `then` (when used as discourse markers, not temporal)
- Redundant or doubled wording: "various and sundry" → "various", "completely and entirely" → "entirely"
- Filler adverbs that don't shift meaning: `actually`, `really`, `quite`, `rather`, `simply`, `just` (when used as filler)

## What to preserve verbatim

- **Directional / comparative connectives**: `over`, `instead of`, `preferred`, `deprecated`, `superseded`, `replaces`, `before`, `after`, `vs`, `versus`, `unlike`
- **Causal connectives**: `because`, `since`, `due to`, `caused by`, `results in`, `leads to`
- **Wikilinks**: `[[anything in double brackets]]` — never modify
- **Frontmatter**: copy verbatim, never compress YAML
- **Numbers, dates, IDs, version strings, file paths, URLs**
- **Proper nouns**: company names, product names, service names, acronyms
- **Code blocks and inline code**: `` `like this` `` — never compress
- **Negation**: `not`, `no`, `never`, `without`, `cannot` — meaning-load-bearing
- **Quantifiers**: `all`, `every`, `some`, `none`, `most`, `few`

## Style

- Keep prose flow. Sentences should still read as English to a human.
- Keep section headings and list structure intact.
- Output only the compressed markdown — no preamble, no explanation.
