import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import { encodeForWrite, type DetectedEncoding } from "./encoding.js";
import { formatFileSize } from "./format.js";
import { isENOENT } from "./errors.js";
import { safeReaddirSync } from "./fsResult.js";
import { expandPath, getCwd } from "./path.js";
import type { LineEndingType } from "./fileRead.js";

// Generous default; the MCP server should deliver bytes, not gatekeep
// context size. Callers can override with FS_TOOLS_MCP_FILE_READ_MAX_BYTES.
export const MAX_OUTPUT_SIZE = 8 * 1024 * 1024;
export const FILE_NOT_FOUND_CWD_NOTE =
  "Note: your current working directory is";

export function getFileModificationTime(filePath: string): number {
  return Math.floor(statSync(filePath).mtimeMs);
}

export async function getFileModificationTimeAsync(
  filePath: string,
): Promise<number> {
  return Math.floor((await statAsync(filePath)).mtimeMs);
}

export function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
  detected?: DetectedEncoding,
): void {
  let toWrite = content;
  if (endings === "CRLF") {
    toWrite = content.replaceAll("\r\n", "\n").split("\n").join("\r\n");
  }
  if (detected) {
    writeFileSyncAndFlush(filePath, encodeForWrite(toWrite, detected));
    return;
  }
  writeFileSyncAndFlush(filePath, toWrite, { encoding });
}

export function writeFileSyncAndFlush(
  filePath: string,
  content: string | Buffer,
  options: { encoding: BufferEncoding; mode?: number } = { encoding: "utf8" },
): void {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  let originalMode: number | undefined;
  let targetExists = false;
  try {
    originalMode = statSync(filePath).mode;
    targetExists = true;
  } catch (error: unknown) {
    if (!isENOENT(error)) {
      throw error;
    }
  }
  try {
    if (Buffer.isBuffer(content)) {
      writeFileSync(tempPath, content, {
        flush: true,
        ...(targetExists
          ? {}
          : options.mode !== undefined
            ? { mode: options.mode }
            : {}),
      });
    } else {
      writeFileSync(tempPath, content, {
        encoding: options.encoding,
        flush: true,
        ...(targetExists
          ? {}
          : options.mode !== undefined
            ? { mode: options.mode }
            : {}),
      });
    }
    if (targetExists && originalMode !== undefined) {
      chmodSync(tempPath, originalMode);
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failure.
    }
    throw error;
  }
}

export function findSimilarFile(filePath: string): string | undefined {
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const fileBaseName = ext
    ? filePath.slice(filePath.lastIndexOf(sep) + 1).slice(0, -ext.length)
    : filePath.slice(filePath.lastIndexOf(sep) + 1);
  const dirResult = safeReaddirSync(dir);
  if (dirResult.isErr()) {
    return undefined;
  }
  const match = dirResult.value.find((entry) => {
    if (!entry.isFile() || entry.name === filePath) {
      return false;
    }
    const entryExt = extname(entry.name);
    const entryBase = entryExt
      ? entry.name.slice(0, -entryExt.length)
      : entry.name;
    return entryBase === fileBaseName && entryExt !== ext;
  });
  return match?.name;
}

export async function suggestPathUnderCwd(
  requestedPath: string,
): Promise<string | undefined> {
  const cwd = getCwd();
  const cwdParent = dirname(cwd);
  const prefix = cwdParent === sep ? sep : `${cwdParent}${sep}`;
  if (
    !requestedPath.startsWith(prefix) ||
    requestedPath === cwd ||
    requestedPath.startsWith(`${cwd}${sep}`)
  ) {
    return undefined;
  }
  const candidate = join(cwd, relative(cwdParent, requestedPath));
  return existsSync(candidate) ? candidate : undefined;
}

export function addLineNumbers(file: {
  content: string;
  startLine: number;
}): string {
  if (!file.content) {
    return "";
  }
  const lines = file.content.split(/\r?\n/);
  return lines
    .map((line, index) => `${index + file.startLine}\t${line}`)
    .join("\n");
}

export function readFileSyncCached(filePath: string): string {
  return readFileSync(expandPath(filePath), { encoding: "utf8" });
}

export function formatReadTooLargeMessage(
  sizeInBytes: number,
  maxSizeBytes: number,
): string {
  return `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`;
}
