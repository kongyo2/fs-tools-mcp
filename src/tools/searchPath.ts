import { FILE_NOT_FOUND_CWD_NOTE, suggestPathUnderCwd } from "../utils/file.js";
import { safeStat } from "../utils/fsResult.js";
import { expandPath, getCwd } from "../utils/path.js";

export async function validateSearchPath(params: {
  path: string;
  missingLabel: string;
  requireDirectory?: boolean;
}): Promise<string | null> {
  const absolutePath = expandPath(params.path);
  const statResult = await safeStat(absolutePath);
  if (statResult.isErr()) {
    if (statResult.error.code === "ENOENT") {
      const cwdSuggestion = await suggestPathUnderCwd(absolutePath);
      let message = `${params.missingLabel} does not exist: ${params.path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`;
      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`;
      }
      return message;
    }
    return `Cannot access path: ${statResult.error.message}`;
  }
  if (params.requireDirectory && !statResult.value.isDirectory()) {
    return `Path is not a directory: ${params.path}`;
  }
  return null;
}
