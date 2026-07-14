export type JsonObject = Record<string, unknown>;

export type BackfillChunkerConfig = {
  maxContentCharsPerChunk: number;
  maxItemsPerChunk: number;
};

export const DEFAULT_BACKFILL_CHUNKER_CONFIG: BackfillChunkerConfig = {
  maxContentCharsPerChunk: 80_000,
  maxItemsPerChunk: 25,
};

export type BackfillSynthesisChunk = {
  index: number;
  items: JsonObject[];
  spanFrom?: string;
  spanTo?: string;
};

export function chunkBackfillItems(
  items: JsonObject[],
  config = DEFAULT_BACKFILL_CHUNKER_CONFIG,
): BackfillSynthesisChunk[] {
  if (items.length === 0) {
    return [];
  }

  const deduplicatedItems: { inputIndex: number; item: JsonObject }[] = [];
  const indexById = new Map<string, number>();
  for (const [inputIndex, item] of items.entries()) {
    const id =
      typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
    const existingIndex = id === undefined ? undefined : indexById.get(id);
    if (existingIndex === undefined) {
      if (id !== undefined) {
        indexById.set(id, deduplicatedItems.length);
      }
      deduplicatedItems.push({ inputIndex, item });
      continue;
    }

    const existing = deduplicatedItems[existingIndex];
    if (existing && !hasContent(existing.item) && hasContent(item)) {
      deduplicatedItems[existingIndex] = { inputIndex, item };
    }
  }

  const orderedItems = deduplicatedItems
    .map(({ inputIndex, item }) => ({
      inputIndex,
      item,
      timestamp: getTimestamp(item),
    }))
    .sort((left, right) => {
      if (left.timestamp === undefined) {
        return right.timestamp === undefined
          ? left.inputIndex - right.inputIndex
          : 1;
      }
      if (right.timestamp === undefined) {
        return -1;
      }

      return (
        left.timestamp.milliseconds - right.timestamp.milliseconds ||
        left.inputIndex - right.inputIndex
      );
    });

  const chunks: BackfillSynthesisChunk[] = [];
  let chunkContentChars = 0;
  let chunkItems: JsonObject[] = [];
  for (const orderedItem of orderedItems) {
    const itemContentChars = getContentChars(orderedItem.item);
    if (
      chunkItems.length > 0 &&
      (chunkItems.length + 1 > config.maxItemsPerChunk ||
        chunkContentChars + itemContentChars > config.maxContentCharsPerChunk)
    ) {
      chunks.push(createChunk(chunks.length + 1, chunkItems));
      chunkContentChars = 0;
      chunkItems = [];
    }
    chunkItems.push(orderedItem.item);
    chunkContentChars += itemContentChars;
  }
  if (chunkItems.length > 0) {
    chunks.push(createChunk(chunks.length + 1, chunkItems));
  }

  return chunks;
}

function createChunk(
  index: number,
  items: JsonObject[],
): BackfillSynthesisChunk {
  const timestamps = items.flatMap((item) => {
    const timestamp = getTimestamp(item);
    return timestamp ? [timestamp.value] : [];
  });

  return {
    index,
    items,
    ...(timestamps.length > 0
      ? {
          spanFrom: timestamps[0],
          spanTo: timestamps.at(-1),
        }
      : {}),
  };
}

function getContentChars(item: JsonObject): number {
  return [item.content, item.snippet, item.title].reduce<number>(
    (total, value) => total + (typeof value === "string" ? value.length : 0),
    0,
  );
}

function hasContent(item: JsonObject): boolean {
  return typeof item.content === "string" && item.content.trim().length > 0;
}

function getTimestamp(
  item: JsonObject,
): { milliseconds: number; value: string } | undefined {
  const value = item.updatedAt ?? item.createdAt;
  if (typeof value !== "string") {
    return undefined;
  }

  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : { milliseconds, value };
}
