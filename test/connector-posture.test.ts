import { describe, expect, test } from "vitest";
import { CONNECTOR_POSTURES } from "../src/connectors/posture.ts";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
} from "../src/connectors/registry.ts";

describe("Connector Posture table", () => {
  test("declares a posture for every connector id and nothing else", () => {
    expect(Object.keys(CONNECTOR_POSTURES).sort()).toEqual(
      [...CONNECTOR_IDS].sort(),
    );
  });

  test("pins the exact posture of every connector, one row at a time", () => {
    expect(CONNECTOR_POSTURES).toEqual({
      "git-repo": "agentic",
      glean: "hybrid",
      google: "deterministic",
      hackernews: "deterministic",
      // langsmith arrived with the upstream sync, after the table existed.
      // Upstream declares supportsAgenticDiscovery: false / mode: "code", so
      // deterministic is the faithful mapping (decisions.md D5/Q9).
      langsmith: "deterministic",
      notion: "agentic",
      slack: "deterministic",
      "web-search": "deterministic",
      x: "deterministic",
    });
  });
});

describe("Connector registry", () => {
  test("stamps each connector runtime with its declared posture", () => {
    const registry = createConnectorRegistry();

    for (const id of CONNECTOR_IDS) {
      expect(registry[id].posture).toBe(CONNECTOR_POSTURES[id]);
    }
  });

  test("leaves the rest of the connector definition untouched", () => {
    const registry = createConnectorRegistry();

    expect(registry.glean.id).toBe("glean");
    expect(registry.glean.displayName).toBe("Glean");
    expect(registry.glean.supportsAgenticDiscovery).toBe(true);
    expect(registry.google.supportsAgenticDiscovery).toBe(false);
    expect(typeof registry.glean.ingest).toBe("function");
  });
});
