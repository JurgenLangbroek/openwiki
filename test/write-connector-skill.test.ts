import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncBundledSkills } from "../src/agent/skills.ts";
import type { ConnectorDefinition } from "../src/connectors/types.ts";
import { openWikiSkillsDir } from "../src/openwiki-home.ts";
import { useTempOpenWikiHome } from "./support/temp-openwiki-home.ts";

/**
 * Fork-owned pins for the bundled write-connector skill.
 *
 * `skills/write-connector/SKILL.md` is upstream's file, so an upstream sync can
 * rewrite it. The fork edits it in two places (the posture guidance). Without a
 * pin, a later sync could silently replace that guidance with upstream's text,
 * which says nothing about the posture table.
 */

const SKILL_PATH = path.join(process.cwd(), "skills/write-connector/SKILL.md");

// Typed against the real definition: if a field leaves or enters
// `ConnectorDefinition`, `tsc` over this file fails until the list follows.
const DEFINITION_FIELDS = {
  backend: true,
  description: true,
  displayName: true,
  id: true,
  mode: true,
  requiredEnv: true,
  supportsAgenticDiscovery: true,
} satisfies Record<keyof ConnectorDefinition, true>;

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

    expect(shapeLine).toBeDefined();
    const named = (shapeLine ?? "")
      .split(" with ")[1]
      .replace(/\.$/, "")
      .split(/,\s*(?:and\s+)?/);
    expect([...named].sort()).toEqual(
      [...Object.keys(DEFINITION_FIELDS), "ingest()"].sort(),
    );
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
