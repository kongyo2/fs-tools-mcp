import { readFileBytes } from "../utils/fsOperations.js";
import {
  assertImageFitsApi,
  compressImageBufferWithTokenLimit,
  detectImageFormatFromBuffer,
  maybeResizeAndDownsampleImageBuffer,
  type ImageDimensions,
} from "../utils/image.js";

type ImageResult = {
  type: "image";
  file: {
    base64: string;
    type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    originalSize: number;
    dimensions?: ImageDimensions;
  };
};

function createImageResponse(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
  dimensions?: ImageDimensions,
): ImageResult {
  const type = `image/${mediaType}` as ImageResult["file"]["type"];
  const base64 = buffer.toString("base64");
  assertImageFitsApi(base64);
  return {
    type: "image",
    file: {
      base64,
      type,
      originalSize,
      dimensions,
    },
  };
}

export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number,
): Promise<ImageResult> {
  const imageBuffer = await readFileBytes(filePath);
  const originalSize = imageBuffer.length;
  if (originalSize === 0) {
    throw new Error(`Image file is empty: ${filePath}`);
  }

  const detectedMediaType = detectImageFormatFromBuffer(imageBuffer);
  const detectedFormat = detectedMediaType.split("/")[1] ?? "png";

  let result: ImageResult;
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      originalSize,
      detectedFormat,
    );
    result = createImageResponse(
      resized.buffer,
      resized.mediaType,
      originalSize,
      resized.dimensions,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "ImageResizeError") {
      throw error;
    }
    result = createImageResponse(imageBuffer, detectedFormat, originalSize);
  }

  const estimatedTokens = Math.ceil(result.file.base64.length * 0.125);
  if (estimatedTokens > maxTokens) {
    const compressed = await compressImageBufferWithTokenLimit(
      imageBuffer,
      maxTokens,
      detectedMediaType,
    );
    return {
      type: "image",
      file: {
        base64: compressed.base64,
        type: compressed.mediaType,
        originalSize,
      },
    };
  }

  return result;
}
