import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  helpContent,
  parseCommand,
  shouldRunNonInteractively,
} from "../src/commands.ts";

// parseCommand's --dry-run gate consults isDevelopmentMode(), which reads
// NODE_ENV / OPENWIKI_DEV. Pin both to a non-development state per test and
// restore afterward.
const originalNodeEnv = process.env.NODE_ENV;
const originalDevFlag = process.env.OPENWIKI_DEV;

beforeEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.OPENWIKI_DEV;
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDevFlag === undefined) delete process.env.OPENWIKI_DEV;
  else process.env.OPENWIKI_DEV = originalDevFlag;
});

describe("parseCommand — help", () => {
  test("--help and -h return a help command", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help", exitCode: 0 });
    expect(parseCommand(["-h"])).toEqual({ kind: "help", exitCode: 0 });
  });

  test("--help anywhere in argv wins", () => {
    expect(parseCommand(["--init", "--help"]).kind).toBe("help");
  });
});

describe("parseCommand — chat default", () => {
  test("no args is an interactive chat that should not auto-start", () => {
    const result = parseCommand([]);

    expect(result).toMatchObject({
      kind: "run",
      command: "chat",
      shouldStart: false,
      userMessage: null,
      print: false,
      dryRun: false,
      modelId: null,
    });
  });

  test("explicit mode without a message opens chat without auto-starting", () => {
    expect(parseCommand(["personal"])).toMatchObject({
      kind: "run",
      command: "chat",
      mode: "personal",
      modeSource: "positional",
      shouldStart: false,
    });
    expect(parseCommand(["code"])).toMatchObject({
      kind: "run",
      command: "chat",
      mode: "code",
      modeSource: "positional",
      shouldStart: false,
    });
  });

  test("a positional message becomes the user message and starts", () => {
    const result = parseCommand(["Document", "the", "API"]);

    expect(result).toMatchObject({
      kind: "run",
      command: "chat",
      userMessage: "Document the API",
      shouldStart: true,
    });
  });
});

describe("parseCommand — init/update", () => {
  test("personal --init selects the init command and starts", () => {
    expect(parseCommand(["personal", "--init"])).toMatchObject({
      kind: "run",
      command: "init",
      mode: "personal",
      shouldStart: true,
    });
  });

  test("bare --init requires an explicit mode", () => {
    const result = parseCommand(["--init"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/requires a mode/u);
    }
  });

  test("--update selects the update command and starts", () => {
    expect(parseCommand(["--update"])).toMatchObject({
      kind: "run",
      command: "update",
      shouldStart: true,
    });
  });

  test("--init and --update together is an error", () => {
    const result = parseCommand(["--init", "--update"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/cannot be used together/u);
    }
  });

  test("repeating the same command flag is allowed", () => {
    expect(parseCommand(["personal", "--init", "--init"]).kind).toBe("run");
  });
});

describe("parseCommand — print", () => {
  test("--print with a message runs and prints", () => {
    expect(parseCommand(["-p", "hello"])).toMatchObject({
      kind: "run",
      print: true,
      userMessage: "hello",
      shouldStart: true,
    });
  });

  test("--print with explicit-mode --init is valid", () => {
    expect(parseCommand(["personal", "--print", "--init"])).toMatchObject({
      kind: "run",
      print: true,
      command: "init",
    });
  });

  test("--print with nothing to run is an error", () => {
    const result = parseCommand(["-p"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/requires a message/u);
    }
  });
});

describe("parseCommand — --modelId", () => {
  test("space-separated valid model id", () => {
    expect(parseCommand(["--modelId", "claude-opus-4-8"])).toMatchObject({
      kind: "run",
      modelId: "claude-opus-4-8",
    });
  });

  test("--model-id alias works", () => {
    expect(parseCommand(["--model-id", "gpt-5.5"])).toMatchObject({
      modelId: "gpt-5.5",
    });
  });

  test("equals form: --modelId=<id>", () => {
    expect(parseCommand(["--modelId=z-ai/glm-5.2"])).toMatchObject({
      modelId: "z-ai/glm-5.2",
    });
  });

  test("missing value is an error", () => {
    const result = parseCommand(["--modelId"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/requires a model ID/u);
    }
  });

  test("a following flag is treated as a missing value", () => {
    const result = parseCommand(["--modelId", "--init"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/requires a model ID/u);
    }
  });

  test("invalid model id (contains ://) is an error", () => {
    const result = parseCommand(["--modelId", "http://evil"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Invalid model ID/u);
    }
  });

  test("invalid model id via equals form is an error", () => {
    expect(parseCommand(["--modelId="]).kind).toBe("error");
  });
});

describe("parseCommand — unknown options and dry-run gating", () => {
  test("an unknown --flag is an error", () => {
    const result = parseCommand(["--nope"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Unknown option/u);
    }
  });

  test("--dry-run is rejected outside development mode", () => {
    const result = parseCommand(["--dry-run"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Unknown option/u);
    }
  });

  test("--dry-run is accepted in development mode", () => {
    process.env.OPENWIKI_DEV = "1";

    expect(parseCommand(["personal", "--dry-run", "--init"])).toMatchObject({
      kind: "run",
      dryRun: true,
      command: "init",
    });
  });
});

describe("shouldRunNonInteractively", () => {
  test("--init and --update without --print bypass the UI when stdin is not a TTY", () => {
    expect(
      shouldRunNonInteractively(parseCommand(["personal", "--init"]), false),
    ).toBe(true);
    expect(shouldRunNonInteractively(parseCommand(["--update"]), false)).toBe(
      true,
    );
  });

  test("a one-shot chat message bypasses the UI when stdin is not a TTY", () => {
    expect(
      shouldRunNonInteractively(parseCommand(["Document the API"]), false),
    ).toBe(true);
  });

  test("--init on a TTY keeps the interactive UI", () => {
    expect(
      shouldRunNonInteractively(parseCommand(["personal", "--init"]), true),
    ).toBe(false);
  });

  test("--print bypasses the UI regardless of TTY", () => {
    expect(
      shouldRunNonInteractively(
        parseCommand(["personal", "--init", "--print"]),
        true,
      ),
    ).toBe(true);
    expect(
      shouldRunNonInteractively(
        parseCommand(["personal", "--init", "--print"]),
        false,
      ),
    ).toBe(true);
  });

  test("interactive chat without a message still uses the UI path", () => {
    expect(shouldRunNonInteractively(parseCommand([]), false)).toBe(false);
    expect(shouldRunNonInteractively(parseCommand([]), true)).toBe(false);
  });

  test("dry-run, help, and error commands never run non-interactively", () => {
    process.env.OPENWIKI_DEV = "1";
    expect(
      shouldRunNonInteractively(parseCommand(["--dry-run", "--init"]), false),
    ).toBe(false);
    expect(shouldRunNonInteractively(parseCommand(["--help"]), false)).toBe(
      false,
    );
    expect(shouldRunNonInteractively(parseCommand(["--nope"]), false)).toBe(
      false,
    );
  });
});

describe("parseCommand — cron", () => {
  test("cron list returns a list command", () => {
    expect(parseCommand(["cron", "list"])).toMatchObject({
      kind: "cron",
      action: "list",
      target: null,
    });
  });

  test("cron pause with a source instance id is rejected", () => {
    const result = parseCommand(["cron", "pause", "web-search-1"]);
    expect(result.kind).toBe("error");
  });

  test("cron resume with a source instance id is rejected", () => {
    const result = parseCommand(["cron", "resume", "web-search-1"]);
    expect(result.kind).toBe("error");
  });

  test("cron delete with a source instance id is rejected", () => {
    const result = parseCommand(["cron", "delete", "web-search-1"]);
    expect(result.kind).toBe("error");
  });

  test("cron pause with 'all' is accepted", () => {
    expect(parseCommand(["cron", "pause", "all"])).toMatchObject({
      kind: "cron",
      action: "pause",
    });
  });

  test("cron pause with no target is an error", () => {
    const result = parseCommand(["cron", "pause"]);
    expect(result.kind).toBe("error");
  });

  test("cron pause with extra arguments is an error", () => {
    const result = parseCommand(["cron", "pause", "all", "extra"]);
    expect(result.kind).toBe("error");
  });
});

describe("parseCommand — explore", () => {
  test("defaults to all configured explorable sources", () => {
    expect(parseCommand(["explore"])).toEqual({
      exitCode: 0,
      kind: "explore",
      modelId: null,
      print: false,
      scheduledOnly: false,
      target: "all",
    });
  });

  test("accepts connector and source-instance targets", () => {
    expect(parseCommand(["explore", "glean"])).toMatchObject({
      kind: "explore",
      target: "glean",
    });
    expect(parseCommand(["explore", "glean-primary"])).toMatchObject({
      kind: "explore",
      target: { id: "glean-primary", kind: "source-instance" },
    });
  });

  test("accepts print, scheduled, and both model ID forms", () => {
    expect(
      parseCommand([
        "explore",
        "all",
        "-p",
        "--scheduled",
        "--modelId",
        "gpt-5.5",
      ]),
    ).toMatchObject({
      kind: "explore",
      modelId: "gpt-5.5",
      print: true,
      scheduledOnly: true,
    });
    expect(
      parseCommand(["explore", "all", "--model-id=claude-opus-4-8"]),
    ).toMatchObject({
      kind: "explore",
      modelId: "claude-opus-4-8",
    });
  });

  test("rejects invalid targets and unknown options with explore-specific errors", () => {
    const invalidTarget = parseCommand(["explore", "not/a/target"]);
    expect(invalidTarget.kind).toBe("error");
    if (invalidTarget.kind === "error") {
      expect(invalidTarget.message).toMatch(/Usage: openwiki explore/u);
    }
    expect(parseCommand(["explore", "all", "--nope"])).toEqual({
      exitCode: 1,
      kind: "error",
      message: "Unknown option for explore: --nope",
    });
  });

  test("lists exploration in help", () => {
    expect(helpContent.usage).toContain(
      "openwiki explore <source|source-instance|all>",
    );
    expect(
      helpContent.commands.some(
        ({ description, label }) =>
          label.includes("explore") &&
          description.includes("open-questions queue"),
      ),
    ).toBe(true);
  });
});

describe("parseCommand — backfill", () => {
  test("defaults to all configured sources", () => {
    expect(parseCommand(["backfill"])).toEqual({
      exitCode: 0,
      kind: "backfill",
      target: "all",
    });
  });

  test("accepts connector and source-instance targets", () => {
    expect(parseCommand(["backfill", "glean"])).toEqual({
      exitCode: 0,
      kind: "backfill",
      target: "glean",
    });
    expect(parseCommand(["backfill", "web-search-2"])).toEqual({
      exitCode: 0,
      kind: "backfill",
      target: { id: "web-search-2", kind: "source-instance" },
    });
  });

  test("rejects options and invalid extra arguments", () => {
    expect(parseCommand(["backfill", "--whatever"])).toEqual({
      exitCode: 1,
      kind: "error",
      message: "Unknown option for backfill: --whatever",
    });
    expect(parseCommand(["backfill", "glean", "extra"])).toEqual({
      exitCode: 1,
      kind: "error",
      message: "Usage: openwiki backfill <source|source-instance|all>",
    });
  });

  test("lists Backfill in help", () => {
    expect(helpContent.usage).toContain(
      "openwiki backfill <source|source-instance|all>",
    );
    expect(
      helpContent.commands.some(
        ({ description, label }) =>
          label.includes("backfill") && description.includes("runs dry"),
      ),
    ).toBe(true);
    expect(helpContent.examples).toContain("openwiki backfill glean");
  });
});
