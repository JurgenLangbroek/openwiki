import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetOpenWikiHomePaths } from "../../src/openwiki-home.ts";

/**
 * Point the OpenWiki home at a fresh temp directory and return it.
 *
 * `src/openwiki-home.ts` resolves its paths into `export let` bindings at module
 * load (ADR-0004), so a test file that statically imports the code under test
 * has already resolved them by the time a hook runs. Setting OPENWIKI_HOME
 * without `resetOpenWikiHomePaths()` therefore moves nothing — the modules keep
 * using the home they loaded with. This helper does both halves so no test file
 * has to remember the second one.
 *
 * The caller still owns cleanup: keep the returned path and `rm` it in the
 * matching hook.
 */
export async function useTempOpenWikiHome(prefix: string): Promise<string> {
  const openWikiHome = await mkdtemp(path.join(tmpdir(), prefix));
  process.env.OPENWIKI_HOME = openWikiHome;
  resetOpenWikiHomePaths();
  return openWikiHome;
}
