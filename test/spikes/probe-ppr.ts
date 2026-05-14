/**
 * RFC-0010 spike — validate PPR-based graph rank against v3 bench Q13 failure mode.
 *
 * Question: does BM25-seeded PPR find [[Cycle-Aware Publication Refresh]] for the
 * query "new FAA pipeline patterns" — a node the v3 bench's graph skill missed?
 *
 * Compares α ∈ {0.3, 0.5, 0.7, 0.85} to inform the spec's default-α decision.
 *
 * Run: bun test/spikes/probe-ppr.ts
 */

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";

const DB_PATH = process.env.QKB_DB ?? join(homedir(), ".cache/qkb/index.sqlite");
const COLLECTION = "flight-planner";

// Property key IDs from probe (see schema check)
const KEY_ID = 1;
const KEY_COLLECTION = 3;
const KEY_PATH = 4;
const KEY_TITLE = 5;

// RFC-0010 default edge weights (carried over from RFC-0008 strategy #2)
const EDGE_WEIGHTS: Record<string, number> = {
  EMBEDS: 0.9,
  LINKS_TO: 0.4,
  REFERENCES: 0.2,
};

interface Node {
  sqlId: number;     // nodes.id — internal SQL row ID
  extId: string;     // "doc:<N>" — the GraphQLite external ID
  title: string;
  path: string;
  collection: string;
}

interface BM25Hit {
  docid: string;
  score: number;
  file: string;       // qkb://collection/path?...
}

// ---------- 1. Load graph from sqlite ----------

function loadGraph(): { nodes: Node[]; csr: { indptr: Int32Array; indices: Int32Array; values: Float64Array } } {
  const db = new Database(DB_PATH, { readonly: true });

  // Load nodes with their properties, filtered to collection
  const nodeRows = db.prepare(`
    SELECT n.id as sqlId,
           p1.value as extId,
           p3.value as collection,
           p4.value as path,
           p5.value as title
    FROM nodes n
    LEFT JOIN node_props_text p1 ON p1.node_id = n.id AND p1.key_id = ?
    LEFT JOIN node_props_text p3 ON p3.node_id = n.id AND p3.key_id = ?
    LEFT JOIN node_props_text p4 ON p4.node_id = n.id AND p4.key_id = ?
    LEFT JOIN node_props_text p5 ON p5.node_id = n.id AND p5.key_id = ?
    WHERE p3.value = ?
  `).all(KEY_ID, KEY_COLLECTION, KEY_PATH, KEY_TITLE, COLLECTION) as any[];

  const nodes: Node[] = nodeRows.map(r => ({
    sqlId: r.sqlId,
    extId: r.extId ?? "",
    title: r.title ?? "",
    path: r.path ?? "",
    collection: r.collection ?? COLLECTION,
  }));

  // Index sqlId → array position
  const idx = new Map<number, number>();
  nodes.forEach((n, i) => idx.set(n.sqlId, i));

  // Load edges, filter to within-collection
  const edges = db.prepare(`
    SELECT source_id, target_id, type FROM edges
  `).all() as any[];

  // Build CSR — represent column-normalized transposed transition matrix M
  // M[i][j] = probability of jumping to node i given we're at node j
  // We'll store row-wise (the matrix-vector product reads row i and accesses p[j])
  //
  // Equivalent: for each source j, list its outgoing edges (i, weight). Then
  // p_new[i] += weight[j→i] * p[j] for each j.
  //
  // CSR by SOURCE (column of M = source j):
  //   - For each source j: list its (target i, weight) pairs
  //   - sum weights for each j to column-normalize
  const N = nodes.length;
  const outEdges: { target: number; type: string }[][] = Array.from({ length: N }, () => []);

  for (const e of edges) {
    const si = idx.get(e.source_id);
    const ti = idx.get(e.target_id);
    if (si === undefined || ti === undefined) continue; // cross-collection edge — skip
    if (!(e.type in EDGE_WEIGHTS)) continue;
    outEdges[si].push({ target: ti, type: e.type });
  }

  // Build CSR: for each column j, store {indices: [target_i], values: [normalized_weight]}
  // Layout: indptr[j] .. indptr[j+1] is the range for column j
  const nnz = outEdges.reduce((s, e) => s + e.length, 0);
  const indptr = new Int32Array(N + 1);
  const indices = new Int32Array(nnz);
  const values = new Float64Array(nnz);

  let p = 0;
  for (let j = 0; j < N; j++) {
    indptr[j] = p;
    const out = outEdges[j];
    // Compute column sum for normalization
    let colSum = 0;
    for (const e of out) colSum += EDGE_WEIGHTS[e.type];
    if (colSum === 0) {
      indptr[j + 1] = p;
      continue;
    }
    for (const e of out) {
      indices[p] = e.target;
      values[p] = EDGE_WEIGHTS[e.type] / colSum;
      p++;
    }
  }
  indptr[N] = p;

  db.close();
  return { nodes, csr: { indptr, indices, values } };
}

// ---------- 2. Get seeds via qkb shell-out ----------

function bm25Seeds(question: string, k: number): BM25Hit[] {
  const out = execSync(
    `qkb search ${JSON.stringify(question)} --json -n ${k} -c ${COLLECTION}`,
    { encoding: "utf-8" }
  );
  return JSON.parse(out);
}

function vectorSeeds(question: string, k: number): BM25Hit[] {
  // vsearch invokes LLM expansion + vector recall. Slow (~20s) but semantic-aware.
  try {
    const out = execSync(
      `qkb vsearch ${JSON.stringify(question)} --json -n ${k} -c ${COLLECTION} 2>/dev/null`,
      { encoding: "utf-8", timeout: 30000 }
    );
    // vsearch may emit progress lines before JSON; grab the JSON array
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    if (start < 0 || end < 0) return [];
    return JSON.parse(out.slice(start, end + 1));
  } catch (e) {
    return [];
  }
}

// ---------- 3. Build personalization vector ----------

const META_PATTERNS = [/^wiki\/hot\.md$/i, /^wiki\/index\.md$/i, /^wiki\/log\.md$/i, /^wiki\/meta\//i, /^site\/content\//i];
const isMeta = (path: string) => META_PATTERNS.some(rx => rx.test(path));

function buildPersonalization(question: string, hits: BM25Hit[], vecHits: BM25Hit[], nodes: Node[]): { e: Float64Array; sources: string[] } {
  const N = nodes.length;
  const e = new Float64Array(N);
  const sources: string[] = [];

  // path → idx lookup (tolerant of hyphen-vs-space drift)
  const pathIdx = new Map<string, number>();
  nodes.forEach((n, i) => {
    pathIdx.set(n.path.toLowerCase(), i);
    pathIdx.set(n.path.toLowerCase().replace(/-/g, " "), i);
  });

  // Strategy 1: BM25 hits (filter out meta pages first — they propagate noise)
  let bm25Total = 0;
  for (const hit of hits) {
    const m = hit.file.match(/^qkb:\/\/[^\/]+\/(.+?)(\?.*)?$/);
    if (!m) continue;
    const rawPath = m[1];
    if (isMeta(rawPath)) continue; // filter meta seeds — they're not concept anchors
    const i = pathIdx.get(rawPath.toLowerCase()) ?? pathIdx.get(rawPath.toLowerCase().replace(/-/g, " "));
    if (i !== undefined) {
      e[i] += hit.score;
      bm25Total += hit.score;
    }
  }
  if (bm25Total > 0) sources.push(`BM25 (${hits.filter(h => !isMeta(h.file.split('/').slice(3).join('/'))).length} non-meta hits)`);

  // Strategy 2: proper-noun fuzzy match on titles. ALWAYS run, additive to BM25.
  // Extract candidate phrases from the question:
  //   - capitalized multi-word phrases ("FAA NMS", "Cycle-Aware Publication Refresh")
  //   - single capitalized words >= 3 chars
  const phraseRegex = /\b([A-Z][a-zA-Z0-9-]+(?:[\s-][A-Z][a-zA-Z0-9-]+)*)\b/g;
  const phrases = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = phraseRegex.exec(question)) !== null) {
    if (m[1].length >= 3) phrases.add(m[1].toLowerCase());
  }
  // Also add bigrams of lowercased domain words. Limited heuristic; helps for prosey queries.
  const tokens = question.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/).filter(t => t.length >= 3);
  for (let i = 0; i < tokens.length - 1; i++) {
    phrases.add(`${tokens[i]} ${tokens[i + 1]}`);
  }

  let titleTotal = 0;
  let titleMatches = 0;
  for (const phrase of phrases) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (isMeta(n.path)) continue;
      const titleLower = n.title.toLowerCase();
      // Score: exact-substring = 1.0, fuzzy (word overlap >= 80%) = 0.5
      if (titleLower.includes(phrase)) {
        const weight = phrase.length >= 8 ? 1.0 : 0.3; // longer phrases more confident
        e[i] += weight;
        titleTotal += weight;
        titleMatches++;
      }
    }
  }
  if (titleMatches > 0) sources.push(`title-match (${titleMatches} title hits across ${phrases.size} phrases)`);

  // Strategy 3: vector similarity (LLM-expanded vsearch). Add with weight 0.5×
  // to mix with BM25 + title hits rather than dominate.
  let vecMatches = 0;
  for (const hit of vecHits) {
    const m = hit.file.match(/^qkb:\/\/[^\/]+\/(.+?)(\?.*)?$/);
    if (!m) continue;
    const rawPath = m[1];
    if (isMeta(rawPath)) continue;
    const i = pathIdx.get(rawPath.toLowerCase()) ?? pathIdx.get(rawPath.toLowerCase().replace(/-/g, " "));
    if (i !== undefined) {
      e[i] += hit.score * 0.5;
      vecMatches++;
    }
  }
  if (vecMatches > 0) sources.push(`vector (${vecMatches} hits)`);

  // L1-normalize
  const total = e.reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (let i = 0; i < N; i++) e[i] /= total;
  }

  return { e, sources };
}

// ---------- 4. Power iteration ----------

function ppr(
  csr: { indptr: Int32Array; indices: Int32Array; values: Float64Array },
  e: Float64Array,
  alpha: number,
  maxIter: number = 50,
  tol: number = 1e-6
): { p: Float64Array; iters: number } {
  const N = e.length;
  let p = new Float64Array(e);  // start at personalization
  let pNew = new Float64Array(N);

  // Identify dangling nodes (columns with no outgoing edges) — they redistribute
  // mass uniformly to all nodes (standard PageRank fix)
  const dangling: number[] = [];
  for (let j = 0; j < N; j++) {
    if (csr.indptr[j] === csr.indptr[j + 1]) dangling.push(j);
  }

  let iters = 0;
  for (let k = 0; k < maxIter; k++) {
    iters = k + 1;
    // p_new[i] = alpha * sum_{j: j→i} W[i,j] * p[j] + (1 - alpha) * e[i]
    // CSR is by source (column j), so we iterate columns:
    //   for each j: for each (i, w) in column j: p_new[i] += w * p[j]
    pNew.fill(0);

    // Edge contribution
    for (let j = 0; j < N; j++) {
      const pj = p[j];
      if (pj === 0) continue;
      const start = csr.indptr[j];
      const end = csr.indptr[j + 1];
      for (let off = start; off < end; off++) {
        pNew[csr.indices[off]] += csr.values[off] * pj;
      }
    }

    // Dangling-node mass: redistribute uniformly
    let danglingMass = 0;
    for (const j of dangling) danglingMass += p[j];
    if (danglingMass > 0) {
      const each = danglingMass / N;
      for (let i = 0; i < N; i++) pNew[i] += each;
    }

    // Scale by alpha, add teleport
    let l1diff = 0;
    for (let i = 0; i < N; i++) {
      const v = alpha * pNew[i] + (1 - alpha) * e[i];
      l1diff += Math.abs(v - p[i]);
      pNew[i] = v;
    }

    // Swap
    [p, pNew] = [pNew, p];

    if (l1diff < tol) break;
  }

  return { p, iters };
}

// ---------- 5. Top-N with meta demotion ----------

function topN(p: Float64Array, nodes: Node[], n: number, includeMeta: boolean = false): { node: Node; score: number }[] {
  const META_PATTERNS = [/^wiki\/hot\.md$/i, /^wiki\/index\.md$/i, /^wiki\/log\.md$/i, /^wiki\/meta\//i, /^site\/content\//i];

  const ranked = Array.from(nodes.entries())
    .map(([i, node]) => ({ node, score: p[i] }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const filtered = includeMeta
    ? ranked
    : ranked.filter(r => !META_PATTERNS.some(rx => rx.test(r.node.path)));

  return filtered.slice(0, n);
}

// ---------- 6. Run the spike ----------

const QUESTIONS: { tag: string; text: string; ground_truth: string[] }[] = [
  {
    tag: "Q13 (bench failure mode)",
    text: "If I'm implementing a new FAA data source ingestion pipeline, what existing patterns should I follow and why?",
    ground_truth: [
      "Atomic Pipeline Handler",
      "Schema-Drift Manifest",
      "Cycle-Aware Publication Refresh",  // the page Q13 graph skill missed
      "Lineage Invariant",
      "Two-Tier Storage Architecture",
    ],
  },
  {
    tag: "Q12 (sanity check)",
    text: "How does our Cycle-Aware Publication Refresh pattern relate to AIRAC Delta Polling — when do we use each?",
    ground_truth: [
      "Cycle-Aware Publication Refresh",
      "AIRAC Delta Polling",
      "AIRAC Cycle",
      "FAA NMS",
      "FAA NASR",
    ],
  },
];

console.log("RFC-0010 PPR spike\n" + "=".repeat(60));
console.log("Loading graph...");
const t0 = performance.now();
const { nodes, csr } = loadGraph();
const tLoad = performance.now() - t0;
console.log(`  ${nodes.length} nodes, ${csr.values.length} edges (LINKS_TO+EMBEDS+REFERENCES, ${COLLECTION} only)`);
console.log(`  load: ${tLoad.toFixed(1)}ms\n`);

const ALPHAS = [0.3, 0.5, 0.7, 0.85];

for (const q of QUESTIONS) {
  console.log("=".repeat(60));
  console.log(`${q.tag}: ${q.text}`);
  console.log("Ground truth (expect these in top-10):");
  for (const gt of q.ground_truth) console.log(`  - ${gt}`);
  console.log("");

  const tBM0 = performance.now();
  const hits = bm25Seeds(q.text, 8);
  const tBM = performance.now() - tBM0;
  console.log(`BM25 seeds (${tBM.toFixed(0)}ms, ${hits.length} hits)`);

  const tVS0 = performance.now();
  const vecHits = vectorSeeds(q.text, 5);
  const tVS = performance.now() - tVS0;
  console.log(`vector seeds (${tVS.toFixed(0)}ms, ${vecHits.length} hits)`);
  console.log("");

  const { e, sources } = buildPersonalization(q.text, hits, vecHits, nodes);
  const seedMass = Array.from(e).reduce((s, v) => s + v, 0);
  const seedCount = Array.from(e).filter(v => v > 0).length;
  console.log(`Personalization: seed sources = [${sources.join(", ")}]; ${seedCount} nodes seeded; L1=${seedMass.toFixed(3)}`);
  // Print top-5 seeded nodes
  const seeded = Array.from(e).map((v, i) => ({ v, i })).filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 5);
  for (const s of seeded) console.log(`  seed: ${(s.v * 100).toFixed(1).padStart(4)}%  ${nodes[s.i].title} (${nodes[s.i].path})`);
  console.log("");

  for (const alpha of ALPHAS) {
    const tPPR0 = performance.now();
    const { p, iters } = ppr(csr, e, alpha);
    const tPPR = performance.now() - tPPR0;
    const top = topN(p, nodes, 10);

    const gtHits = q.ground_truth.filter(gt =>
      top.some(r => r.node.title.toLowerCase().includes(gt.toLowerCase()))
    );

    console.log(`α=${alpha} | iters=${iters} | ${tPPR.toFixed(1)}ms | ground-truth hit: ${gtHits.length}/${q.ground_truth.length}`);
    for (const r of top.slice(0, 6)) {
      const isGT = q.ground_truth.some(gt => r.node.title.toLowerCase().includes(gt.toLowerCase()));
      console.log(`  ${(r.score * 1000).toFixed(2).padStart(6)} ‰  ${isGT ? "★ " : "  "}${r.node.title.padEnd(45)} ${r.node.path}`);
    }
    console.log("");
  }
}
