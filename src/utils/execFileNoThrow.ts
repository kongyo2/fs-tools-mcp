import { execFile } from "node:child_process";

export async function execFileNoThrow(
  file: string,
  args: string[],
  options?: { timeout?: number; cwd?: string },
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}> {
  return await new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: options?.timeout,
        cwd: options?.cwd,
        windowsHide: true,
        maxBuffer: 20_000_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            code: typeof error.code === "number" ? error.code : -1,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            signal: error.signal ?? null,
          });
          return;
        }
        resolve({
          code: 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          signal: null,
        });
      },
    );
  });
}
