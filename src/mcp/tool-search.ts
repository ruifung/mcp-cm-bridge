/**
 * Tool search — pluggable search interface and BM25 keyword implementation.
 *
 * Provides fast, synchronous keyword-based search over the tool index.
 * The interface is backend-agnostic so a vector/embedding implementation
 * can be swapped in later.
 */

import { generateTypes, jsonSchemaToZod } from "./schema-utils.js";
import type { UpstreamMcpClientManager } from "./upstream-mcp-client-manager.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface ToolSearchEntry {
  /** Sanitized callable name (e.g. `gitlab__list_mrs`) */
  name: string;
  /** Tool description */
  description: string;
  /** Original JSON Schema from the upstream MCP server */
  rawSchema: any;
}

export interface ToolSearchResult {
  /** Sanitized callable name as used in eval code */
  name: string;
  /** Tool description */
  description: string;
  /** TypeScript type definition snippet generated from the tool's input schema */
  schema: string;
}

export interface ToolSearchProvider {
  /**
   * Build (or rebuild) the search index from the given tool entries.
   * Replaces any previous index entirely.
   */
  build(entries: ToolSearchEntry[]): void;
  /**
   * Search for tools matching the query.
   * Returns up to `limit` results sorted by descending relevance score.
   */
  search(query: string, limit: number): ToolSearchResult[];
  /**
   * Atomically replace the current index with a new one built from `entries`.
   * Equivalent to build() but signals the intent of a live-reload swap.
   */
  rebuild(entries: ToolSearchEntry[]): void;
}

// ── BM25 implementation ──────────────────────────────────────────────────────

interface IndexedDocument {
  entry: ToolSearchEntry;
  /** Pre-computed TypeScript schema snippet (generated once at index build time) */
  schemaSnippet: string;
  /** Term frequency map for this document */
  tf: Map<string, number>;
  /** Total number of terms in the document (for length normalisation) */
  length: number;
}

/**
 * BM25-based keyword search provider.
 *
 * Tokenisation: lowercase, split on non-alphanumeric characters, discard
 * empty strings and single-character tokens.
 *
 * Default BM25 parameters: k1=1.2, b=0.75.
 */
export class BM25SearchProvider implements ToolSearchProvider {
  private readonly k1: number;
  private readonly b: number;

  private docs: IndexedDocument[] = [];
  private idf: Map<string, number> = new Map();
  private avgDocLength = 0;

  constructor(options?: { k1?: number; b?: number }) {
    this.k1 = options?.k1 ?? 1.2;
    this.b = options?.b ?? 0.75;
  }

  build(entries: ToolSearchEntry[]): void {
    // Build per-document term frequencies and pre-compute schema snippets
    this.docs = entries.map((entry) => {
      const terms = tokenize(`${entry.name} ${entry.description}`);
      const tf = new Map<string, number>();
      for (const term of terms) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
      }
      const schemaSnippet = generateSchemaSnippet(entry.name, entry.rawSchema);
      return { entry, schemaSnippet, tf, length: terms.length };
    });

    // Compute average document length
    this.avgDocLength =
      this.docs.length === 0
        ? 0
        : this.docs.reduce((sum, d) => sum + d.length, 0) / this.docs.length;

    // Compute IDF for every term across the corpus
    const dfMap = new Map<string, number>();
    for (const doc of this.docs) {
      for (const term of doc.tf.keys()) {
        dfMap.set(term, (dfMap.get(term) ?? 0) + 1);
      }
    }

    const N = this.docs.length;
    this.idf = new Map();
    for (const [term, df] of dfMap.entries()) {
      // Robertson–Spärck Jones IDF with smoothing to avoid log(0)
      this.idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    }
  }

  search(query: string, limit: number): ToolSearchResult[] {
    if (this.docs.length === 0) {
      return [];
    }

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
      return [];
    }

    // Score each document
    const scored: Array<{ doc: IndexedDocument; score: number }> = [];

    for (const doc of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf === 0) continue;
        const idf = this.idf.get(term) ?? 0;
        const numerator = tf * (this.k1 + 1);
        const denominator =
          tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDocLength));
        score += idf * (numerator / denominator);
      }
      if (score > 0) {
        scored.push({ doc, score });
      }
    }

    // Sort descending by score, take top `limit`
    scored.sort((a, b) => b.score - a.score);
    const topN = scored.slice(0, limit);

    // Build results using the pre-computed schema snippets
    return topN.map(({ doc }) => {
      const { entry, schemaSnippet } = doc;
      return {
        name: entry.name,
        description: entry.description,
        schema: schemaSnippet,
      };
    });
  }

  rebuild(entries: ToolSearchEntry[]): void {
    this.build(entries);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Tokenise a string into lowercase alphanumeric terms.
 * Single-character tokens are discarded (noise).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Generate a TypeScript type snippet for a single tool using generateTypes().
 * Falls back to an empty string on any error.
 */
function generateSchemaSnippet(name: string, rawSchema: any): string {
  try {
    const zodSchema = jsonSchemaToZod(rawSchema ?? {});
    const snippet = generateTypes({
      [name]: {
        description: undefined,
        inputSchema: zodSchema,
      },
    });
    return snippet;
  } catch {
    return "";
  }
}

/**
 * Build a ToolSearchEntry array from the ServerManager's current tool set.
 * Convenience helper used by server.ts to populate the search index.
 */
export function buildSearchEntries(serverManager: UpstreamMcpClientManager): ToolSearchEntry[] {
  return serverManager.getToolList().map(({ name, description }) => {
    const descriptor = serverManager.getToolByName(name);
    return {
      name,
      description,
      rawSchema: descriptor?.rawSchema ?? {},
    };
  });
}
