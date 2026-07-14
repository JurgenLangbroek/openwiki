import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderRunLedgerSection } from "../src/connectors/run-ledger.ts";
import { createGleanConnector } from "../src/connectors/sources/glean.ts";

type SliceFetchInput = {
  backendUrl: string;
  sinceDate: string;
  untilDate?: string;
};

type SliceFetchCall = SliceFetchInput & {
  stream: "messages" | "my-work";
};

type ExpansionFetchInput = {
  backendUrl: string;
  item: { id: string };
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  test("aborts on insufficient scope before walking a slice or mutating state", async () => {
    const calls: SliceFetchCall[] = [];
    const failure = Object.assign(
      new Error("insufficient_scope: getdocuments scope is missing"),
      { errorCode: "insufficient_scope", status: 403 },
    );
    const transport = {
      ...createBackfillTransport(calls, () => ({ results: [] })),
      fetchAuthPreflight: vi.fn(() => Promise.reject(failure)),
    };

    const result = await createGleanConnector({ transport }).backfill?.();

    expect(result).toMatchObject({
      status: "error",
    });
    expect(result?.message).toMatch(/openwiki auth glean/iu);
    expect(transport.fetchAuthPreflight).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(
      result?.ledgerEvents?.some(
        (event) =>
          event.type === "warning" &&
          /preflight.*insufficient_scope/iu.test(event.message),
      ),
    ).toBe(true);
    await expect(
      readFile(path.join(openWikiHome, "connectors", "glean", "state.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("continues when the intentionally empty auth preflight reaches request parsing", async () => {
    const calls: SliceFetchCall[] = [];
    const transport = {
      ...createBackfillTransport(calls, () => ({ results: [] })),
      fetchAuthPreflight: vi.fn(() =>
        Promise.reject(
          Object.assign(new Error("Error extracting get documents request"), {
            status: 400,
          }),
        ),
      ),
    };

    const result = await createGleanConnector({ transport }).backfill?.();

    expect(result).toMatchObject({ status: "success", warnings: [] });
    expect(transport.fetchAuthPreflight).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThan(0);
  });

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
        "Backfill walked 4 slice(s), pulled 2 item(s), expanded 2 item(s); history reaches back to 2026-06-04.",
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
    expect(
      result?.ledgerEvents
        ?.filter((event) => event.type === "pull")
        .slice(0, 2),
    ).toEqual([
      {
        counts: { deduplicated: 0, fetched: 1, new: 1 },
        slice: {
          number: 1,
          sinceDate: "2026-07-04",
          untilDate: "2026-07-14",
        },
        stream: "my-work",
        type: "pull",
      },
      {
        counts: { deduplicated: 0, fetched: 0, new: 0 },
        slice: {
          number: 1,
          sinceDate: "2026-07-04",
          untilDate: "2026-07-14",
        },
        stream: "messages",
        type: "pull",
      },
    ]);
    expect(result?.ledgerEvents).toContainEqual({
      status: "dry",
      type: "watermark",
      watermark: "2026-06-04T12:00:00.000Z",
    });
  });

  test("expands every item across multiple Backfill slices without a cap", async () => {
    const calls: SliceFetchCall[] = [];
    const firstSliceIds = Array.from(
      { length: 25 },
      (_, index) => `first-slice-${index + 1}`,
    );
    const secondSliceIds = ["second-slice-1", "second-slice-2"];
    const fetchExpansion = vi.fn(({ item }: ExpansionFetchInput) =>
      Promise.resolve({ content: `Full ${item.id}` }),
    );
    const transport = createBackfillTransport(
      calls,
      ({ stream, untilDate }) =>
        stream === "my-work" && untilDate === "2026-07-14"
          ? gleanSearchResponse(...firstSliceIds)
          : stream === "messages" && untilDate === "2026-07-04"
            ? gleanSearchResponse(...secondSliceIds)
            : { results: [] },
      fetchExpansion,
    );

    const result = await createGleanConnector({ transport }).backfill?.();

    expect(result).toMatchObject({
      message:
        "Backfill walked 4 slice(s), pulled 27 item(s), expanded 27 item(s); history reaches back to 2026-06-04.",
      status: "success",
    });
    expect(fetchExpansion).toHaveBeenCalledTimes(27);
    expect(fetchExpansion.mock.calls.map(([{ item }]) => item.id)).toEqual([
      ...firstSliceIds,
      ...secondSliceIds,
    ]);

    const sliceFiles = result?.rawFiles.filter((file) =>
      path.basename(file).startsWith("backfill-slice-"),
    );
    const firstSlice = await readJsonObject(sliceFiles?.[0]);
    const secondSlice = await readJsonObject(sliceFiles?.[1]);
    expect(firstSlice.expanded).toMatchObject({
      counts: { candidates: 25, expanded: 25, failed: 0 },
      items: firstSliceIds.map((id) => ({ id })),
      stream: "expanded",
    });
    expect(secondSlice.expanded).toMatchObject({
      counts: { candidates: 2, expanded: 2, failed: 0 },
      items: secondSliceIds.map((id) => ({ id })),
      stream: "expanded",
    });
  });

  test("records Content Expansion failure reasons without blocking the watermark", async () => {
    const calls: SliceFetchCall[] = [];
    const fetchExpansion = vi.fn(({ item }: ExpansionFetchInput) =>
      item.id === "cannot-expand"
        ? Promise.reject(new Error("index read unavailable"))
        : Promise.resolve({ content: `Full ${item.id}` }),
    );
    const transport = createBackfillTransport(
      calls,
      ({ stream, untilDate }) =>
        stream === "my-work" && untilDate === "2026-07-14"
          ? gleanSearchResponse("cannot-expand")
          : { results: [] },
      fetchExpansion,
    );

    const result = await createGleanConnector({ transport }).backfill?.();

    expect(result).toMatchObject({
      message:
        "Backfill walked 3 slice(s), pulled 1 item(s), expanded 0 item(s); history reaches back to 2026-06-14.",
      status: "success",
      warnings: [
        "Glean expanded fetch failed for cannot-expand: index read unavailable",
      ],
    });
    const firstSlicePath = result?.rawFiles.find(
      (file) => path.basename(file) === "backfill-slice-0001.json",
    );
    expect(await readJsonObject(firstSlicePath)).toMatchObject({
      expanded: {
        counts: { candidates: 1, expanded: 0, failed: 1 },
        failures: [
          {
            id: "cannot-expand",
            reason: "index read unavailable",
            sourceStream: "my-work",
          },
        ],
        items: [],
      },
    });
    expect((await readGleanState()).backfill).toMatchObject({
      slicesWalked: 3,
      status: "dry",
      watermark: "2026-06-14T12:00:00.000Z",
    });
    expect(
      result?.ledgerEvents?.filter((event) => event.type === "expansion"),
    ).toEqual([
      {
        id: "cannot-expand",
        outcome: "failed",
        reason: "index read unavailable",
        slice: {
          number: 1,
          sinceDate: "2026-07-04",
          untilDate: "2026-07-14",
        },
        sourceStream: "my-work",
        title: "Document cannot-expand",
        type: "expansion",
        url: "https://app.glean.com/go/cannot-expand",
      },
    ]);
  });

  test("trips after three candidate-bearing slices have total Content Expansion failure", async () => {
    const calls: SliceFetchCall[] = [];
    const fetchExpansion = vi.fn(() =>
      Promise.reject(new Error("getdocuments scope denied")),
    );
    const result = await createGleanConnector({
      transport: createBackfillTransport(
        calls,
        ({ stream, untilDate }) =>
          stream === "my-work" &&
          ["2026-07-14", "2026-07-04", "2026-06-24"].includes(untilDate ?? "")
            ? gleanSearchResponse(`item-${untilDate}`)
            : { results: [] },
        fetchExpansion,
      ),
    }).backfill?.();

    expect(result).toMatchObject({ status: "error" });
    expect(result?.message).toMatch(
      /Content Expansion total-failure tripwire.*getdocuments scope denied/iu,
    );
    expect(fetchExpansion).toHaveBeenCalledTimes(3);
    expect(
      result?.ledgerEvents?.some(
        (event) =>
          event.type === "warning" &&
          /tripwire.*dominant failure reason.*getdocuments scope denied/iu.test(
            event.message,
          ),
      ),
    ).toBe(true);
    expect(result?.ledgerEvents).toContainEqual({
      status: "walking",
      type: "watermark",
      watermark: "2026-07-14T12:00:00.000Z",
    });
    const renderedLedger = renderRunLedgerSection({
      connectorId: "glean",
      events: result?.ledgerEvents ?? [],
      message: result?.message ?? "missing result",
      mode: "backfill",
      runId: result?.runId ?? "missing-run-id",
      startedAt: "2026-07-14T12:00:00.000Z",
      status: result?.status ?? "error",
    });
    expect(renderedLedger).toContain(
      "History provably covered back to 2026-07-14 (walking).",
    );
    expect(await readGleanState()).toMatchObject({
      backfill: {
        slicesWalked: 0,
        status: "walking",
        watermark: "2026-07-14T12:00:00.000Z",
      },
      runs: [{ status: "error" }],
    });
  });

  test("rolls persisted resume state back before a tripped Content Expansion failure streak", async () => {
    const calls: SliceFetchCall[] = [];
    const failedIds = ["failed-1", "failed-2", "failed-3"];
    const fetchExpansion = vi.fn(({ item }: ExpansionFetchInput) =>
      item.id === "covered-item"
        ? Promise.resolve({ content: "covered" })
        : Promise.reject(new Error("scope denied")),
    );
    const idsByUntilDate: Record<string, string[]> = {
      "2026-06-14": [failedIds[2]],
      "2026-06-24": [failedIds[1]],
      "2026-07-04": [failedIds[0]],
      "2026-07-14": ["covered-item"],
    };

    const result = await createGleanConnector({
      transport: createBackfillTransport(
        calls,
        ({ stream, untilDate }) =>
          stream === "my-work"
            ? gleanSearchResponse(...(idsByUntilDate[untilDate ?? ""] ?? []))
            : { results: [] },
        fetchExpansion,
      ),
    }).backfill?.();

    expect(result).toMatchObject({ status: "error" });
    const state = (await readGleanState()) as {
      backfill: { slicesWalked: number; watermark: string };
      seenIds?: Record<string, string[]>;
    };
    expect(state.backfill).toMatchObject({
      slicesWalked: 1,
      watermark: "2026-07-04T12:00:00.000Z",
    });
    expect(state.seenIds?.["my-work"]).toEqual(["covered-item"]);
    expect(state.seenIds?.expanded).toEqual(["covered-item"]);
    expect(Object.values(state.seenIds ?? {}).flat()).not.toEqual(
      expect.arrayContaining(failedIds),
    );
  });

  test("allows the Content Expansion total-failure threshold to be configured", async () => {
    const calls: SliceFetchCall[] = [];
    const fetchExpansion = vi.fn(() =>
      Promise.reject(new Error("configured-threshold failure")),
    );
    const result = await createGleanConnector({
      transport: createBackfillTransport(
        calls,
        ({ stream, untilDate }) =>
          stream === "my-work" && untilDate === "2026-07-14"
            ? gleanSearchResponse("one-failed-item")
            : { results: [] },
        fetchExpansion,
      ),
    }).backfill?.({
      connectorConfig: {
        expansion: { totalFailureSliceLimit: 1 },
      },
    });

    expect(result).toMatchObject({ status: "error" });
    expect(result?.message).toMatch(/tripped after 1/iu);
    expect(fetchExpansion).toHaveBeenCalledTimes(1);
  });

  test("does not count a slice with a deduplicated candidate as total failure", async () => {
    await writeFile(
      path.join(openWikiHome, "connectors", "glean", "state.json"),
      `${JSON.stringify({
        seenIds: { expanded: ["already-expanded"] },
        version: 1,
      })}\n`,
    );
    const calls: SliceFetchCall[] = [];
    const fetchExpansion = vi.fn(() =>
      Promise.reject(new Error("cannot expand")),
    );
    const idsByUntilDate: Record<string, string[]> = {
      "2026-06-14": ["fail-4"],
      "2026-06-24": ["fail-3"],
      "2026-07-04": ["already-expanded", "fail-2"],
      "2026-07-14": ["fail-1"],
    };
    const result = await createGleanConnector({
      transport: createBackfillTransport(
        calls,
        ({ stream, untilDate }) =>
          stream === "my-work"
            ? gleanSearchResponse(...(idsByUntilDate[untilDate ?? ""] ?? []))
            : { results: [] },
        fetchExpansion,
      ),
    }).backfill?.();

    expect(result).toMatchObject({ status: "success" });
    expect(fetchExpansion).toHaveBeenCalledTimes(4);
  });

  test("retries a rate-limited Glean request and completes the Backfill", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let getDocumentsAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/rest/api/v1/getdocuments")) {
          getDocumentsAttempts += 1;
          return Promise.resolve(
            getDocumentsAttempts === 1
              ? Response.json(
                  { error: "rate_limited" },
                  {
                    headers: { "Retry-After": "0" },
                    status: 429,
                    statusText: "Too Many Requests",
                  },
                )
              : Response.json({ documents: [] }),
          );
        }
        if (url.endsWith("/rest/api/v1/search")) {
          return Promise.resolve(Response.json({ results: [] }));
        }

        const requestBody = typeof init?.body === "string" ? init.body : "{}";
        const request = JSON.parse(requestBody) as {
          id?: number;
          method?: string;
        };
        return Promise.resolve(
          request.id === undefined
            ? new Response(null, { status: 202 })
            : Response.json({
                id: request.id,
                jsonrpc: "2.0",
                result: request.method === "tools/list" ? { tools: [] } : {},
              }),
        );
      }),
    );

    const result = await createGleanConnector().backfill?.({
      connectorConfig: {
        rateLimit: { requestsPerSecond: 1_000_000 },
      },
    });

    expect(result).toMatchObject({ status: "success" });
    expect(getDocumentsAttempts).toBe(2);
  });

  test("records a whole Content Expansion pull failure with its slice", async () => {
    const calls: SliceFetchCall[] = [];
    const transcriptDatasources = new Proxy<string[]>([], {
      get(target, property, receiver) {
        if (property === "filter") {
          throw new Error("expansion pipeline unavailable");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const result = await createGleanConnector({
      transport: createBackfillTransport(calls, ({ stream, untilDate }) =>
        stream === "my-work" && untilDate === "2026-07-14"
          ? gleanSearchResponse("whole-pull-failure")
          : { results: [] },
      ),
    }).backfill?.({
      connectorConfig: { expansion: { transcriptDatasources } },
    });

    expect(
      result?.ledgerEvents?.filter((event) => event.type === "expansion"),
    ).toEqual([
      {
        id: "(entire expansion pull)",
        outcome: "failed",
        reason: "expansion pipeline unavailable",
        slice: {
          number: 1,
          sinceDate: "2026-07-04",
          untilDate: "2026-07-14",
        },
        sourceStream: "expanded",
        type: "expansion",
      },
    ]);
  });

  test("does not re-expand a persisted id when a later Backfill finds it in another stream", async () => {
    const firstCalls: SliceFetchCall[] = [];
    const fetchExpansion = vi.fn(({ item }: ExpansionFetchInput) =>
      Promise.resolve({ content: `Full ${item.id}` }),
    );
    const firstResult = await createGleanConnector({
      transport: createBackfillTransport(
        firstCalls,
        ({ stream, untilDate }) =>
          stream === "my-work" && untilDate === "2026-07-14"
            ? gleanSearchResponse("cross-run-item")
            : { results: [] },
        fetchExpansion,
      ),
    }).backfill?.();

    expect(firstResult?.status).toBe("success");
    expect(fetchExpansion).toHaveBeenCalledTimes(1);
    fetchExpansion.mockClear();
    vi.setSystemTime(new Date("2026-07-14T12:00:01.000Z"));

    const repeatCalls: SliceFetchCall[] = [];
    const repeatResult = await createGleanConnector({
      transport: createBackfillTransport(
        repeatCalls,
        ({ stream, untilDate }) =>
          stream === "messages" && untilDate === "2026-06-14"
            ? gleanSearchResponse("cross-run-item")
            : { results: [] },
        fetchExpansion,
      ),
    }).backfill?.();

    expect(repeatResult?.status).toBe("success");
    expect(fetchExpansion).not.toHaveBeenCalled();
    const firstRepeatSlice = repeatResult?.rawFiles.find(
      (file) => path.basename(file) === "backfill-slice-0001.json",
    );
    expect(await readJsonObject(firstRepeatSlice)).toMatchObject({
      expanded: {
        counts: {
          candidates: 1,
          deduplicated: 1,
          expanded: 0,
          failed: 0,
        },
        items: [],
      },
      messages: { counts: { new: 1 } },
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
    expect(failedResult?.ledgerEvents).toContainEqual({
      status: "walking",
      type: "watermark",
      watermark: "2026-06-24T12:00:00.000Z",
    });
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
  fetchExpansion: (input: ExpansionFetchInput) => Promise<unknown> = () =>
    Promise.resolve({}),
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
    fetchAuthPreflight: () => Promise.resolve({ documents: [] }),
    fetchExpansion,
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
