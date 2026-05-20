import chardet from "chardet";
import iconv from "iconv-lite";

export type DetectedEncoding = {
  encoding: BufferEncoding;
  iconvName?: string;
  hadBOM: boolean;
  bomLength: number;
};

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

export function detectEncodingFromBuffer(buffer: Buffer): DetectedEncoding {
  if (buffer.length === 0) {
    return { encoding: "utf8", hadBOM: false, bomLength: 0 };
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM[0] &&
    buffer[1] === UTF8_BOM[1] &&
    buffer[2] === UTF8_BOM[2]
  ) {
    return { encoding: "utf8", hadBOM: true, bomLength: 3 };
  }
  if (
    buffer.length >= 2 &&
    buffer[0] === UTF16LE_BOM[0] &&
    buffer[1] === UTF16LE_BOM[1]
  ) {
    return { encoding: "utf16le", hadBOM: true, bomLength: 2 };
  }
  if (
    buffer.length >= 2 &&
    buffer[0] === UTF16BE_BOM[0] &&
    buffer[1] === UTF16BE_BOM[1]
  ) {
    return {
      encoding: "utf16le",
      iconvName: "utf16be",
      hadBOM: true,
      bomLength: 2,
    };
  }
  const detected = chardet.detect(buffer.subarray(0, 65536));
  if (!detected) {
    return { encoding: "utf8", hadBOM: false, bomLength: 0 };
  }
  const normalized = detected.toLowerCase();
  if (normalized.startsWith("utf-8") || normalized === "ascii") {
    return { encoding: "utf8", hadBOM: false, bomLength: 0 };
  }
  if (normalized === "utf-16le" || normalized === "utf16le") {
    return { encoding: "utf16le", hadBOM: false, bomLength: 0 };
  }
  if (normalized === "utf-16be" || normalized === "utf16be") {
    return {
      encoding: "utf16le",
      iconvName: "utf16be",
      hadBOM: false,
      bomLength: 0,
    };
  }
  if (iconv.encodingExists(detected)) {
    return {
      encoding: "utf8",
      iconvName: detected,
      hadBOM: false,
      bomLength: 0,
    };
  }
  return { encoding: "utf8", hadBOM: false, bomLength: 0 };
}

export function decodeBuffer(
  buffer: Buffer,
  detected: DetectedEncoding,
): string {
  const body = detected.hadBOM ? buffer.subarray(detected.bomLength) : buffer;
  if (detected.iconvName) {
    return iconv.decode(body, detected.iconvName);
  }
  return body.toString(detected.encoding);
}

export function encodeForWrite(
  content: string,
  detected: DetectedEncoding,
): Buffer {
  const body = detected.iconvName
    ? iconv.encode(content, detected.iconvName)
    : Buffer.from(content, detected.encoding);
  if (!detected.hadBOM) {
    return body;
  }
  if (detected.iconvName === "utf16be") {
    return Buffer.concat([UTF16BE_BOM, body]);
  }
  if (detected.encoding === "utf16le") {
    return Buffer.concat([UTF16LE_BOM, body]);
  }
  if (detected.encoding === "utf8") {
    return Buffer.concat([UTF8_BOM, body]);
  }
  return body;
}
