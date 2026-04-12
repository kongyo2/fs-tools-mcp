import type { StructuredPatchHunk } from "diff";
import { getPatchFromContents } from "../utils/diff.js";
import { readFileSyncCached } from "../utils/file.js";
import { errorMessage, isENOENT } from "../utils/errors.js";
import { expandPath } from "../utils/path.js";

export const LEFT_SINGLE_CURLY_QUOTE = "\u2018";
export const RIGHT_SINGLE_CURLY_QUOTE = "\u2019";
export const LEFT_DOUBLE_CURLY_QUOTE = "\u201c";
export const RIGHT_DOUBLE_CURLY_QUOTE = "\u201d";

export type FileEdit = {
  old_string: string;
  new_string: string;
  replace_all: boolean;
};

export function normalizeQuotes(value: string): string {
  return value
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

export function stripTrailingWhitespace(value: string): string {
  const parts = value.split(/(\r\n|\n|\r)/);
  let result = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      continue;
    }
    result += index % 2 === 0 ? part.replace(/\s+$/, "") : part;
  }
  return result;
}

export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) {
    return searchString;
  }
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex === -1) {
    return null;
  }
  return fileContent.substring(searchIndex, searchIndex + searchString.length);
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = chars[index - 1];
  return (
    previous === " " ||
    previous === "\t" ||
    previous === "\n" ||
    previous === "\r" ||
    previous === "(" ||
    previous === "[" ||
    previous === "{" ||
    previous === "\u2014" ||
    previous === "\u2013"
  );
}

function applyCurlyDoubleQuotes(value: string): string {
  const chars = [...value];
  return chars
    .map((char, index) =>
      char === '"'
        ? isOpeningContext(chars, index)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE
        : char,
    )
    .join("");
}

function applyCurlySingleQuotes(value: string): string {
  const chars = [...value];
  return chars
    .map((char, index) => {
      if (char !== "'") {
        return char;
      }
      const previous = index > 0 ? chars[index - 1] : undefined;
      const next = index < chars.length - 1 ? chars[index + 1] : undefined;
      const previousIsLetter =
        previous !== undefined && /\p{L}/u.test(previous);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (previousIsLetter && nextIsLetter) {
        return RIGHT_SINGLE_CURLY_QUOTE;
      }
      return isOpeningContext(chars, index)
        ? LEFT_SINGLE_CURLY_QUOTE
        : RIGHT_SINGLE_CURLY_QUOTE;
    })
    .join("");
}

export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString;
  }
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);
  let result = newString;
  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result);
  }
  return result;
}

export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  const replacer = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace);
  if (newString !== "") {
    return replacer(originalContent, oldString, newString);
  }
  const stripTrailingNewline =
    !oldString.endsWith("\n") && originalContent.includes(`${oldString}\n`);
  return stripTrailingNewline
    ? replacer(originalContent, `${oldString}\n`, newString)
    : replacer(originalContent, oldString, newString);
}

export function getPatchForEdit(params: {
  filePath: string;
  fileContents: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  return getPatchForEdits({
    filePath: params.filePath,
    fileContents: params.fileContents,
    edits: [
      {
        old_string: params.oldString,
        new_string: params.newString,
        replace_all: params.replaceAll ?? false,
      },
    ],
  });
}

export function getPatchForEdits(params: {
  filePath: string;
  fileContents: string;
  edits: FileEdit[];
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  let updatedFile = params.fileContents;
  const appliedNewStrings: string[] = [];
  for (const edit of params.edits) {
    const oldStringToCheck = edit.old_string.replace(/\n+$/, "");
    for (const previousNewString of appliedNewStrings) {
      if (
        oldStringToCheck !== "" &&
        previousNewString.includes(oldStringToCheck)
      ) {
        throw new Error(
          "Cannot edit file: old_string is a substring of a new_string from a previous edit.",
        );
      }
    }
    const previousContent = updatedFile;
    updatedFile =
      edit.old_string === ""
        ? edit.new_string
        : applyEditToFile(
            updatedFile,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          );
    if (updatedFile === previousContent) {
      throw new Error("String not found in file. Failed to apply edit.");
    }
    appliedNewStrings.push(edit.new_string);
  }
  if (updatedFile === params.fileContents) {
    throw new Error(
      "Original and edited file match exactly. Failed to apply edit.",
    );
  }
  return {
    patch: getPatchFromContents({
      filePath: params.filePath,
      oldContent: params.fileContents,
      newContent: updatedFile,
    }),
    updatedFile,
  };
}

export function normalizeFileEditInput(input: {
  file_path: string;
  edits: FileEdit[];
}): { file_path: string; edits: FileEdit[] } {
  if (input.edits.length === 0) {
    return input;
  }
  const isMarkdown = /\.(md|mdx)$/i.test(input.file_path);
  try {
    const fileContent = readFileSyncCached(expandPath(input.file_path));
    return {
      file_path: input.file_path,
      edits: input.edits.map((edit) => ({
        ...edit,
        new_string:
          fileContent.includes(edit.old_string) || isMarkdown
            ? edit.new_string
            : stripTrailingWhitespace(edit.new_string),
      })),
    };
  } catch (error) {
    if (!isENOENT(error)) {
      throw new Error(errorMessage(error));
    }
  }
  return input;
}
