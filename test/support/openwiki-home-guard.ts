import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach } from "vitest";

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
 * The invariant is one line: **`os.homedir()` must never return a real path
 * while the suite runs.** Everything below serves it.
 *
 * - OPENWIKI_HOME is cleared, so the suite never inherits a home a developer
 *   happens to export (that variable is how the personal brain wiki is pointed
 *   at a working copy, so inheriting it is the same hazard wearing a hat).
 * - HOME and USERPROFILE point *through a regular file*, so `os.homedir()` —
 *   the fallback `resolveOpenWikiHomeDir()` uses once OPENWIKI_HOME is gone —
 *   yields a path that cannot be created, listed, or written.
 * - `process.env` is wrapped so the invariant cannot be undone from a test
 *   body. On POSIX `os.homedir()` reads `$HOME` and, when `$HOME` is *absent*,
 *   falls back to the passwd entry for the effective uid — so a bare
 *   `delete process.env.HOME` would hand back the real home, and USERPROFILE
 *   (a Windows variable, set here only for parity) would not stop it. Deleting
 *   either variable, or pointing HOME anywhere but a temp directory, now throws
 *   at that line instead of silently re-opening the developer's home.
 * - The hooks re-check the invariant by interrogating `os.homedir()` itself
 *   rather than inferring it from environment variables.
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

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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

installHomeVariableLock();

/**
 * Hold HOME and USERPROFILE to paths that keep `os.homedir()` harmless.
 *
 * `process.env` rejects non-configurable property descriptors, so the variables
 * cannot be frozen in place; wrapping the object is what is left. The wrapper is
 * transparent for every other key — reads, writes, deletes, enumeration and
 * spreading all pass through — and Node's own `setenv` semantics are preserved
 * because the traps assign to the real environment object rather than
 * redefining properties on it.
 *
 * Only the *unsafe* mutations are refused, and they are refused loudly at the
 * offending line. Pointing HOME at a temp directory (upstream's isolation
 * idiom) is explicitly allowed.
 */
function installHomeVariableLock(): void {
  const realEnv = process.env;
  const locked = new Set(["HOME", "USERPROFILE"]);

  const guarded = new Proxy(realEnv, {
    defineProperty(target, property, descriptor) {
      if (typeof property === "string" && locked.has(property)) {
        assertHomeValueIsSafe(property, descriptor.value);
      }
      target[property as string] = descriptor.value as string;
      return true;
    },
    deleteProperty(target, property) {
      if (typeof property === "string" && locked.has(property)) {
        throw new Error(
          `Deleting process.env.${property} would let os.homedir() fall back to ` +
            "the passwd entry for this user, i.e. the developer's real home " +
            "directory, and everything derived from it including " +
            "~/.openwiki/.env. Assign a temp directory instead, or call " +
            "useTempOpenWikiHome(). See test/support/openwiki-home-guard.ts.",
        );
      }

      return Reflect.deleteProperty(target, property);
    },
    set(target, property, value) {
      if (typeof property === "string" && locked.has(property)) {
        assertHomeValueIsSafe(property, value);
      }
      target[property as string] = value as string;
      return true;
    },
  });

  Object.defineProperty(process, "env", {
    configurable: false,
    enumerable: true,
    value: guarded,
    writable: false,
  });
}

/*
 * Raised only by `withRealHomeDirForFallbackAssertions()`, for the length of one
 * synchronous callback, so the sanctioned fallback oracle can point HOME at the
 * real home. A module-local binding: no test file can reach it.
 */
let sanctionedRealHomeWindowIsOpen = false;

function assertHomeValueIsSafe(variable: string, value: unknown): void {
  if (sanctionedRealHomeWindowIsOpen) {
    return;
  }

  const candidate = typeof value === "string" ? value : String(value);

  if (
    candidate === blockedHomeDir ||
    isUnderTempRoot(path.resolve(candidate))
  ) {
    return;
  }

  throw new Error(
    `Pointing process.env.${variable} at ${candidate} would make os.homedir() ` +
      "return a real directory, and every OpenWiki home path derives from it. " +
      "Tests may only point it at a temp directory. See " +
      "test/support/openwiki-home-guard.ts.",
  );
}

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
 * caller identifies itself with its own `import.meta.url`, which is fixed at
 * module load and cannot be rewritten from inside the test file; runner state
 * such as `expect.getState().testPath` can be, and so is not used here.
 *
 * The callback must be synchronous — a promise would resume after the `finally`
 * has already re-blocked HOME — so the window stays as small as the assertions
 * themselves. Never perform IO inside it: for the length of the callback the
 * home paths can resolve to the developer's real files.
 */
export function withRealHomeDirForFallbackAssertions<T>(
  callerModuleUrl: string,
  assertion: (realHomeDir: string) => T,
): T {
  assertCallerMaySeeTheRealHome(callerModuleUrl);

  const blocked = process.env.HOME ?? blockedHomeDir;
  sanctionedRealHomeWindowIsOpen = true;
  process.env.HOME = REAL_HOME_DIR;
  process.env.USERPROFILE = REAL_HOME_DIR;

  try {
    const result = assertion(REAL_HOME_DIR);

    if (isThenable(result)) {
      throw new Error(
        "withRealHomeDirForFallbackAssertions() requires a synchronous " +
          "callback: HOME is re-blocked as soon as the callback returns, so an " +
          "async body would run against the blocked home and assert nothing " +
          "meaningful. See test/support/openwiki-home-guard.ts.",
      );
    }

    return result;
  } finally {
    process.env.HOME = blocked;
    process.env.USERPROFILE = blocked;
    sanctionedRealHomeWindowIsOpen = false;
  }
}

function assertCallerMaySeeTheRealHome(callerModuleUrl: string): void {
  const callerPath = toFilePath(callerModuleUrl);
  const relativePath = path.relative(REPO_ROOT, callerPath);
  const callingFile = callingFileFromStack();

  if (callingFile !== callerPath) {
    throw new Error(
      `withRealHomeDirForFallbackAssertions() was called from ${
        callingFile ?? "an unreadable stack frame"
      } but claims to be ${callerPath}. Pass this module's own import.meta.url.`,
    );
  }

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

/**
 * The file of the first stack frame outside this module, or undefined if the
 * stack cannot be read — in which case the caller check fails closed.
 *
 * This is the half of the identity check a test file cannot write: the argument
 * it passes can be any string it likes, but it cannot put another file's name on
 * its own frame.
 */
function callingFileFromStack(): string | undefined {
  const stack = new Error("caller probe").stack;

  if (!stack) {
    return undefined;
  }

  const guardFile = toFilePath(import.meta.url);

  for (const line of stack.split("\n").slice(1)) {
    const frame = /^\s*at (?:.*\()?(.+):\d+:\d+\)?$/u.exec(line);

    if (!frame) {
      continue;
    }

    const file = toFilePath(frame[1]);

    if (file !== guardFile) {
      return file;
    }
  }

  return undefined;
}

function toFilePath(fileOrUrl: string): string {
  return fileOrUrl.startsWith("file:") ? fileURLToPath(fileOrUrl) : fileOrUrl;
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/*
 * The guard is only worth anything while it is intact, so re-check it at every
 * test boundary. These hooks are registered before any hook in the test file,
 * which means the beforeEach runs first and the afterEach runs last: both see
 * the state the file settled on rather than a transient one.
 */
beforeEach(assertGuardIsIntact);
afterEach(assertGuardIsIntact);

afterAll(() => {
  rmSync(guardDir, { force: true, recursive: true });
});

function assertGuardIsIntact(): void {
  /*
   * Interrogate the oracle rather than the environment variables behind it:
   * `os.homedir()` is what every home path is ultimately derived from, and it
   * has fallbacks (the passwd entry) that no environment variable reveals.
   */
  const homeDir = os.homedir();

  if (homeDir !== blockedHomeDir && !isUnderTempRoot(path.resolve(homeDir))) {
    throw new Error(
      `os.homedir() returns ${homeDir}, which is neither the guard's blocked ` +
        "path nor a temp directory, so the OpenWiki home now resolves inside a " +
        "real home directory. " +
        WHY_IT_MATTERS,
    );
  }

  const override = process.env.OPENWIKI_HOME?.trim();

  if (override && !isUnderTempRoot(path.resolve(override))) {
    throw new Error(
      `OPENWIKI_HOME points at ${override}, which is outside the OS temp ` +
        `directory. ${WHY_IT_MATTERS}`,
    );
  }
}

const WHY_IT_MATTERS =
  "Tests must not read or write outside a temp directory: the OpenWiki home " +
  "holds the developer's brain wiki and their credential file. See " +
  "test/support/openwiki-home-guard.ts.";

function isUnderTempRoot(candidate: string): boolean {
  return TEMP_ROOTS.some((root) => candidate.startsWith(`${root}${path.sep}`));
}

/*
 * macOS resolves `/var/folders/...` to `/private/var/folders/...`, and tests
 * hand back whichever form their own `mkdtemp` produced, so both count.
 */
function uniqueTempRoots(): string[] {
  const raw = os.tmpdir();
  return [...new Set([raw, realpathSync(raw)])];
}
