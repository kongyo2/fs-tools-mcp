import { open, readFile as readFileAsync } from "node:fs/promises";

export async function readFileBytes(
  path: string,
  maxBytes?: number,
): Promise<Buffer> {
  if (maxBytes === undefined) {
    return await readFileAsync(path);
  }
  const fileHandle = await open(path, "r");
  try {
    const metadata = await fileHandle.stat();
    const readSize = Math.min(metadata.size, maxBytes);
    const buffer = Buffer.allocUnsafe(readSize);
    let offset = 0;
    while (offset < readSize) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        offset,
        readSize - offset,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return offset < readSize ? buffer.subarray(0, offset) : buffer;
  } finally {
    await fileHandle.close();
  }
}
