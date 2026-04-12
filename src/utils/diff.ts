import { structuredPatch, type StructuredPatchHunk } from "diff";

export type { StructuredPatchHunk };

export const CONTEXT_LINES = 3;
export const DIFF_TIMEOUT_MS = 5000;

type FileEdit = {
  old_string: string;
  new_string: string;
  replace_all: boolean;
};

function convertLeadingTabsToSpaces(content: string): string {
  if (!content.includes("\t")) {
    return content;
  }
  return content.replace(/^\t+/gm, (value) => "  ".repeat(value.length));
}

function escapeForDiff(value: string): string {
  return value.replaceAll("&", "<<:AMPERSAND_TOKEN:>>").replaceAll("$", "<<:DOLLAR_TOKEN:>>");
}

function unescapeFromDiff(value: string): string {
  return value.replaceAll("<<:AMPERSAND_TOKEN:>>", "&").replaceAll("<<:DOLLAR_TOKEN:>>", "$");
}

export function countLinesChanged(patch: StructuredPatchHunk[], newFileContent?: string): { additions: number; removals: number } {
  if (patch.length === 0 && newFileContent !== undefined) {
    return { additions: newFileContent.split(/\r?\n/).length, removals: 0 };
  }
  let additions = 0;
  let removals = 0;
  for (const hunk of patch) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        removals += 1;
      }
    }
  }
  return { additions, removals };
}

export function getPatchFromContents(params: { filePath: string; oldContent: string; newContent: string; ignoreWhitespace?: boolean; singleHunk?: boolean }): StructuredPatchHunk[] {
  const result = structuredPatch(
    params.filePath,
    params.filePath,
    escapeForDiff(params.oldContent),
    escapeForDiff(params.newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace: params.ignoreWhitespace ?? false,
      context: params.singleHunk ? 100000 : CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS
    }
  );
  return (result?.hunks ?? []).map((hunk) => ({
    ...hunk,
    lines: hunk.lines.map(unescapeFromDiff)
  }));
}

export function getPatchForDisplay(params: { filePath: string; fileContents: string; edits: FileEdit[]; ignoreWhitespace?: boolean }): StructuredPatchHunk[] {
  const prepared = escapeForDiff(convertLeadingTabsToSpaces(params.fileContents));
  const updated = params.edits.reduce((current, edit) => {
    const oldString = escapeForDiff(convertLeadingTabsToSpaces(edit.old_string));
    const newString = escapeForDiff(convertLeadingTabsToSpaces(edit.new_string));
    return edit.replace_all ? current.replaceAll(oldString, () => newString) : current.replace(oldString, () => newString);
  }, prepared);
  const result = structuredPatch(
    params.filePath,
    params.filePath,
    prepared,
    updated,
    undefined,
    undefined,
    {
      ignoreWhitespace: params.ignoreWhitespace ?? false,
      context: CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS
    }
  );
  return (result?.hunks ?? []).map((hunk) => ({
    ...hunk,
    lines: hunk.lines.map(unescapeFromDiff)
  }));
}
