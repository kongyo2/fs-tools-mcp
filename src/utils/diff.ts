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

export function getPatchFromContents(params: {
  filePath: string;
  oldContent: string;
  newContent: string;
  ignoreWhitespace?: boolean;
  singleHunk?: boolean;
}): StructuredPatchHunk[] {
  const result = structuredPatch(
    params.filePath,
    params.filePath,
    params.oldContent,
    params.newContent,
    undefined,
    undefined,
    {
      ignoreWhitespace: params.ignoreWhitespace ?? false,
      context: params.singleHunk ? 100000 : CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  return result?.hunks ?? [];
}

export function getPatchForDisplay(params: {
  filePath: string;
  fileContents: string;
  edits: FileEdit[];
  ignoreWhitespace?: boolean;
}): StructuredPatchHunk[] {
  const prepared = convertLeadingTabsToSpaces(params.fileContents);
  const updated = params.edits.reduce((current, edit) => {
    const oldString = convertLeadingTabsToSpaces(edit.old_string);
    const newString = convertLeadingTabsToSpaces(edit.new_string);
    return edit.replace_all
      ? current.replaceAll(oldString, () => newString)
      : current.replace(oldString, () => newString);
  }, prepared);
  return getPatchFromContents({
    filePath: params.filePath,
    oldContent: prepared,
    newContent: updated,
    ignoreWhitespace: params.ignoreWhitespace,
  });
}
