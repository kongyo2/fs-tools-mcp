import {
  chmodSync,
  existsSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { formatFileSize } from "./format.js";
import { isENOENT } from "./errors.js";
import { safeReaddirSync } from "./fsResult.js";
import { getCwd } from "./path.js";
import type { LineEndingType } from "./fileRead.js";

export const MAX_OUTPUT_SIZE = 0.25 * 1024 * 1024;
export const FILE_NOT_FOUND_CWD_NOTE =
  "Note: your current working directory is";

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
): void {
  let toWrite = content;
  if (endings === "CRLF") {
    toWrite = content.replaceAll("\r\n", "\n").split("\n").join("\r\n");
  }
  writeFileSyncAndFlush(filePath, toWrite, { encoding });
}

export function writeFileSyncAndFlush(
  filePath: string,
  content: string,
  options: { encoding: BufferEncoding; mode?: number },
): void {
  let targetPath = filePath;
  let originalMode: number | undefined;
  let targetExists = false;
  try {
    targetPath = realpathSync(filePath);
    originalMode = statSync(targetPath).mode;
    targetExists = true;
  } catch (error: unknown) {
    if (!isENOENT(error)) {
      throw error;
    }
  }
  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tempPath, content, {
      encoding: options.encoding,
      flush: true,
      ...(targetExists
        ? {}
        : options.mode !== undefined
          ? { mode: options.mode }
          : {}),
    });
    if (targetExists && originalMode !== undefined) {
      chmodSync(tempPath, originalMode);
    }
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

export function findSimilarFile(filePath: string): string | undefined {
  const fileName = basename(filePath);
  const stem = basename(filePath, extname(filePath));
  const dirResult = safeReaddirSync(dirname(filePath));
  if (dirResult.isErr()) {
    return undefined;
  }
  const match = dirResult.value.find(
    (entry) =>
      entry.isFile() &&
      entry.name !== fileName &&
      basename(entry.name, extname(entry.name)) === stem,
  );
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

export async function fileNotFoundMessage(
  fullFilePath: string,
): Promise<string> {
  const cwdSuggestion = await suggestPathUnderCwd(fullFilePath);
  const similarFilename = cwdSuggestion
    ? undefined
    : findSimilarFile(fullFilePath);
  let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`;
  if (cwdSuggestion) {
    message += ` Did you mean ${cwdSuggestion}?`;
  } else if (similarFilename) {
    message += ` Did you mean ${similarFilename}?`;
  }
  return message;
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

export function formatReadTooLargeMessage(
  sizeInBytes: number,
  maxSizeBytes: number,
): string {
  return `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`;
}
