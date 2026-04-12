import { execFile, spawn, type ExecFileException } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { plural } from "./string.js";

const MAX_BUFFER_SIZE = 20_000_000;

export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message);
    this.name = "RipgrepTimeoutError";
  }
}

function ripgrepTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.FS_TOOLS_MCP_GLOB_TIMEOUT_SECONDS ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured * 1000
    : process.platform === "linux" && process.env.WSL_DISTRO_NAME
      ? 60_000
      : 20_000;
}

function normalizeLines(stdout: string): string[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean);
}

function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
): void {
  const fullArgs = [...(singleThread ? ["-j", "1"] : []), ...args, target];
  execFile(
    rgPath,
    fullArgs,
    {
      encoding: "utf8",
      timeout: ripgrepTimeoutMs(),
      killSignal: process.platform === "win32" ? undefined : "SIGKILL",
      signal: abortSignal,
      windowsHide: true,
      maxBuffer: MAX_BUFFER_SIZE,
    },
    callback,
  );
}

function isEagainError(stderr: string): boolean {
  return (
    stderr.includes("os error 11") ||
    stderr.includes("Resource temporarily unavailable")
  );
}

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      retried: boolean,
    ): void => {
      if (!error) {
        resolve(normalizeLines(stdout));
        return;
      }
      if (error.code === 1) {
        resolve([]);
        return;
      }
      if (!retried && isEagainError(stderr)) {
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            handleResult(retryError, retryStdout, retryStderr, true);
          },
          true,
        );
        return;
      }
      const partialResults = stdout.trim() ? normalizeLines(stdout) : [];
      const isTimeout =
        error.signal === "SIGTERM" ||
        error.signal === "SIGKILL" ||
        error.code === "ABORT_ERR";
      if (isTimeout && partialResults.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `Ripgrep search timed out after ${Math.floor(ripgrepTimeoutMs() / 1000)} seconds. Try searching a more specific path or pattern.`,
            partialResults,
          ),
        );
        return;
      }
      resolve(partialResults);
    };

    ripGrepRaw(args, target, abortSignal, (error, stdout, stderr) => {
      handleResult(error, stdout, stderr, false);
    });
  });
}

export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, [...args, target], {
      signal: abortSignal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let remainder = "";
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      const data = remainder + chunk.toString();
      const lines = data.split("\n");
      remainder = lines.pop() ?? "";
      if (lines.length > 0) {
        onLines(lines.map((line) => line.replace(/\r$/, "")));
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (abortSignal.aborted) {
        return;
      }
      settled = true;
      if (code === 0 || code === 1) {
        if (remainder) {
          onLines([remainder.replace(/\r$/, "")]);
        }
        resolve();
        return;
      }
      reject(new Error(`ripgrep exited with code ${code ?? "unknown"}`));
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

export function formatRipgrepCountSummary(
  matches: number,
  files: number,
): string {
  return `Found ${matches} total ${plural(matches, "occurrence")} across ${files} ${plural(files, "file")}.`;
}
