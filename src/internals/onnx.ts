import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  pipeline,
} from "@huggingface/transformers";

import type {
  EmbeddingResult,
  RerankDocument,
  RerankDocumentResult,
  RerankResult,
} from "./llm.js";

export const DEFAULT_ONNX_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_ONNX_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-4-v2";

// Let operators pre-seed or mirror models, but allow first-run downloads by default.
env.allowLocalModels = process.env.QKB_ONNX_ALLOW_LOCAL_MODELS !== "0";
env.allowRemoteModels = process.env.QKB_ONNX_ALLOW_REMOTE_MODELS !== "0";
if (process.env.QKB_ONNX_CACHE_DIR) {
  env.cacheDir = process.env.QKB_ONNX_CACHE_DIR;
}

type FeatureExtractor = Awaited<ReturnType<typeof pipeline>>;
type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type SequenceClassifier = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

type RerankerBundle = {
  tokenizer: Tokenizer;
  model: SequenceClassifier;
};

const extractorCache = new Map<string, Promise<FeatureExtractor>>();
const rerankerCache = new Map<string, Promise<RerankerBundle>>();

export function isOnnxModelUri(model: string | undefined): boolean {
  if (!model) return true;
  const normalized = model.toLowerCase();
  if (normalized.startsWith("hf:") || normalized.endsWith(".gguf") || normalized.includes("-gguf/")) {
    return false;
  }
  return true;
}

function normalizeOnnxModelName(model: string | undefined, fallback: string): string {
  if (!model || model === "embeddinggemma" || model.includes("qwen3-reranker")) {
    return fallback;
  }
  return model.startsWith("onnx:") ? model.slice("onnx:".length) : model;
}

function getExtractor(model: string): Promise<FeatureExtractor> {
  let promise = extractorCache.get(model);
  if (!promise) {
    promise = pipeline("feature-extraction", model, { quantized: true } as any);
    extractorCache.set(model, promise);
  }
  return promise;
}

function getReranker(model: string): Promise<RerankerBundle> {
  let promise = rerankerCache.get(model);
  if (!promise) {
    promise = Promise.all([
      AutoTokenizer.from_pretrained(model),
      AutoModelForSequenceClassification.from_pretrained(model, { quantized: true } as any),
    ]).then(([tokenizer, sequenceModel]) => ({ tokenizer, model: sequenceModel }));
    rerankerCache.set(model, promise);
  }
  return promise;
}

function tensorRows(tensor: any): number[][] {
  const dims = tensor.dims as number[];
  const data = Array.from(tensor.data as Iterable<number>);
  if (dims.length === 1) return [data];
  const rows = dims[0] ?? 0;
  const dim = dims[1] ?? data.length;
  const out: number[][] = [];
  for (let i = 0; i < rows; i++) {
    out.push(data.slice(i * dim, (i + 1) * dim));
  }
  return out;
}

export async function embedOnnx(
  text: string,
  options: { model?: string; isQuery?: boolean } = {},
): Promise<EmbeddingResult | null> {
  const model = normalizeOnnxModelName(options.model, DEFAULT_ONNX_EMBED_MODEL);
  const extractor = await getExtractor(model);
  const output = await extractor([text], { pooling: "mean", normalize: true, truncation: true });
  const row = tensorRows(output)[0];
  if (!row) return null;
  return { embedding: row, model };
}

export async function embedBatchOnnx(
  texts: string[],
  options: { model?: string; isQuery?: boolean } = {},
): Promise<(EmbeddingResult | null)[]> {
  if (texts.length === 0) return [];
  const model = normalizeOnnxModelName(options.model, DEFAULT_ONNX_EMBED_MODEL);
  const extractor = await getExtractor(model);
  const output = await extractor(texts, { pooling: "mean", normalize: true, truncation: true });
  return tensorRows(output).map((embedding) => ({ embedding, model }));
}

// Map a raw cross-encoder logit (unbounded) to a bounded [0,1] relevance score.
// Sigmoid is monotonic, so document ordering is preserved.
export function normalizeRerankLogit(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}

export async function rerankOnnx(
  query: string,
  documents: RerankDocument[],
  options: { model?: string } = {},
): Promise<RerankResult> {
  const modelName = normalizeOnnxModelName(options.model, DEFAULT_ONNX_RERANK_MODEL);
  const { tokenizer, model } = await getReranker(modelName);
  if (documents.length === 0) return { results: [], model: modelName };

  const inputs = await tokenizer(documents.map(() => query), {
    text_pair: documents.map((doc) => doc.text),
    padding: true,
    truncation: true,
    max_length: 512,
  });
  const outputs = await model(inputs);
  const logits = Array.from(outputs.logits.data as Iterable<number>);
  const dims = outputs.logits.dims as number[];

  const results: RerankDocumentResult[] = documents.map((doc, index) => {
    const logit = dims.length === 2 && (dims[1] ?? 0) > 1
      ? logits[index * dims[1]! + dims[1]! - 1]!
      : logits[index] ?? 0;
    return { file: doc.file, score: normalizeRerankLogit(logit), index };
  });

  results.sort((a, b) => b.score - a.score);
  return { results, model: modelName };
}
