import { closeSync, openSync, readSync, readFileSync } from "node:fs";

export type LineEndingType = "CRLF" | "LF";

const BOM_UTF16LE = [0xff, 0xfe] as const;

export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  const header = Buffer.alloc(2);
  const fd = openSync(resolvedPath, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (
    bytesRead >= 2 &&
    header[0] === BOM_UTF16LE[0] &&
    header[1] === BOM_UTF16LE[1]
  ) {
    return "utf16le";
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

export function readFileSyncWithMetadata(filePath: string): {
  content: string;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
} {
  const encoding = detectEncodingForResolvedPath(filePath);
  const raw = readFileSync(filePath, { encoding });
  return {
    content: raw.replaceAll("\r\n", "\n"),
    encoding,
    lineEndings: detectLineEndingsForString(raw.slice(0, 4096)),
  };
}

const METADATA_SNIFF_BYTES = 16 * 1024;

// Detects encoding and line endings from the head of the file without
// reading the whole file, so metadata can be preserved even for files too
// large to load into memory.
export function sniffFileTextMetadata(filePath: string): {
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
} {
  const buffer = Buffer.alloc(METADATA_SNIFF_BYTES);
  const fd = openSync(filePath, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const header = buffer.subarray(0, bytesRead);
  const encoding: BufferEncoding =
    bytesRead >= 2 &&
    header[0] === BOM_UTF16LE[0] &&
    header[1] === BOM_UTF16LE[1]
      ? "utf16le"
      : "utf8";
  const sample = header.toString(encoding).slice(0, 4096);
  return {
    encoding,
    lineEndings: detectLineEndingsForString(sample),
  };
}
