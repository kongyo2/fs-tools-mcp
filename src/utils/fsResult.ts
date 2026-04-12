import { Result, ResultAsync, ok, err } from "neverthrow";
import { stat as statAsync, mkdir as mkdirAsync } from "node:fs/promises";
import type { Stats, Dirent } from "node:fs";
import { statSync, readdirSync, mkdirSync } from "node:fs";

export interface FsError {
  code: string;
  message: string;
  path?: string;
}

export function toFsError(error: unknown): FsError {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    return {
      code: typeof e.code === "string" ? e.code : "UNKNOWN",
      message: error instanceof Error ? error.message : String(error),
      path: typeof e.path === "string" ? e.path : undefined,
    };
  }
  return { code: "UNKNOWN", message: String(error) };
}

export function safeStat(path: string): ResultAsync<Stats, FsError> {
  return ResultAsync.fromPromise(statAsync(path), toFsError);
}

export function safeMkdir(dirPath: string): ResultAsync<void, FsError> {
  return ResultAsync.fromPromise(
    mkdirAsync(dirPath, { recursive: true }).then(() => undefined),
    toFsError,
  );
}

export function safeStatSync(path: string): Result<Stats, FsError> {
  try {
    return ok(statSync(path));
  } catch (error) {
    return err(toFsError(error));
  }
}

export function safeReaddirSync(
  dirPath: string,
): Result<Dirent[], FsError> {
  try {
    return ok(readdirSync(dirPath, { withFileTypes: true }));
  } catch (error) {
    return err(toFsError(error));
  }
}

export function safeMkdirSync(dirPath: string): Result<void, FsError> {
  try {
    mkdirSync(dirPath, { recursive: true });
    return ok(undefined);
  } catch (error) {
    return err(toFsError(error));
  }
}
