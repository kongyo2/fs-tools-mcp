import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

export function getCwd(): string {
  return process.cwd();
}

export function expandPath(inputPath: string, baseDir = getCwd()): string {
  if (typeof inputPath !== "string") {
    throw new TypeError(`Path must be a string, received ${typeof inputPath}`);
  }
  if (inputPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    return normalize(baseDir).normalize("NFC");
  }
  if (trimmedPath === "~") {
    return homedir().normalize("NFC");
  }
  if (trimmedPath.startsWith("~/")) {
    return resolve(homedir(), trimmedPath.slice(2)).normalize("NFC");
  }
  if (process.platform === "win32" && /^\/[a-z]\//i.test(trimmedPath)) {
    const drive = trimmedPath[1]?.toUpperCase();
    return normalize(
      `${drive}:${trimmedPath.slice(2).replaceAll("/", sep)}`,
    ).normalize("NFC");
  }
  if (isAbsolute(trimmedPath)) {
    return normalize(trimmedPath).normalize("NFC");
  }
  return resolve(baseDir, trimmedPath).normalize("NFC");
}

export function toRelativePath(absolutePath: string): string {
  const relativePath = relative(getCwd(), absolutePath);
  return relativePath.startsWith("..") ? absolutePath : relativePath;
}

export function getDirectoryForPath(inputPath: string): string {
  const absolutePath = expandPath(inputPath);
  return dirname(absolutePath);
}

export function containsPathTraversal(inputPath: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(inputPath);
}
