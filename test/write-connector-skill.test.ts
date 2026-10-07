import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncBundledSkills } from "../src/agent/skills.ts";
import { openWikiSkillsDir } from "../src/openwiki-home.ts";
import { useTempOpenWikiHome } from "./support/temp-openwiki-home.ts";

/**
 * Fork-owned pins for the bundled write-connector skill.
 *
 * `skills/write-connector/SKILL.md` is upstream's file, so an upstream sync can
 * rewrite it. The fork edits it in four places: the posture-table bullet, the
 * "posture is the live axis" bullet, the `mode` field and bullet, and the
 * wiring bullets (CONNECTOR_IDS and friends). Without a pin, a later sync could
 * silently replace that guidance with upstream's text, which says nothing about
 * the posture table.
 */

const SKILL_PATH = path.join(process.cwd(), "skills/write-connector/SKILL.md");

/**
 * The required keys of `ConnectorDefinition`, read from the real source.
 *
 * A type-level guard (`satisfies Record<keyof ConnectorDefinition, true>`) would
 * be cleaner, but `pnpm typecheck` skips `test/`, so it would never run. This
 * parses the `export type ConnectorDefinition = { ... }` block as text. The limit:
 * it assumes one `key: type;` per line at two-space indent, which is how prettier
 * formats the block. A restructured block fails the sanity checks below with a
 * message that names the cause.
 */
async function readRequiredDefinitionKeys(): Promise<string[]> {
  const source = await readFile(
    path.join(process.cwd(), "src/connectors/types.ts"),
    "utf8",
  );
  const block = /export type ConnectorDefinition = \{\n([\s\S]*?)\n\};/.exec(
    source,
  );
  expect(
    block,
    "could not find `export type ConnectorDefinition = {` in src/connectors/types.ts; update readRequiredDefinitionKeys",
  ).not.toBeNull();
  const keys = [...(block?.[1] ?? "").matchAll(/^ {2}(\w+)(\??):/gm)]
    .filter((match) => match[2] !== "?")
    .map((match) => match[1]);
  expect(
    keys,
    "parsed no required keys from ConnectorDefinition; update readRequiredDefinitionKeys",
  ).toContain("id");
  return keys;
}

describe("write-connector skill file", () => {
  test("ships with the front matter the skill loader keys on", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");

    expect(skill.startsWith("---\nname: write-connector\n")).toBe(true);
    expect(skill).toContain("\ndescription:");
  });

  test("names every field a ConnectorDefinition requires, plus ingest()", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const shapeLine = skill
      .split("\n")
      .find((line) => line.includes("must expose a ConnectorRuntime"));

    expect(shapeLine, "the field-list bullet is missing").toBeDefined();
    const parts = (shapeLine ?? "").split(" with ");
    expect(
      parts.length,
      'the field-list bullet no longer reads "... with a, b, and c."',
    ).toBeGreaterThan(1);
    const named = parts[1].replace(/\.$/, "").split(/,\s*(?:and\s+)?/);
    expect([...named].sort()).toEqual(
      [...(await readRequiredDefinitionKeys()), "ingest()"].sort(),
    );
  });

  test("explains how to pick mode and where to register a new connector id", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");

    expect(skill).toContain('Set mode to "code" only for');
    expect(skill).toContain('Set mode to "personal" for');
    for (const wiring of [
      "CONNECTOR_IDS in src/connectors/registry.ts",
      "createConnectorSynthesisGuidance in src/ingestion.ts",
      "isKnownConnectorId in src/onboarding.ts",
      "SOURCE_OPTIONS in src/credentials.tsx",
    ]) {
      expect(skill).toContain(wiring);
    }
  });

  test("tells the author to declare posture in the fork-owned table, not on the definition", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");

    expect(skill).toContain(
      "Declare the connector's posture in the table in src/connectors/posture.ts",
    );
    expect(skill).toContain(
      "The table is exhaustive, so a new connector id does not compile until its posture is declared.",
    );
    expect(skill).toContain(
      "supportsAgenticDiscovery is a required field nothing here reads; set it, but never wire a decision to it.",
    );
    // Posture is not a ConnectorDefinition field, so the field list must not
    // offer it as one.
    const shapeLine = skill
      .split("\n")
      .find((line) => line.includes("must expose a ConnectorRuntime"));
    expect(shapeLine).not.toContain("posture");
  });

  test("no longer ships as a string embedded in code", () => {
    expect(
      existsSync(
        path.join(process.cwd(), "src/connectors/write-connector-skill.ts"),
      ),
    ).toBe(false);
  });
});

describe("syncBundledSkills", () => {
  test("the agent run calls it before building the agent", async () => {
    // Source-text pin: the agent factory is too heavy to run here, and no other
    // test notices if this call disappears and the skill stops installing.
    const source = await readFile(
      path.join(process.cwd(), "src/agent/index.ts"),
      "utf8",
    );

    expect(source).toMatch(/^\s*await syncBundledSkills\(\);$/m);
  });

  let home: string;

  beforeEach(async () => {
    home = await useTempOpenWikiHome("openwiki-bundled-skills-");
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  test("installs write-connector into the OpenWiki home and keeps unrelated skills", async () => {
    const custom = path.join(openWikiSkillsDir, "my-own-skill");
    await mkdir(custom, { recursive: true });
    await writeFile(path.join(custom, "SKILL.md"), "mine");

    await syncBundledSkills();

    await expect(
      readFile(path.join(openWikiSkillsDir, "write-connector", "SKILL.md")),
    ).resolves.toEqual(await readFile(SKILL_PATH));
    await expect(readFile(path.join(custom, "SKILL.md"), "utf8")).resolves.toBe(
      "mine",
    );
  });
});
