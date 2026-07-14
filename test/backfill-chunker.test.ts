import { describe, expect, test } from "vitest";
import { chunkBackfillItems } from "../src/connectors/backfill-chunker.ts";

describe("Backfill Chunker", () => {
  test("orders reverse-arriving history chronologically and keeps undated items stable at the end", () => {
    const chunks = chunkBackfillItems([
      { id: "newest", updatedAt: "2026-06-01T00:00:00.000Z" },
      { createdAt: "not-a-date", id: "undated-first" },
      { createdAt: "2026-02-01T00:00:00.000Z", id: "oldest" },
      { id: "undated-second" },
      { createdAt: "2026-04-01T00:00:00.000Z", id: "equal-first" },
      { createdAt: "2026-04-01T00:00:00.000Z", id: "middle" },
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.items.map((item) => item.id)).toEqual([
      "oldest",
      "equal-first",
      "middle",
      "newest",
      "undated-first",
      "undated-second",
    ]);
  });

  test("deduplicates by id and prefers the occurrence with expanded content", () => {
    const chunks = chunkBackfillItems([
      {
        id: "shared",
        snippet: "metadata-only occurrence",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      {
        content: "Expanded document body",
        id: "shared",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      { id: "unique", updatedAt: "2026-06-01T00:00:00.000Z" },
      { id: "metadata-duplicate", snippet: "keep me" },
      { id: "metadata-duplicate", snippet: "discard me" },
    ]);

    expect(chunks[0]?.items).toEqual([
      {
        content: "Expanded document body",
        id: "shared",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      { id: "unique", updatedAt: "2026-06-01T00:00:00.000Z" },
      { id: "metadata-duplicate", snippet: "keep me" },
    ]);
  });

  test("cuts chronological chunks at the item-count budget with 1-based indices", () => {
    const chunks = chunkBackfillItems(
      [
        { createdAt: "2026-01-01T00:00:00.000Z", id: "one" },
        { createdAt: "2026-02-01T00:00:00.000Z", id: "two" },
        { createdAt: "2026-03-01T00:00:00.000Z", id: "three" },
      ],
      { maxContentCharsPerChunk: 1_000, maxItemsPerChunk: 2 },
    );

    expect(
      chunks.map(({ index, items }) => ({
        ids: items.map((item) => item.id),
        index,
      })),
    ).toEqual([
      { ids: ["one", "two"], index: 1 },
      { ids: ["three"], index: 2 },
    ]);
  });

  test("cuts on content cost and preserves one oversized item in its own non-empty chunk", () => {
    const chunks = chunkBackfillItems(
      [
        { createdAt: "2026-01-01", id: "title", title: "1234" },
        { createdAt: "2026-02-01", id: "snippet", snippet: "123" },
        { content: "1234567890", createdAt: "2026-03-01", id: "oversized" },
        { createdAt: "2026-04-01", id: "tail", title: "12" },
      ],
      { maxContentCharsPerChunk: 6, maxItemsPerChunk: 10 },
    );

    expect(chunks.map((chunk) => chunk.items.map((item) => item.id))).toEqual([
      ["title"],
      ["snippet"],
      ["oversized"],
      ["tail"],
    ]);
    expect(chunks.every((chunk) => chunk.items.length > 0)).toBe(true);
    expect(chunks.reduce((count, chunk) => count + chunk.items.length, 0)).toBe(
      4,
    );
  });

  test("reports each chunk's known time span and returns no chunks for no items", () => {
    const chunks = chunkBackfillItems(
      [
        { createdAt: "2026-01-01T00:00:00.000Z", id: "oldest" },
        { id: "unknown" },
        { updatedAt: "2026-02-01T00:00:00.000Z", id: "newer" },
      ],
      { maxContentCharsPerChunk: 1_000, maxItemsPerChunk: 2 },
    );

    expect(chunks).toMatchObject([
      {
        index: 1,
        spanFrom: "2026-01-01T00:00:00.000Z",
        spanTo: "2026-02-01T00:00:00.000Z",
      },
      { index: 2 },
    ]);
    expect(chunks[1]).not.toHaveProperty("spanFrom");
    expect(chunks[1]).not.toHaveProperty("spanTo");
    expect(chunkBackfillItems([])).toEqual([]);
  });
});
