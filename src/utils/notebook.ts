type NotebookCellOutput = {
  output_type: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
};

type NotebookCell = {
  cell_type: string;
  source: string | string[];
  execution_count?: number | null;
  outputs?: NotebookCellOutput[];
  id?: string;
};

type NotebookContent = {
  metadata?: {
    language_info?: {
      name?: string;
    };
  };
  cells: NotebookCell[];
};

export type NotebookOutputImage = {
  image_data: string;
  media_type: "image/png" | "image/jpeg";
};

export type NotebookCellSourceOutput = {
  output_type: string;
  text?: string;
  image?: NotebookOutputImage;
};

export type NotebookCellSource = {
  cellType: string;
  source: string;
  execution_count?: number;
  cell_id: string;
  language?: string;
  outputs?: NotebookCellSourceOutput[];
};

const LARGE_OUTPUT_THRESHOLD = 10000;

function processOutputText(text: string | string[] | undefined): string {
  if (!text) {
    return "";
  }
  return Array.isArray(text) ? text.join("") : text;
}

function extractImage(
  data: Record<string, unknown>,
): NotebookOutputImage | undefined {
  if (typeof data["image/png"] === "string") {
    return {
      image_data: data["image/png"].replace(/\s/g, ""),
      media_type: "image/png",
    };
  }
  if (typeof data["image/jpeg"] === "string") {
    return {
      image_data: data["image/jpeg"].replace(/\s/g, ""),
      media_type: "image/jpeg",
    };
  }
  return undefined;
}

function isLargeOutputs(
  outputs: (NotebookCellSourceOutput | undefined)[],
): boolean {
  let size = 0;
  for (const output of outputs) {
    if (!output) {
      continue;
    }
    size += (output.text?.length ?? 0) + (output.image?.image_data.length ?? 0);
    if (size > LARGE_OUTPUT_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function processOutput(output: NotebookCellOutput): NotebookCellSourceOutput {
  switch (output.output_type) {
    case "stream":
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      };
    case "execute_result":
    case "display_data":
      return {
        output_type: output.output_type,
        text: processOutputText(
          output.data?.["text/plain"] as string | string[] | undefined,
        ),
        image: output.data ? extractImage(output.data) : undefined,
      };
    case "error":
      return {
        output_type: output.output_type,
        text: processOutputText(
          `${output.ename ?? "Error"}: ${output.evalue ?? ""}\n${(output.traceback ?? []).join("\n")}`,
        ),
      };
    default:
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      };
  }
}

function processCell(
  cell: NotebookCell,
  index: number,
  codeLanguage: string,
  includeLargeOutputs: boolean,
): NotebookCellSource {
  const outputs = cell.outputs?.map(processOutput);
  return {
    cellType: cell.cell_type,
    source: Array.isArray(cell.source) ? cell.source.join("") : cell.source,
    execution_count:
      cell.cell_type === "code"
        ? (cell.execution_count ?? undefined)
        : undefined,
    cell_id: cell.id ?? `cell-${index}`,
    language: cell.cell_type === "code" ? codeLanguage : undefined,
    outputs: !outputs
      ? undefined
      : includeLargeOutputs || !isLargeOutputs(outputs)
        ? outputs
        : [
            {
              output_type: "stream",
              text: `Outputs are too large to include. Use jq to inspect this notebook cell directly.`,
            },
          ],
  };
}

export function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/);
  if (!match || match[1] === undefined) {
    return undefined;
  }
  const index = Number.parseInt(match[1], 10);
  return Number.isNaN(index) ? undefined : index;
}

export async function readNotebook(
  notebookPath: string,
  cellId?: string,
): Promise<NotebookCellSource[]> {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(notebookPath, "utf8");
  const notebook = JSON.parse(content) as NotebookContent;
  const language = notebook.metadata?.language_info?.name ?? "python";
  if (cellId) {
    const targetCell = notebook.cells.find((cell) => cell.id === cellId);
    if (!targetCell) {
      throw new Error(`Cell with ID "${cellId}" not found in notebook`);
    }
    return [
      processCell(
        targetCell,
        notebook.cells.indexOf(targetCell),
        language,
        true,
      ),
    ];
  }
  return notebook.cells.map((cell, index) =>
    processCell(cell, index, language, false),
  );
}
