const HOUR_MILLISECONDS = 60 * 60 * 1_000;
const DAY_MILLISECONDS = 24 * HOUR_MILLISECONDS;

export type SliceWalkConfig = {
  boundaryBufferHours: number;
  emptySliceLimit: number;
  maxSlices: number;
  sliceDays: number;
};

export type SliceWalkState = {
  consecutiveEmptySlices: number;
  slicesWalked: number;
  startedAt: string;
  status: "walking" | "dry";
  version: 1;
  watermark: string;
};

export type SliceBounds = {
  sinceDate: string;
  untilDate: string;
};

export function beginSliceWalk(input: {
  now: string;
  resume?: SliceWalkState;
}): SliceWalkState {
  if (input.resume) {
    return {
      ...input.resume,
      consecutiveEmptySlices:
        input.resume.status === "dry" ? 0 : input.resume.consecutiveEmptySlices,
      status: "walking",
    };
  }

  return {
    consecutiveEmptySlices: 0,
    slicesWalked: 0,
    startedAt: input.now,
    status: "walking",
    version: 1,
    watermark: input.now,
  };
}

export function planNextSlice(
  state: SliceWalkState,
  config: SliceWalkConfig,
): SliceBounds | null {
  assertWithinSanityCeiling(state, config);
  if (state.status === "dry") {
    return null;
  }

  const watermark = parseInstant(state.watermark);
  const boundaryBufferMilliseconds =
    config.boundaryBufferHours * HOUR_MILLISECONDS;
  const sliceMilliseconds = config.sliceDays * DAY_MILLISECONDS;

  return {
    sinceDate: formatDate(
      watermark - sliceMilliseconds - boundaryBufferMilliseconds,
    ),
    untilDate: formatDate(watermark + boundaryBufferMilliseconds),
  };
}

export function recordSlice(
  state: SliceWalkState,
  input: { newItemCount: number },
  config: SliceWalkConfig,
): SliceWalkState {
  assertWithinSanityCeiling(state, config);
  const consecutiveEmptySlices =
    input.newItemCount === 0 ? state.consecutiveEmptySlices + 1 : 0;

  return {
    ...state,
    consecutiveEmptySlices,
    slicesWalked: state.slicesWalked + 1,
    status:
      consecutiveEmptySlices >= config.emptySliceLimit ? "dry" : "walking",
    watermark: new Date(
      parseInstant(state.watermark) - config.sliceDays * DAY_MILLISECONDS,
    ).toISOString(),
  };
}

function assertWithinSanityCeiling(
  state: SliceWalkState,
  config: SliceWalkConfig,
): void {
  if (state.slicesWalked >= config.maxSlices) {
    throw new Error(
      `Slice Walker sanity ceiling of ${config.maxSlices} slices reached; refusing to trim the Backfill silently.`,
    );
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseInstant(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new TypeError(`Invalid Slice Walker ISO instant: ${value}`);
  }

  return timestamp;
}
