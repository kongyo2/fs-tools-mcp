const DOCUMENT_EXTENSIONS = new Set(["pdf"]);

export function parsePDFPageRange(
  pages: string,
): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim();
  if (!trimmed) {
    return null;
  }
  // Open-ended range: "5-"
  if (/^\d+-$/.test(trimmed)) {
    const firstPage = Number.parseInt(trimmed.slice(0, -1), 10);
    return firstPage < 1 ? null : { firstPage, lastPage: Number.POSITIVE_INFINITY };
  }
  // Single page: "5"
  if (/^\d+$/.test(trimmed)) {
    const page = Number.parseInt(trimmed, 10);
    return page < 1 ? null : { firstPage: page, lastPage: page };
  }
  // Range: "1-5"
  if (/^\d+-\d+$/.test(trimmed)) {
    const dashIndex = trimmed.indexOf("-");
    const firstPage = Number.parseInt(trimmed.slice(0, dashIndex), 10);
    const lastPage = Number.parseInt(trimmed.slice(dashIndex + 1), 10);
    if (firstPage < 1 || lastPage < firstPage) {
      return null;
    }
    return { firstPage, lastPage };
  }
  return null;
}

export function isPDFExtension(ext: string): boolean {
  const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
  return DOCUMENT_EXTENSIONS.has(normalized.toLowerCase());
}
