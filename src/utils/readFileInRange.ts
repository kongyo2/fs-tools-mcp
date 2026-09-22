import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { formatReadTooLargeMessage } from "./file.js";

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024;

export type ReadFileRangeResult = {
  content: string;
  lineCount: number;
  totalLines: number;
  totalBytes: number;
  readBytes: number;
  mtimeMs: number;
  truncatedByBytes?: boolean;
  partialScan?: boolean;
};

export type ReadFileRangeOptions = {
  truncateOnByteLimit?: boolean;
  stopScanAfterRange?: boolean;
};

function fitSelectedBytes(params: {
  selectedBytes: number;
  hasSelection: boolean;
  text: string;
  maxBytes: number | undefined;
}): number | null {
  if (params.maxBytes === undefined) {
    return params.selectedBytes;
  }
  const separatorBytes = params.hasSelection ? 1 : 0;
  const nextBytes =
    params.selectedBytes + separatorBytes + Buffer.byteLength(params.text);
  return nextBytes > params.maxBytes ? null : nextBytes;
}

export class FileTooLargeError extends Error {
  constructor(
    public readonly sizeInBytes: number,
    public readonly maxSizeBytes: number,
  ) {
    super(formatReadTooLargeMessage(sizeInBytes, maxSizeBytes));
    this.name = "FileTooLargeError";
  }
}

export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: ReadFileRangeOptions,
): Promise<ReadFileRangeResult> {
  signal?.throwIfAborted();
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false;
  const stopScanAfterRange = options?.stopScanAfterRange ?? false;
  const stats = await stat(filePath);
  if (stats.isDirectory()) {
    throw new Error(
      `EISDIR: illegal operation on a directory, read '${filePath}'`,
    );
  }
  if (
    !truncateOnByteLimit &&
    maxBytes !== undefined &&
    stats.isFile() &&
    stats.size > maxBytes
  ) {
    throw new FileTooLargeError(stats.size, maxBytes);
  }
  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    const text = await readFile(filePath, { encoding: "utf8", signal });
    return readFileInRangeFast(
      text,
      stats.mtimeMs,
      offset,
      maxLines,
      truncateOnByteLimit ? maxBytes : undefined,
    );
  }
  return await readFileInRangeStreaming(
    filePath,
    stats.mtimeMs,
    offset,
    maxLines,
    maxBytes,
    truncateOnByteLimit,
    stopScanAfterRange,
    signal,
  );
}

function readFileInRangeFast(
  raw: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  truncateAtBytes: number | undefined,
): ReadFileRangeResult {
  const endLine =
    maxLines !== undefined ? offset + maxLines : Number.POSITIVE_INFINITY;
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  if (text.length === 0) {
    return {
      content: "",
      lineCount: 0,
      totalLines: 0,
      totalBytes: 0,
      readBytes: 0,
      mtimeMs,
    };
  }
  const selectedLines: string[] = [];
  let lineIndex = 0;
  let startPos = 0;
  let selectedBytes = 0;
  let truncatedByBytes = false;

  const tryPush = (line: string): void => {
    const nextBytes = fitSelectedBytes({
      selectedBytes,
      hasSelection: selectedLines.length > 0,
      text: line,
      maxBytes: truncateAtBytes,
    });
    if (nextBytes === null) {
      truncatedByBytes = true;
      return;
    }
    selectedBytes = nextBytes;
    selectedLines.push(line);
  };

  let newlinePos = text.indexOf("\n", startPos);
  while (newlinePos !== -1) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos, newlinePos);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      tryPush(line);
    }
    lineIndex += 1;
    startPos = newlinePos + 1;
    newlinePos = text.indexOf("\n", startPos);
  }

  if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
    let line = text.slice(startPos);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    tryPush(line);
  }
  lineIndex += 1;

  const content = selectedLines.join("\n");
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, "utf8"),
    readBytes: Buffer.byteLength(content, "utf8"),
    mtimeMs,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  };
}

async function readFileInRangeStreaming(
  filePath: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  stopScanAfterRange: boolean,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  return await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 512 * 1024,
      ...(signal ? { signal } : {}),
    });

    const state = {
      offset,
      endLine:
        maxLines !== undefined ? offset + maxLines : Number.POSITIVE_INFINITY,
      maxBytes,
      truncateOnByteLimit,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [] as string[],
      partial: "",
      firstChunk: true,
    };
    let settled = false;

    const finish = (partialScan: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      const content = state.selectedLines.join("\n");
      resolve({
        content,
        lineCount: state.selectedLines.length,
        totalLines: state.currentLineIndex,
        totalBytes: state.totalBytesRead,
        readBytes: Buffer.byteLength(content, "utf8"),
        mtimeMs,
        ...(state.truncatedByBytes ? { truncatedByBytes: true } : {}),
        ...(partialScan ? { partialScan: true } : {}),
      });
      if (partialScan) {
        stream.destroy();
      }
    };

    const rangeComplete = (): boolean =>
      state.truncatedByBytes || state.currentLineIndex >= state.endLine;

    const fitLine = (text: string): number | null =>
      fitSelectedBytes({
        selectedBytes: state.selectedBytes,
        hasSelection: state.selectedLines.length > 0,
        text,
        maxBytes: state.truncateOnByteLimit ? state.maxBytes : undefined,
      });

    stream.on("data", (chunk: string | Buffer) => {
      if (settled) {
        return;
      }
      let currentChunk =
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (state.firstChunk) {
        state.firstChunk = false;
        if (currentChunk.charCodeAt(0) === 0xfeff) {
          currentChunk = currentChunk.slice(1);
        }
      }

      state.totalBytesRead += Buffer.byteLength(currentChunk);
      if (
        !state.truncateOnByteLimit &&
        state.maxBytes !== undefined &&
        state.totalBytesRead > state.maxBytes
      ) {
        stream.destroy(
          new FileTooLargeError(state.totalBytesRead, state.maxBytes),
        );
        return;
      }

      const data =
        state.partial.length > 0
          ? `${state.partial}${currentChunk}`
          : currentChunk;
      state.partial = "";

      let startPos = 0;
      let newlinePos = data.indexOf("\n", startPos);
      while (newlinePos !== -1) {
        if (
          state.currentLineIndex >= state.offset &&
          state.currentLineIndex < state.endLine
        ) {
          let line = data.slice(startPos, newlinePos);
          if (line.endsWith("\r")) {
            line = line.slice(0, -1);
          }
          const nextBytes = fitLine(line);
          if (nextBytes === null) {
            state.truncatedByBytes = true;
            state.endLine = state.currentLineIndex;
          } else {
            state.selectedBytes = nextBytes;
            state.selectedLines.push(line);
          }
        }
        state.currentLineIndex += 1;
        startPos = newlinePos + 1;
        newlinePos = data.indexOf("\n", startPos);
      }

      if (
        startPos < data.length &&
        state.currentLineIndex >= state.offset &&
        state.currentLineIndex < state.endLine
      ) {
        const fragment = data.slice(startPos);
        if (fitLine(fragment) === null) {
          state.truncatedByBytes = true;
          state.endLine = state.currentLineIndex;
        } else {
          state.partial = fragment;
        }
      }

      if (stopScanAfterRange && rangeComplete()) {
        finish(true);
      }
    });

    stream.once("end", () => {
      if (settled) {
        return;
      }
      let line = state.partial;
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (
        state.currentLineIndex >= state.offset &&
        state.currentLineIndex < state.endLine
      ) {
        if (fitLine(line) === null) {
          state.truncatedByBytes = true;
        } else {
          state.selectedLines.push(line);
        }
      }
      state.currentLineIndex += 1;
      finish(false);
    });

    stream.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}
