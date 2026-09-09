export const RECOGNITION_CHUNK_MAX_CODE_POINTS = 4000;
export const RECOGNITION_TEXT_MAX_CODE_POINTS = 48000;
export const RECOGNITION_MAX_CHUNKS = 12;
export const RECOGNITION_TEXT_TOO_LONG_MESSAGE = "文本过长，请缩短至 48000 个字符以内";

export class RecognitionTextTooLongError extends Error {
  constructor() {
    super(RECOGNITION_TEXT_TOO_LONG_MESSAGE);
    this.name = "RecognitionTextTooLongError";
  }
}

const SENTENCE_BOUNDARIES = new Set(["。", ".", "！", "!", "？", "?", "；", ";"]);

function findLastBoundary(
  codePoints: string[],
  minimumEnd: number,
  end: number,
  isBoundary: (index: number) => boolean,
): number | undefined {
  for (let index = end; index >= minimumEnd; index -= 1) {
    if (isBoundary(index)) return index;
  }
  return undefined;
}

export function countUnicodeCodePoints(text: string): number {
  return Array.from(text).length;
}

export function chunkRecognitionText(text: string): string[] {
  const codePoints = Array.from(text);
  if (codePoints.length > RECOGNITION_TEXT_MAX_CODE_POINTS) {
    throw new RecognitionTextTooLongError();
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < codePoints.length) {
    const hardEnd = Math.min(start + RECOGNITION_CHUNK_MAX_CODE_POINTS, codePoints.length);
    if (hardEnd === codePoints.length) {
      chunks.push(codePoints.slice(start).join(""));
      break;
    }
    const remainingChunkSlots = RECOGNITION_MAX_CHUNKS - chunks.length - 1;
    const minimumEnd = Math.max(
      start + 1,
      codePoints.length - remainingChunkSlots * RECOGNITION_CHUNK_MAX_CODE_POINTS,
    );
    const end =
      findLastBoundary(codePoints, minimumEnd, hardEnd, (index) =>
        codePoints[index - 1] === "\n" && codePoints[index - 2] === "\n",
      ) ??
      findLastBoundary(codePoints, minimumEnd, hardEnd, (index) => codePoints[index - 1] === "\n") ??
      findLastBoundary(codePoints, minimumEnd, hardEnd, (index) =>
        SENTENCE_BOUNDARIES.has(codePoints[index - 1]!),
      ) ??
      hardEnd;
    chunks.push(codePoints.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}
