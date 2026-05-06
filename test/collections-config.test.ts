/**
 * Unit tests for collection config path resolution (PR #190).
 *
 * Tests that getConfigDir() respects XDG_CONFIG_HOME, QKB_CONFIG_DIR,
 * and falls back to ~/.config/qkb.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { homedir } from "os";
import { getConfigPath, setConfigIndexName } from "../src/collections.js";

// Save/restore env vars around each test
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    QKB_CONFIG_DIR: process.env.QKB_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  // Reset index name to default
  setConfigIndexName("index");
});

afterEach(() => {
  // Reset index name to default (prevents leaking into other test files under bun test)
  setConfigIndexName("index");
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

describe("getConfigDir via getConfigPath", () => {
  test("defaults to ~/.config/qkb when no env vars are set", () => {
    delete process.env.QKB_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    expect(getConfigPath()).toBe(join(homedir(), ".config", "qkb", "index.yml"));
  });

  test("QKB_CONFIG_DIR takes highest priority", () => {
    process.env.QKB_CONFIG_DIR = "/custom/qmd-config";
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    expect(getConfigPath()).toBe(join("/custom/qmd-config", "index.yml"));
  });

  test("XDG_CONFIG_HOME is used when QKB_CONFIG_DIR is not set", () => {
    delete process.env.QKB_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    expect(getConfigPath()).toBe(join("/xdg/config", "qkb", "index.yml"));
  });

  test("XDG_CONFIG_HOME appends qkb subdirectory", () => {
    delete process.env.QKB_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = "/home/agent/.config";
    expect(getConfigPath()).toBe(join("/home/agent/.config", "qkb", "index.yml"));
  });

  test("QKB_CONFIG_DIR overrides XDG_CONFIG_HOME", () => {
    process.env.QKB_CONFIG_DIR = "/override";
    process.env.XDG_CONFIG_HOME = "/should-not-use";
    expect(getConfigPath()).toBe(join("/override", "index.yml"));
  });

  test("respects custom index name", () => {
    delete process.env.QKB_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    setConfigIndexName("myindex");
    expect(getConfigPath()).toBe(join("/xdg/config", "qkb", "myindex.yml"));
  });
});
