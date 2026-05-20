import { readFileSync } from "node:fs";
import {
  decodeBuffer,
  detectEncodingFromBuffer,
  type DetectedEncoding,
} from "./encoding.js";
import { readFileBytes } from "./fsOperations.js";

export type LineEndingType = "CRLF" | "LF";

export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  const buffer = readFileSync(resolvedPath);
  return detectEncodingFromBuffer(buffer).encoding;
}

export function detectLineEndingsForString(content: string): LineEndingType {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      if (index > 0 && content[index - 1] === "\r") {
        crlfCount += 1;
      } else {
        lfCount += 1;
      }
    }
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}

export type FileReadMetadata = {
  content: string;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
  detected: DetectedEncoding;
};

export function readFileSyncWithMetadata(filePath: string): FileReadMetadata {
  const buffer = readFileSync(filePath);
  const detected = detectEncodingFromBuffer(buffer);
  const raw = decodeBuffer(buffer, detected);
  return {
    content: raw.replaceAll("\r\n", "\n"),
    encoding: detected.encoding,
    lineEndings: detectLineEndingsForString(raw.slice(0, 4096)),
    detected,
  };
}

export async function readFileWithMetadata(
  filePath: string,
): Promise<FileReadMetadata> {
  const buffer = await readFileBytes(filePath);
  const detected = detectEncodingFromBuffer(buffer);
  const raw = decodeBuffer(buffer, detected);
  return {
    content: raw.replaceAll("\r\n", "\n"),
    encoding: detected.encoding,
    lineEndings: detectLineEndingsForString(raw.slice(0, 4096)),
    detected,
  };
}
