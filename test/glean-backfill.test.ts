import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createGleanConnector } from "../src/connectors/sources/glean.ts";

type SliceFetchInput = {
  backendUrl: string;
  sinceDate: string;
  untilDate?: string;
};

type SliceFetchCall = SliceFetchInput & {
  stream: "messages" | "my-work";
};

const originalEnv = {
  OPENWIKI_GLEAN_ACCESS_TOKEN: process.env.OPENWIKI_GLEAN_ACCESS_TOKEN,
  OPENWIKI_HOME: process.env.OPENWIKI_HOME,
};
let openWikiHome: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
  openWikiHome = await mkdtemp(path.join(tmpdir(), "openwiki-backfill-"));
  process.env.OPENWIKI_HOME = openWikiHome;
  process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
  await writeGleanConfig();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(openWikiHome, { force: true, recursive: true });
});

describe("Glean Backfill", () => {
  test("uses per-source Backfill slice settings", async () => {
    const calls: SliceFetchCall[] = [];

    await createGleanConnector({
      transport: createBackfillTransport(calls, () => ({ results: [] })),
    }).backfill?.({
      connectorConfig: {
        backfill: {
          boundaryBufferHours: 0,
          emptySliceLimit: 1,
          maxSlices: 20,
          sliceDays: 5,
        },
      },
      instanceId: "glean-primary",
    });

    expect(readBounds(calls[0])).toEqual({
      sinceDate: "2026-07-09",
      untilDate: "2026-07-14",
    });
    expect(calls.filter(({ stream }) => stream === "my-work")).toHaveLength(1);
  });

  test("warns when a sliced stream fills the Glean search page", async () => {
    const calls: SliceFetchCall[] = [];
    const fullPageIds = Array.from(
      { length: 100 },
      (_, index) => `full-page-item-${index + 1}`,
    );

    const result = await createGleanConnector({
      transport: createBackfillTransport(calls, ({ stream, untilDate }) =>
        stream === "my-work" && untilDate === "2026-07-14"
          ? gleanSearchResponse(...fullPageIds)
          : { results: [] },
      ),
    }).backfill?.({
      connectorConfig: { backfill: { emptySliceLimit: 1 } },
    });

    expect(result?.status).toBe("success");
    expect(result?.warnings).toContain(
      "Glean my-work slice 2026-07-04..2026-07-14 returned a full page (100); items may have been trimmed — reduce backfill.sliceDays.",
    );
  });

  test("walks multiple slices until dry and persists the completeness watermark", async () => {
    const calls: SliceFetchCall[] = [];
    const transport = createBackfillTransport(calls, ({ stream, untilDate }) =>
      stream === "my-work" && untilDate === "2026-07-14"
        ? gleanSearchResponse("first-slice")
        : stream === "my-work" && untilDate === "2026-07-04"
          ? gleanSearchResponse("historical-second-slice")
          : { results: [] },
    );

    const result = await createGleanConnector({ transport }).backfill?.();

    expect(result).toMatchObject({
      message:
        "Backfill walked 4 slice(s), pulled 2 item(s); history reaches back to 2026-06-04.",
      status: "success",
    });
    expect(
      calls.filter(({ stream }) => stream === "my-work").map(readBounds),
    ).toEqual([
      { sinceDate: "2026-07-04", untilDate: "2026-07-14" },
      { sinceDate: "2026-06-24", untilDate: "2026-07-04" },
      { sinceDate: "2026-06-14", untilDate: "2026-06-24" },
      { sinceDate: "2026-06-04", untilDate: "2026-06-14" },
    ]);
    expect(calls.filter(({ stream }) => stream === "messages")).toHaveLength(4);

    const sliceFiles = result?.rawFiles.filter((file) =>
      path.basename(file).startsWith("backfill-slice-"),
    );
    expect(sliceFiles?.map((file) => path.basename(file))).toEqual([
      "backfill-slice-0001.json",
      "backfill-slice-0002.json",
      "backfill-slice-0003.json",
      "backfill-slice-0004.json",
    ]);
    const secondSlice = await readJsonObject(sliceFiles?.[1]);
    expect(secondSlice).toMatchObject({
      bounds: { sinceDate: "2026-06-24", untilDate: "2026-07-04" },
      myWork: {
        counts: { new: 1 },
        items: [{ id: "historical-second-slice" }],
      },
      sliceNumber: 2,
    });

    const state = await readGleanState();
    expect(state.backfill).toEqual({
      consecutiveEmptySlices: 2,
      slicesWalked: 4,
      startedAt: "2026-07-14T12:00:00.000Z",
      status: "dry",
      version: 1,
      watermark: "2026-06-04T12:00:00.000Z",
    });
  });

  test("resumes from the last completed slice after both stream fetches fail", async () => {
    const failedCalls: SliceFetchCall[] = [];
    const failingTransport = createBackfillTransport(
      failedCalls,
      ({ stream, untilDate }) => {
        if (untilDate === "2026-06-24") {
          throw new Error(`${stream} unavailable`);
        }
        return stream === "my-work"
          ? gleanSearchResponse(`item-${untilDate}`)
          : { results: [] };
      },
    );

    const failedResult = await createGleanConnector({
      transport: failingTransport,
    }).backfill?.();

    expect(failedResult?.status).toBe("error");
    expect(failedResult?.message).toMatch(
      /provably covered back to 2026-06-24/iu,
    );
    expect(failedResult?.warnings).toEqual([
      expect.stringMatching(/my-work.*unavailable/iu),
      expect.stringMatching(/messages.*unavailable/iu),
    ]);
    expect((await readGleanState()).backfill).toMatchObject({
      slicesWalked: 2,
      status: "walking",
      watermark: "2026-06-24T12:00:00.000Z",
    });

    vi.setSystemTime(new Date("2026-07-14T12:00:01.000Z"));
    const resumedCalls: SliceFetchCall[] = [];
    const resumedResult = await createGleanConnector({
      transport: createBackfillTransport(resumedCalls, () => ({ results: [] })),
    }).backfill?.();

    expect(resumedResult?.status).toBe("success");
    expect(readBounds(resumedCalls[0])).toEqual({
      sinceDate: "2026-06-14",
      untilDate: "2026-06-24",
    });
    expect(
      resumedCalls.some(({ untilDate }) => untilDate === "2026-07-14"),
    ).toBe(false);
  });

  test("retries a partially failed slice without advancing the watermark", async () => {
    const failedCalls: SliceFetchCall[] = [];
    const failedResult = await createGleanConnector({
      transport: createBackfillTransport(
        failedCalls,
        ({ stream, untilDate }) => {
          if (untilDate === "2026-07-14") {
            return stream === "my-work"
              ? gleanSearchResponse("completed-slice-item")
              : { results: [] };
          }
          if (untilDate === "2026-07-04") {
            if (stream === "messages") {
              throw new Error("messages temporarily unavailable");
            }
            return gleanSearchResponse("incomplete-slice-item");
          }
          return { results: [] };
        },
      ),
    }).backfill?.();

    expect(failedResult?.status).toBe("error");
    expect(failedResult?.message).toMatch(
      /provably covered back to 2026-07-04/iu,
    );
    expect(failedResult?.warnings).toEqual([
      expect.stringMatching(/messages.*temporarily unavailable/iu),
    ]);
    expect((await readGleanState()).backfill).toMatchObject({
      slicesWalked: 1,
      status: "walking",
      watermark: "2026-07-04T12:00:00.000Z",
    });

    vi.setSystemTime(new Date("2026-07-14T12:00:01.000Z"));
    const resumedCalls: SliceFetchCall[] = [];
    await createGleanConnector({
      transport: createBackfillTransport(resumedCalls, () => ({ results: [] })),
    }).backfill?.();

    expect(readBounds(resumedCalls[0])).toEqual({
      sinceDate: "2026-06-24",
      untilDate: "2026-07-04",
    });
  });

  test("retries the original first slice when a fresh Backfill fails", async () => {
    const failedCalls: SliceFetchCall[] = [];
    const failedResult = await createGleanConnector({
      transport: createBackfillTransport(failedCalls, ({ stream }) => {
        if (stream === "messages") {
          throw new Error("messages unavailable on first slice");
        }
        return { results: [] };
      }),
    }).backfill?.();

    expect(failedResult?.status).toBe("error");
    expect((await readGleanState()).backfill).toMatchObject({
      slicesWalked: 0,
      status: "walking",
      watermark: "2026-07-14T12:00:00.000Z",
    });

    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const resumedCalls: SliceFetchCall[] = [];
    await createGleanConnector({
      transport: createBackfillTransport(resumedCalls, () => ({ results: [] })),
    }).backfill?.();

    expect(readBounds(resumedCalls[0])).toEqual({
      sinceDate: "2026-07-04",
      untilDate: "2026-07-14",
    });
  });

  test("a repeated Backfill continues below a dry watermark", async () => {
    const initialCalls: SliceFetchCall[] = [];
    await createGleanConnector({
      transport: createBackfillTransport(initialCalls, () => ({ results: [] })),
    }).backfill?.();
    expect((await readGleanState()).backfill).toMatchObject({
      status: "dry",
      watermark: "2026-06-24T12:00:00.000Z",
    });

    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const repeatCalls: SliceFetchCall[] = [];
    await createGleanConnector({
      transport: createBackfillTransport(repeatCalls, () => ({ results: [] })),
    }).backfill?.();

    expect(readBounds(repeatCalls[0])).toEqual({
      sinceDate: "2026-06-14",
      untilDate: "2026-06-24",
    });
  });
});

function createBackfillTransport(
  calls: SliceFetchCall[],
  fetchSlice: (input: SliceFetchCall) => unknown,
) {
  const fetchStream = (
    stream: SliceFetchCall["stream"],
    input: SliceFetchInput,
  ) => {
    const call = { ...input, stream };
    calls.push(call);
    return Promise.resolve().then(() => fetchSlice(call));
  };

  return {
    fetchCalendar: () => Promise.resolve({ results: [] }),
    fetchExpansion: () => Promise.resolve({}),
    fetchFeed: () => Promise.resolve({ items: [] }),
    fetchMessages: (input: SliceFetchInput) => fetchStream("messages", input),
    fetchMyWork: (input: SliceFetchInput) => fetchStream("my-work", input),
    listTools: () => Promise.resolve([]),
  };
}

function gleanSearchResponse(...ids: string[]): unknown {
  return {
    results: ids.map((id) => ({
      document: {
        datasource: "drive",
        id,
        title: `Document ${id}`,
        url: `https://app.glean.com/go/${id}`,
      },
    })),
  };
}

async function readGleanState(): Promise<Record<string, unknown>> {
  return await readJsonObject(
    path.join(openWikiHome, "connectors", "glean", "state.json"),
  );
}

async function readJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  if (!filePath) {
    throw new Error("Expected a raw file path");
  }
  return JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

function readBounds(input: SliceFetchInput | undefined) {
  return {
    sinceDate: input?.sinceDate,
    untilDate: input?.untilDate,
  };
}

async function writeGleanConfig(): Promise<void> {
  const connectorHome = path.join(openWikiHome, "connectors", "glean");
  await mkdir(connectorHome, { recursive: true });
  await writeFile(
    path.join(connectorHome, "config.json"),
    `${JSON.stringify({
      backfill: {
        boundaryBufferHours: 0,
        emptySliceLimit: 2,
        maxSlices: 20,
        sliceDays: 10,
      },
      enabled: true,
      instance: "acme",
    })}\n`,
  );
}
