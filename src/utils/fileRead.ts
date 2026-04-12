import { readFileSync } from "node:fs";
import { readFileBytes } from "./fsOperations.js";

export type LineEndingType = "CRLF" | "LF";

export function detectEncodingForResolvedPath(resolvedPath: string): BufferEncoding {
  const buffer = readFileSync(resolvedPath);
  if (buffer.length === 0) {
    return "utf8";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return "utf16le";
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return "utf8";
  }
  return "utf8";
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

export function readFileSyncWithMetadata(filePath: string): { content: string; encoding: BufferEncoding; lineEndings: LineEndingType } {
  const encoding = detectEncodingForResolvedPath(filePath);
  const raw = readFileSync(filePath, { encoding });
  return {
    content: raw.replaceAll("\r\n", "\n"),
    encoding,
    lineEndings: detectLineEndingsForString(raw.slice(0, 4096))
  };
}

export async function readFileWithMetadata(filePath: string): Promise<{ content: string; encoding: BufferEncoding; lineEndings: LineEndingType }> {
  const buffer = await readFileBytes(filePath);
  const encoding: BufferEncoding = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? "utf16le" : "utf8";
  const raw = buffer.toString(encoding);
  return {
    content: raw.replaceAll("\r\n", "\n"),
    encoding,
    lineEndings: detectLineEndingsForString(raw.slice(0, 4096))
  };
}
