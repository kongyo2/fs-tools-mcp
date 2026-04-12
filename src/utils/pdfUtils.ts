const DOCUMENT_EXTENSIONS = new Set(["pdf"]);

export function parsePDFPageRange(pages: string): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.endsWith("-")) {
    const firstPage = Number.parseInt(trimmed.slice(0, -1), 10);
    return Number.isNaN(firstPage) || firstPage < 1 ? null : { firstPage, lastPage: Number.POSITIVE_INFINITY };
  }
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex === -1) {
    const page = Number.parseInt(trimmed, 10);
    return Number.isNaN(page) || page < 1 ? null : { firstPage: page, lastPage: page };
  }
  const firstPage = Number.parseInt(trimmed.slice(0, dashIndex), 10);
  const lastPage = Number.parseInt(trimmed.slice(dashIndex + 1), 10);
  if (Number.isNaN(firstPage) || Number.isNaN(lastPage) || firstPage < 1 || lastPage < firstPage) {
    return null;
  }
  return { firstPage, lastPage };
}

export function isPDFExtension(ext: string): boolean {
  const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
  return DOCUMENT_EXTENSIONS.has(normalized.toLowerCase());
}
