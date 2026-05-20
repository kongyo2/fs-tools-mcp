import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extname } from "node:path";
import { z } from "zod/v4";
import { getFileModificationTime, writeTextContent } from "../utils/file.js";
import { readFileSyncWithMetadata } from "../utils/fileRead.js";
import { isENOENT } from "../utils/errors.js";
import { parseCellId } from "../utils/notebook.js";
import { expandPath } from "../utils/path.js";
import type { SessionState } from "../state.js";

const NOTEBOOK_EDIT_TOOL_NAME = "fs_notebook_edit";

type NotebookCell = {
  cell_type: "code" | "markdown" | "raw";
  id?: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
};

type NotebookContent = {
  cells: NotebookCell[];
  metadata: {
    language_info?: { name?: string };
    [key: string]: unknown;
  };
  nbformat: number;
  nbformat_minor: number;
};

const inputSchema = z
  .object({
    notebook_path: z
      .string()
      .describe(
        "The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)",
      ),
    cell_id: z
      .string()
      .optional()
      .describe(
        "The ID of the cell to edit. When inserting, the new cell will be inserted after this one; without it, at the beginning.",
      ),
    new_source: z
      .string()
      .optional()
      .describe(
        "The new source for the cell. Required for replace and insert; ignored for delete.",
      ),
    cell_type: z
      .enum(["code", "markdown"])
      .optional()
      .describe(
        "Cell type. If not specified, defaults to the existing cell type. Required for insert.",
      ),
    edit_mode: z
      .enum(["replace", "insert", "delete"])
      .optional()
      .describe("Type of edit (replace/insert/delete). Defaults to replace."),
  })
  .strict();

const outputSchema = z.object({
  notebook_path: z.string(),
  edit_mode: z.string(),
  cell_id: z.string().optional(),
  cell_type: z.enum(["code", "markdown", "raw"]),
  language: z.string(),
  new_source: z.string(),
  original_file: z.string(),
  updated_file: z.string(),
});

export function registerFsNotebookEditTool(
  server: McpServer,
  state: SessionState,
): void {
  server.registerTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    {
      title: "Edit Notebook",
      description: `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb) with new_source.

Usage:
- notebook_path must be absolute. The file must already be a Jupyter notebook (.ipynb).
- edit_mode \`replace\` (default) overwrites cell_id's source.
- edit_mode \`insert\` adds a new cell after cell_id (or at the beginning if cell_id is omitted); cell_type is required.
- edit_mode \`delete\` removes cell_id.
- cell_id may be either the cell's actual id field or the "cell-N" index alias.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      notebook_path,
      cell_id,
      new_source,
      cell_type,
      edit_mode = "replace",
    }) => {
      try {
        const fullPath = expandPath(notebook_path);
        if (extname(fullPath) !== ".ipynb") {
          return errorResult(
            "File must be a Jupyter notebook (.ipynb). For other file types use fs_edit or fs_write.",
          );
        }
        if (edit_mode === "insert" && !cell_type) {
          return errorResult("cell_type is required when edit_mode is insert.");
        }
        if (edit_mode !== "delete" && new_source === undefined) {
          return errorResult(
            "new_source is required when edit_mode is replace or insert.",
          );
        }
        const sourceText = new_source ?? "";

        let meta: ReturnType<typeof readFileSyncWithMetadata>;
        try {
          meta = readFileSyncWithMetadata(fullPath);
        } catch (error) {
          if (isENOENT(error)) {
            return errorResult("Notebook file does not exist.");
          }
          throw error;
        }
        let notebook: NotebookContent;
        try {
          notebook = JSON.parse(meta.content) as NotebookContent;
        } catch (error) {
          return errorResult(
            `Notebook is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!Array.isArray(notebook.cells)) {
          return errorResult("Notebook has no cells array.");
        }

        let cellIndex = -1;
        if (cell_id !== undefined) {
          cellIndex = notebook.cells.findIndex((cell) => cell.id === cell_id);
          if (cellIndex === -1) {
            const parsed = parseCellId(cell_id);
            if (parsed !== undefined && notebook.cells[parsed]) {
              cellIndex = parsed;
            }
          }
          if (cellIndex === -1) {
            return errorResult(
              `Cell with ID "${cell_id}" not found in notebook.`,
            );
          }
        }

        if (edit_mode !== "insert" && cell_id === undefined) {
          return errorResult("cell_id is required for replace and delete.");
        }

        let resolvedEditMode: "replace" | "insert" | "delete" = edit_mode;
        let insertionIndex = cellIndex;
        if (resolvedEditMode === "insert") {
          insertionIndex = cell_id === undefined ? 0 : cellIndex + 1;
        }
        // Convert replace to insert only when the resolved cell sits at the
        // very end of the notebook (matches the reference behavior).
        if (
          resolvedEditMode === "replace" &&
          cellIndex === notebook.cells.length
        ) {
          resolvedEditMode = "insert";
          insertionIndex = notebook.cells.length;
          if (!cell_type) {
            cell_type = "code";
          }
        }

        const language = notebook.metadata.language_info?.name ?? "python";
        const supportsCellIds =
          notebook.nbformat > 4 ||
          (notebook.nbformat === 4 && notebook.nbformat_minor >= 5);

        let resultingCellId: string | undefined;
        if (resolvedEditMode === "delete") {
          notebook.cells.splice(cellIndex, 1);
        } else if (resolvedEditMode === "insert") {
          const newCellId = supportsCellIds
            ? Math.random().toString(36).slice(2, 15)
            : undefined;
          const baseCell: NotebookCell =
            cell_type === "markdown"
              ? {
                  cell_type: "markdown",
                  id: newCellId,
                  source: sourceText,
                  metadata: {},
                }
              : {
                  cell_type: "code",
                  id: newCellId,
                  source: sourceText,
                  metadata: {},
                  execution_count: null,
                  outputs: [],
                };
          notebook.cells.splice(insertionIndex, 0, baseCell);
          resultingCellId = newCellId;
        } else {
          const target = notebook.cells[cellIndex];
          if (!target) {
            return errorResult("Cell not found at resolved index.");
          }
          target.source = sourceText;
          if (cell_type && cell_type !== target.cell_type) {
            target.cell_type = cell_type;
            if (cell_type === "markdown") {
              delete target.execution_count;
              delete target.outputs;
            } else if (cell_type === "code") {
              // Initialize code-cell fields per nbformat spec.
              target.execution_count = null;
              target.outputs = [];
            }
          } else if (target.cell_type === "code") {
            // Editing an existing code cell: reset execution state.
            target.execution_count = null;
            target.outputs = [];
          }
          resultingCellId = target.id ?? cell_id;
        }

        const updatedContent = JSON.stringify(notebook, null, 1);
        writeTextContent(
          fullPath,
          updatedContent,
          meta.encoding,
          meta.lineEndings,
          meta.detected,
        );

        state.readFileState.set(fullPath, {
          content: updatedContent,
          timestamp: getFileModificationTime(fullPath),
          offset: undefined,
          limit: undefined,
        });

        const finalCellType: "code" | "markdown" | "raw" =
          resolvedEditMode === "delete"
            ? (cell_type ?? "code")
            : resolvedEditMode === "insert"
              ? (cell_type ?? "code")
              : (cell_type ?? notebook.cells[cellIndex]?.cell_type ?? "code");

        const data = {
          notebook_path,
          edit_mode: resolvedEditMode,
          cell_id: resultingCellId,
          cell_type: finalCellType,
          language,
          new_source: sourceText,
          original_file: meta.content,
          updated_file: updatedContent,
        };

        const summary =
          resolvedEditMode === "delete"
            ? `Deleted cell ${cell_id ?? "(unknown)"} from ${notebook_path}.`
            : resolvedEditMode === "insert"
              ? `Inserted ${finalCellType} cell into ${notebook_path}.`
              : `Replaced cell ${resultingCellId ?? cell_id ?? "(unknown)"} in ${notebook_path}.`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: data,
        };
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );
}

function errorResult(message: string): { content: any[]; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
