import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect } from "vitest";

/*
 * Suite-wide guard for the OpenWiki home. `vitest.config.ts` loads this module
 * as a `setupFiles` entry, so its top level runs once per test file, before the
 * test file — and therefore before `src/openwiki-home.ts` — is imported.
 *
 * Why it exists: `src/openwiki-home.ts` resolves the home into `export let`
 * bindings at module load (ADR-0004). A test file that statically imports the
 * code under test and only *then* sets OPENWIKI_HOME reads and writes whatever
 * the home resolved to at load time — which, without this guard, is the
 * developer's real `~/.openwiki`: their personal brain wiki and their
 * credential file at mode 0600. That is not hypothetical; a test file in this
 * repo once passed 14 of 14 while writing a real credential file. Individual
 * `resetOpenWikiHomePaths()` calls close individual instances of the hazard;
 * this file closes the class, so no author has to remember anything for the
 * developer's home to stay untouched.
 *
 * It severs both routes to a real home, before any test module loads:
 *
 * - OPENWIKI_HOME is cleared, so the suite never inherits a home a developer
 *   happens to export (that variable is how the personal brain wiki is pointed
 *   at a working copy, so inheriting it is the same hazard wearing a hat).
 * - HOME and USERPROFILE point *through a regular file*, so `os.homedir()` —
 *   the fallback `resolveOpenWikiHomeDir()` uses once OPENWIKI_HOME is gone —
 *   yields a path that cannot be created, listed, or written.
 *
 * Failure, not redirection: anything that reaches for the home without being
 * told where it is fails at the first IO with ENOTDIR naming this guard, rather
 * than quietly succeeding against a sandbox. A sandbox default would keep such
 * a test green while it verified nothing — which is the shape of the bug this
 * guard exists to prevent, minus the data loss. Path arithmetic still works, so
 * the `~/.openwiki` fallback can still be asserted as a string.
 *
 * Tests that need a home therefore say so: `useTempOpenWikiHome()` from
 * ./temp-openwiki-home.ts, or upstream's idiom of pointing HOME at a temp
 * directory before importing the code under test. Both are left alone here.
 * The one test that must see the developer's actual home to assert the fallback
 * opts out through `withRealHomeDirForFallbackAssertions()` below.
 */

const REAL_HOME_DIR = os.homedir();

const TEMP_ROOTS = uniqueTempRoots();

const guardDir = mkdtempSync(path.join(os.tmpdir(), "openwiki-home-guard-"));

/*
 * A regular file, on purpose. HOME is set to a path *below* it, so every mkdir
 * or open under `os.homedir()` fails with ENOTDIR and the error text carries
 * this name straight to whoever reads the failure.
 */
const blockedRealHomeMarker = path.join(
  guardDir,
  "real-home-blocked-by-test-support-openwiki-home-guard",
);
writeFileSync(
  blockedRealHomeMarker,
  "The vitest OpenWiki home guard replaced HOME with a path below this file so " +
    "that no test can reach the developer's real ~/.openwiki. A test that needs " +
    "a home should call useTempOpenWikiHome(). See " +
    "test/support/openwiki-home-guard.ts.\n",
  { mode: 0o600 },
);

const blockedHomeDir = path.join(blockedRealHomeMarker, "home");

delete process.env.OPENWIKI_HOME;
process.env.HOME = blockedHomeDir;
process.env.USERPROFILE = blockedHomeDir;

/**
 * Test files that may look at the developer's real home directory.
 *
 * Adding an entry is the sanctioned opt-out, and it is deliberately awkward: it
 * cannot be done from the test file that wants it, so it always shows up as an
 * edit to this guard. `test/openwiki-home.test.ts` is here because it is the
 * oracle for the `~/.openwiki` fallback, and asserting that fallback is the one
 * thing that cannot be done against a blocked home.
 */
const FILES_ALLOWED_TO_SEE_THE_REAL_HOME = new Set([
  path.join("test", "openwiki-home.test.ts"),
]);

/**
 * Run `assertion` with HOME restored to the developer's real home directory,
 * and hand it that directory.
 *
 * Only for asserting the `~/.openwiki` fallback, and only from a file listed in
 * `FILES_ALLOWED_TO_SEE_THE_REAL_HOME` — calling it anywhere else throws. The
 * callback is synchronous so the window stays as small as the assertions
 * themselves. Never perform IO inside it: for the length of the callback the
 * home paths can resolve to the developer's real files.
 */
export function withRealHomeDirForFallbackAssertions<T>(
  assertion: (realHomeDir: string) => T,
): T {
  assertCallerMaySeeTheRealHome();

  const blocked = process.env.HOME;
  process.env.HOME = REAL_HOME_DIR;
  process.env.USERPROFILE = REAL_HOME_DIR;

  try {
    return assertion(REAL_HOME_DIR);
  } finally {
    process.env.HOME = blocked;
    process.env.USERPROFILE = blocked;
  }
}

function assertCallerMaySeeTheRealHome(): void {
  const testPath = expect.getState().testPath;
  const relativePath = testPath
    ? path.relative(process.cwd(), testPath)
    : "<unknown test file>";

  if (!FILES_ALLOWED_TO_SEE_THE_REAL_HOME.has(relativePath)) {
    throw new Error(
      `${relativePath} is not allowed to see the real home directory. ` +
        "withRealHomeDirForFallbackAssertions() exists for asserting the " +
        "~/.openwiki fallback and nothing else; point OPENWIKI_HOME at a temp " +
        "directory with useTempOpenWikiHome() instead. If this really is a " +
        "fallback oracle, add the file to FILES_ALLOWED_TO_SEE_THE_REAL_HOME " +
        "in test/support/openwiki-home-guard.ts and say why in review.",
    );
  }
}

/*
 * The guard is only worth anything while it is intact, so check it at every test
 * boundary. These hooks are registered before any hook in the test file, which
 * means the beforeEach runs first and the afterEach runs last: both see the
 * state the file itself has settled on rather than a transient one.
 */
beforeEach(assertGuardIsIntact);
afterEach(assertGuardIsIntact);

afterAll(() => {
  rmSync(guardDir, { force: true, recursive: true });
});

function assertGuardIsIntact(): void {
  const override = process.env.OPENWIKI_HOME?.trim();

  if (override) {
    assertUnderTempRoot(
      path.resolve(override),
      `OPENWIKI_HOME points at ${override}, which is outside the OS temp directory.`,
    );
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;

  if (home !== blockedHomeDir) {
    assertUnderTempRoot(
      path.resolve(home ?? ""),
      `HOME points at ${String(home)}, which is neither the guard's blocked ` +
        "path nor a temp directory.",
    );
  }
}

function assertUnderTempRoot(candidate: string, complaint: string): void {
  if (TEMP_ROOTS.some((root) => candidate.startsWith(`${root}${path.sep}`))) {
    return;
  }

  throw new Error(
    `${complaint} Tests must not read or write outside a temp directory: the ` +
      "OpenWiki home holds the developer's brain wiki and their credential " +
      "file. See test/support/openwiki-home-guard.ts.",
  );
}

/*
 * macOS resolves `/var/folders/...` to `/private/var/folders/...`, and tests
 * hand back whichever form their own `mkdtemp` produced, so both count.
 */
function uniqueTempRoots(): string[] {
  const raw = os.tmpdir();
  return [...new Set([raw, realpathSync(raw)])];
}
