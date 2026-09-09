import { describe, expect, it } from "vitest";
import {
  RECOGNITION_CHUNK_MAX_CODE_POINTS,
  RECOGNITION_TEXT_MAX_CODE_POINTS,
  RecognitionTextTooLongError,
  chunkRecognitionText,
} from "./text-chunker.js";

describe("chunkRecognitionText", () => {
  it("prefers natural boundaries and preserves every code point in order", () => {
    const text = `${"甲".repeat(3988)}。\n\n${"乙".repeat(30)}`;
    const chunks = chunkRecognitionText(text);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${"甲".repeat(3988)}。\n\n`);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Array.from(chunk).length <= RECOGNITION_CHUNK_MAX_CODE_POINTS)).toBe(true);
  });

  it("hard-splits oversized paragraphs without breaking Unicode surrogate pairs", () => {
    const text = "😀".repeat(RECOGNITION_CHUNK_MAX_CODE_POINTS + 1);
    const chunks = chunkRecognitionText(text);

    expect(chunks.map((chunk) => Array.from(chunk).length)).toEqual([
      RECOGNITION_CHUNK_MAX_CODE_POINTS,
      1,
    ]);
    expect(chunks.join("")).toBe(text);
    expect(chunks.join("")).not.toContain("�");
  });

  it("rejects input above the fixed total limit with a friendly error", () => {
    const boundaryNearChunkStart = `。\n\n${"字".repeat(3997)}`;
    const maximumInput = boundaryNearChunkStart.repeat(12);
    expect(Array.from(maximumInput)).toHaveLength(RECOGNITION_TEXT_MAX_CODE_POINTS);
    expect(chunkRecognitionText(maximumInput)).toHaveLength(12);

    expect(() => chunkRecognitionText("字".repeat(RECOGNITION_TEXT_MAX_CODE_POINTS + 1))).toThrow(
      RecognitionTextTooLongError,
    );
    expect(() => chunkRecognitionText("字".repeat(RECOGNITION_TEXT_MAX_CODE_POINTS + 1))).toThrow(
      "文本过长，请缩短至 48000 个字符以内",
    );
  });
});
