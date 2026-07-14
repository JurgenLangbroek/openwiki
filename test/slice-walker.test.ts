import { describe, expect, test } from "vitest";
import {
  beginSliceWalk,
  planNextSlice,
  recordSlice,
  type SliceWalkConfig,
  type SliceWalkState,
} from "../src/connectors/slice-walker.ts";

const config: SliceWalkConfig = {
  boundaryBufferHours: 24,
  emptySliceLimit: 3,
  maxSlices: 400,
  sliceDays: 30,
};

describe("Slice Walker", () => {
  test("begins a fresh Backfill at the supplied instant", () => {
    expect(beginSliceWalk({ now: "2026-07-14T12:00:00.000Z" })).toEqual({
      consecutiveEmptySlices: 0,
      slicesWalked: 0,
      startedAt: "2026-07-14T12:00:00.000Z",
      status: "walking",
      version: 1,
      watermark: "2026-07-14T12:00:00.000Z",
    });
  });

  test("resumes from the persisted watermark and preserves progress", () => {
    const resume: SliceWalkState = {
      consecutiveEmptySlices: 2,
      slicesWalked: 7,
      startedAt: "2026-01-15T09:30:00.000Z",
      status: "walking",
      version: 1,
      watermark: "2025-06-19T09:30:00.000Z",
    };

    expect(beginSliceWalk({ now: "2026-07-14T12:00:00.000Z", resume })).toEqual(
      resume,
    );
  });

  test("continues a completed dry walk from its watermark", () => {
    const resume: SliceWalkState = {
      consecutiveEmptySlices: 3,
      slicesWalked: 9,
      startedAt: "2026-01-15T09:30:00.000Z",
      status: "dry",
      version: 1,
      watermark: "2025-04-20T09:30:00.000Z",
    };

    expect(beginSliceWalk({ now: "2026-07-14T12:00:00.000Z", resume })).toEqual(
      {
        ...resume,
        consecutiveEmptySlices: 0,
        status: "walking",
      },
    );
  });

  test("plans contiguous slices from newest to oldest", () => {
    const narrowConfig = {
      ...config,
      boundaryBufferHours: 0,
      sliceDays: 10,
    };
    const firstState = beginSliceWalk({ now: "2026-07-14T12:00:00.000Z" });
    const firstBounds = planNextSlice(firstState, narrowConfig);
    const secondState = recordSlice(
      firstState,
      { newItemCount: 2 },
      narrowConfig,
    );

    expect(firstBounds).toEqual({
      sinceDate: "2026-07-04",
      untilDate: "2026-07-14",
    });
    expect(planNextSlice(secondState, narrowConfig)).toEqual({
      sinceDate: "2026-06-24",
      untilDate: "2026-07-04",
    });
    expect(secondState.watermark).toBe("2026-07-04T12:00:00.000Z");
  });

  test("adds the boundary buffer to both fetch bounds", () => {
    const state = beginSliceWalk({ now: "2026-07-14T12:00:00.000Z" });

    expect(planNextSlice(state, config)).toEqual({
      sinceDate: "2026-06-13",
      untilDate: "2026-07-15",
    });
  });

  test("increments and resets the consecutive empty-slice counter", () => {
    const initial = beginSliceWalk({ now: "2026-07-14T12:00:00.000Z" });
    const oneEmpty = recordSlice(initial, { newItemCount: 0 }, config);
    const twoEmpty = recordSlice(oneEmpty, { newItemCount: 0 }, config);
    const yielded = recordSlice(twoEmpty, { newItemCount: 4 }, config);

    expect(oneEmpty.consecutiveEmptySlices).toBe(1);
    expect(twoEmpty.consecutiveEmptySlices).toBe(2);
    expect(yielded.consecutiveEmptySlices).toBe(0);
    expect(yielded.status).toBe("walking");
  });

  test("stops after the configured number of consecutive empty slices", () => {
    let state = beginSliceWalk({ now: "2026-07-14T12:00:00.000Z" });
    state = recordSlice(state, { newItemCount: 0 }, config);
    state = recordSlice(state, { newItemCount: 0 }, config);
    state = recordSlice(state, { newItemCount: 0 }, config);

    expect(state.status).toBe("dry");
    expect(state.consecutiveEmptySlices).toBe(3);
    expect(planNextSlice(state, config)).toBeNull();
  });

  test("moves the watermark by exactly one slice even when the slice is empty", () => {
    const state = beginSliceWalk({ now: "2026-03-31T08:15:00.000Z" });

    expect(recordSlice(state, { newItemCount: 0 }, config)).toMatchObject({
      slicesWalked: 1,
      watermark: "2026-03-01T08:15:00.000Z",
    });
  });

  test("throws loudly when the sanity ceiling is reached", () => {
    const ceilingConfig = { ...config, maxSlices: 2 };
    let state = beginSliceWalk({ now: "2026-07-14T12:00:00.000Z" });
    state = recordSlice(state, { newItemCount: 1 }, ceilingConfig);
    state = recordSlice(state, { newItemCount: 1 }, ceilingConfig);

    expect(() => planNextSlice(state, ceilingConfig)).toThrow(
      /Slice Walker sanity ceiling of 2 slices reached/u,
    );

    const dryCeilingConfig = { ...ceilingConfig, emptySliceLimit: 2 };
    let dryAtCeiling = beginSliceWalk({
      now: "2026-07-14T12:00:00.000Z",
    });
    dryAtCeiling = recordSlice(
      dryAtCeiling,
      { newItemCount: 0 },
      dryCeilingConfig,
    );
    dryAtCeiling = recordSlice(
      dryAtCeiling,
      { newItemCount: 0 },
      dryCeilingConfig,
    );
    expect(dryAtCeiling.status).toBe("dry");

    expect(() => planNextSlice(dryAtCeiling, dryCeilingConfig)).toThrow(
      /Slice Walker sanity ceiling of 2 slices reached/u,
    );
  });
});
