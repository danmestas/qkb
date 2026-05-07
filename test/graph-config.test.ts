/**
 * Tests for the graph layer config namespace introduced in RFC-0007.
 *
 * PR-3 scope: minimal config plumbing + stub error class. No extension
 * loading, no SDK methods — just verify that:
 *   - graph config has sane defaults when absent
 *   - YAML round-trips for the documented fields
 *   - GraphDisabledError is throwable + identifiable
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  setConfigSource,
  type CollectionConfig,
} from "../src/collections.js";
import { GraphDisabledError, resolveGraphConfig } from "../src/graph/config.js";

describe("graph config", () => {
  describe("resolveGraphConfig", () => {
    it("applies all documented defaults when graph block is absent", () => {
      const config: CollectionConfig = { collections: {} };
      const resolved = resolveGraphConfig(config);

      expect(resolved).toEqual({
        enabled: false,
        bulk_insert_threshold: 64,
        query_timeout_ms: 5000,
        max_path_length: 6,
      });
    });

    it("respects user-provided enabled=true", () => {
      const config: CollectionConfig = {
        collections: {},
        graph: { enabled: true },
      };
      const resolved = resolveGraphConfig(config);
      expect(resolved.enabled).toBe(true);
    });

    it("respects each documented field independently", () => {
      const config: CollectionConfig = {
        collections: {},
        graph: {
          enabled: true,
          bulk_insert_threshold: 256,
          query_timeout_ms: 10000,
          max_path_length: 4,
        },
      };
      const resolved = resolveGraphConfig(config);
      expect(resolved).toEqual({
        enabled: true,
        bulk_insert_threshold: 256,
        query_timeout_ms: 10000,
        max_path_length: 4,
      });
    });

    it("merges partial graph block with defaults", () => {
      const config: CollectionConfig = {
        collections: {},
        graph: { enabled: true, query_timeout_ms: 1000 },
      };
      const resolved = resolveGraphConfig(config);
      expect(resolved).toEqual({
        enabled: true,
        bulk_insert_threshold: 64,
        query_timeout_ms: 1000,
        max_path_length: 6,
      });
    });

    it("rejects invalid types (string for boolean)", () => {
      const config = {
        collections: {},
        graph: { enabled: "yes" as unknown as boolean },
      } as CollectionConfig;
      expect(() => resolveGraphConfig(config)).toThrow(/enabled.*boolean/i);
    });

    it("rejects negative or zero query_timeout_ms", () => {
      const config: CollectionConfig = {
        collections: {},
        graph: { enabled: true, query_timeout_ms: 0 },
      };
      expect(() => resolveGraphConfig(config)).toThrow(/query_timeout_ms/);
    });

    it("rejects max_path_length above hard ceiling of 12", () => {
      const config: CollectionConfig = {
        collections: {},
        graph: { enabled: true, max_path_length: 99 },
      };
      expect(() => resolveGraphConfig(config)).toThrow(/max_path_length/);
    });
  });

  describe("YAML round-trip", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "qkb-graph-config-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      setConfigSource(); // reset
    });

    it("loads graph config from YAML and resolves defaults", () => {
      const yamlPath = join(tmpDir, "index.yml");
      writeFileSync(
        yamlPath,
        [
          "collections: {}",
          "graph:",
          "  enabled: true",
          "  query_timeout_ms: 7500",
          "",
        ].join("\n")
      );

      setConfigSource({ configPath: yamlPath });
      const resolved = resolveGraphConfig(loadConfig());

      expect(resolved.enabled).toBe(true);
      expect(resolved.query_timeout_ms).toBe(7500);
      expect(resolved.bulk_insert_threshold).toBe(64); // default
      expect(resolved.max_path_length).toBe(6); // default
    });
  });

  describe("GraphDisabledError", () => {
    it("is identifiable by instanceof", () => {
      const err = new GraphDisabledError(
        "graph layer is disabled; set graph.enabled=true to use this feature"
      );
      expect(err).toBeInstanceOf(GraphDisabledError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("GraphDisabledError");
    });

    it("preserves the message", () => {
      const msg = "specific reason for refusal";
      const err = new GraphDisabledError(msg);
      expect(err.message).toBe(msg);
    });
  });
});
