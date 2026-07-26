import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getCredentialDiagnostics,
  loadOpenWikiEnv,
  openWikiEnvPath,
  saveOpenWikiEnv,
} from "../src/env.ts";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../src/constants.ts";
import { resetOpenWikiHomePaths } from "../src/openwiki-home.ts";

// `loadOpenWikiEnv`, `saveOpenWikiEnv`, and `getCredentialDiagnostics` all read
// from / write to the `.env` file under the OpenWiki home. Pointing
// OPENWIKI_HOME at a throwaway temp directory keeps these tests fully isolated
// from the developer's real credentials and machine.
//
// The existing `test/env.test.ts` covers the pure `parseEnv`/`formatEnv`
// serializers. This file covers the runtime behavior of the three functions
// above — the deprecation-dropping, source resolution, file permissions, and
// secret masking — which previously had no coverage.

const KEYS_UNDER_TEST = [
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
] as const;

let originalHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  originalHome = process.env.OPENWIKI_HOME;
  tempHome = await mkdtemp(path.join(tmpdir(), "openwiki-env-behavior-"));
  // The modules under test are imported statically, so their home paths were
  // already resolved from the ambient OPENWIKI_HOME. Re-resolve them against the
  // temp home, or this file reads and writes the developer's real ~/.openwiki.
  process.env.OPENWIKI_HOME = tempHome;
  resetOpenWikiHomePaths();

  // Assert the isolation rather than trusting it. Every other test file that
  // reaches the OpenWiki home fails loudly if its reset is dropped, because its
  // expectations name the temp directory. This file only ever round-trips
  // through `openWikiEnvPath`, so without the reset it would happily write the
  // developer's real credential file and still pass. This is the only thing
  // standing between a dropped reset and a clobbered ~/.openwiki/.env.
  expect(openWikiEnvPath).toBe(path.join(tempHome, ".env"));

  for (const key of KEYS_UNDER_TEST) {
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of KEYS_UNDER_TEST) {
    delete process.env[key];
  }

  if (originalHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalHome;
  }

  await rm(tempHome, { recursive: true, force: true });
});

describe("loadOpenWikiEnv", () => {
  test("never applies an OPENWIKI_HOME line found in the .env file", async () => {
    // OPENWIKI_HOME selects *which* `.env` is read, so honouring a copy stored
    // inside that file would relocate the home based on a file read out of the
    // home it is relocating away from, and would leave process.env disagreeing
    // with the already-resolved path bindings. The override is deleted here on
    // purpose: the copy loop only fills keys that are unset, so an ambient
    // OPENWIKI_HOME would satisfy this test for the wrong reason. The bindings
    // still point at tempHome throughout — only the process env is unset.
    await mkdir(path.dirname(openWikiEnvPath), { recursive: true });
    await writeFile(
      openWikiEnvPath,
      [
        "OPENWIKI_HOME=/somewhere/else",
        `${OPENAI_API_KEY_ENV_KEY}=sk-kept`,
      ].join("\n") + "\n",
      "utf8",
    );
    delete process.env.OPENWIKI_HOME;

    const env = await loadOpenWikiEnv();

    // Still parsed and returned — the file is reported faithfully…
    expect(env.OPENWIKI_HOME).toBe("/somewhere/else");
    // …but never applied, so the home cannot move underneath the bindings.
    expect(process.env.OPENWIKI_HOME).toBeUndefined();
    expect(openWikiEnvPath).toBe(path.join(tempHome, ".env"));
    // Other keys from the same file still load normally.
    expect(process.env[OPENAI_API_KEY_ENV_KEY]).toBe("sk-kept");
  });

  test("loads a saved managed key into process.env", async () => {
    await saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-test" });

    delete process.env[OPENROUTER_API_KEY_ENV_KEY];

    await loadOpenWikiEnv();

    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBe("sk-or-test");
  });

  test("does not overwrite a key already present in process.env", async () => {
    await saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "from-file" });

    process.env[OPENROUTER_API_KEY_ENV_KEY] = "from-process-env";

    await loadOpenWikiEnv();

    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBe("from-process-env");
  });

  test("currently drops deprecated OpenAI keys from process.env", async () => {
    // Pins the existing behavior: OPENAI_BASE_URL / OPENAI_ORG_ID /
    // OPENAI_PROJECT are in the deprecated list and are never loaded into
    // process.env, even when present in ~/.openwiki/.env. Changing this
    // (e.g. un-deprecating OPENAI_BASE_URL) should be a deliberate decision
    // that updates this expectation.
    await mkdir(path.dirname(openWikiEnvPath), { recursive: true });
    await writeFile(
      openWikiEnvPath,
      [
        "OPENAI_BASE_URL=https://gateway.example.com/v1",
        "OPENAI_ORG_ID=org-123",
        "OPENAI_PROJECT=proj-456",
        `${OPENAI_API_KEY_ENV_KEY}=sk-kept`,
      ].join("\n") + "\n",
      "utf8",
    );

    await loadOpenWikiEnv();

    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_ORG_ID).toBeUndefined();
    expect(process.env.OPENAI_PROJECT).toBeUndefined();
    expect(process.env[OPENAI_API_KEY_ENV_KEY]).toBe("sk-kept");
  });
});

describe("saveOpenWikiEnv", () => {
  test("persists a value that loadOpenWikiEnv can round-trip", async () => {
    await saveOpenWikiEnv({
      [OPENWIKI_PROVIDER_ENV_KEY]: "openrouter",
      [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-roundtrip",
    });

    delete process.env[OPENWIKI_PROVIDER_ENV_KEY];
    delete process.env[OPENROUTER_API_KEY_ENV_KEY];

    await loadOpenWikiEnv();

    expect(process.env[OPENWIKI_PROVIDER_ENV_KEY]).toBe("openrouter");
    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBe("sk-or-roundtrip");
  });

  test("writes the env file with 0600 permissions", async () => {
    await saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-test" });

    const mode = (await stat(openWikiEnvPath)).mode & 0o777;

    // Owner read/write only; no group/other bits.
    expect(mode & 0o077).toBe(0);
    expect(mode & 0o600).toBe(0o600);
  });

  test("never persists OPENWIKI_HOME into the env file", async () => {
    // The reverse direction of the exclusion: a stale OPENWIKI_HOME already in
    // the file must not survive a save, and a caller that passes one must not
    // get it written. Otherwise a later read would hand the home a value out of
    // the home's own credential file.
    await mkdir(path.dirname(openWikiEnvPath), { recursive: true });
    await writeFile(openWikiEnvPath, "OPENWIKI_HOME=/stale/home\n", "utf8");

    await saveOpenWikiEnv({
      OPENWIKI_HOME: "/somewhere/else",
      [OPENAI_API_KEY_ENV_KEY]: "sk-kept",
    });

    const contents = await readFile(openWikiEnvPath, "utf8");

    expect(contents).not.toContain("OPENWIKI_HOME");
    expect(contents).toContain(`${OPENAI_API_KEY_ENV_KEY}="sk-kept"`);
    // The write landed in the temp home, not wherever the passed value pointed.
    expect(openWikiEnvPath).toBe(path.join(tempHome, ".env"));

    // Known residue, pinned rather than hidden: saveOpenWikiEnv's trailing
    // process.env mirror still reflects whatever the caller passed, so a caller
    // that passes OPENWIKI_HOME does move process.env even though nothing is
    // persisted and the bindings stay put. Nothing in OpenWiki passes that key,
    // and guarding that loop would fork a function body upstream rewrites
    // wholesale — the one thing this ticket exists to avoid. If someone closes
    // it, this expectation should fail and be deleted deliberately.
    expect(process.env.OPENWIKI_HOME).toBe("/somewhere/else");
  });

  test("strips deprecated keys from the persisted file", async () => {
    // A deprecated key written by an older OpenWiki version must not survive a
    // subsequent save, so stale deprecated values can't linger in the file.
    await mkdir(path.dirname(openWikiEnvPath), { recursive: true });
    await writeFile(openWikiEnvPath, "OPENAI_ORG_ID=stale-org\n", "utf8");

    await saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-fresh" });

    const contents = await readFile(openWikiEnvPath, "utf8");

    expect(contents).not.toContain("OPENAI_ORG_ID");
    expect(contents).toContain("OPENAI_API_KEY=");
  });

  test("seeds process.env with the saved value immediately", async () => {
    await saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-immediate" });

    expect(process.env[OPENAI_API_KEY_ENV_KEY]).toBe("sk-immediate");
  });
});

describe("getCredentialDiagnostics", () => {
  test("includes the provider and each credential key in display order", async () => {
    const diagnostics = await getCredentialDiagnostics();
    const keys = diagnostics.map((entry) => entry.key);

    expect(keys[0]).toBe(OPENWIKI_PROVIDER_ENV_KEY);
    expect(keys).toContain(OPENAI_API_KEY_ENV_KEY);
    expect(keys).toContain(ANTHROPIC_API_KEY_ENV_KEY);
    expect(keys).toContain(OPENROUTER_API_KEY_ENV_KEY);
    // Keys are unique.
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("reports an unset key as unset with no warnings", async () => {
    await rm(openWikiEnvPath, { force: true });

    const diagnostics = await getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENROUTER_API_KEY_ENV_KEY,
    );

    expect(entry?.source).toBe("unset");
    expect(entry?.length).toBeNull();
    expect(entry?.preview).toBe("<unset>");
    expect(entry?.warnings).toEqual([]);
  });

  test("masks a secret value rather than echoing it", async () => {
    await saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-secret-12345" });

    const diagnostics = await getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENAI_API_KEY_ENV_KEY,
    );

    expect(entry?.preview).not.toContain("sk-secret-12345");
    expect(entry?.length).toBe("sk-secret-12345".length);
  });

  test("surfaces a non-secret base URL verbatim, not masked", async () => {
    await saveOpenWikiEnv({
      [ANTHROPIC_BASE_URL_ENV_KEY]: "https://gateway.example.com/anthropic",
    });

    const diagnostics = await getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === ANTHROPIC_BASE_URL_ENV_KEY,
    );

    expect(entry?.preview).toBe('"https://gateway.example.com/anthropic"');
  });

  test("flags an invalid model ID with a warning", async () => {
    await saveOpenWikiEnv({ [OPENWIKI_MODEL_ID_ENV_KEY]: "bad model id" });

    const diagnostics = await getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENWIKI_MODEL_ID_ENV_KEY,
    );

    expect(entry?.warnings).toContain("invalid model ID");
  });

  test("flags an invalid provider with a warning", async () => {
    await saveOpenWikiEnv({ [OPENWIKI_PROVIDER_ENV_KEY]: "not-a-provider" });

    const diagnostics = await getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENWIKI_PROVIDER_ENV_KEY,
    );

    expect(entry?.warnings).toContain("invalid provider");
  });

  test("prefers process.env over the file when both are set", async () => {
    await saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "from-file" });

    // Override process.env after the save seeds it.
    process.env[OPENROUTER_API_KEY_ENV_KEY] = "from-process-env";

    const diagnostics = await getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENROUTER_API_KEY_ENV_KEY,
    );

    expect(entry?.source).toBe("process.env over ~/.openwiki/.env");
  });
});
