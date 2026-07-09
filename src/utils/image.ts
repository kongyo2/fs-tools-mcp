import sharp from "sharp";
import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from "../constants/apiLimits.js";
import { formatFileSize } from "./format.js";

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ImageDimensions = {
  originalWidth?: number;
  originalHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
};

export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageResizeError";
  }
}

export type ResizeResult = {
  buffer: Buffer;
  mediaType: string;
  dimensions?: ImageDimensions;
};

type CompressedImageResult = {
  base64: string;
  mediaType: ImageMediaType;
  originalSize: number;
};

export function detectImageFormatFromBuffer(buffer: Buffer): ImageMediaType {
  if (buffer.length < 4) {
    return "image/png";
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png";
}

export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
): Promise<ResizeResult> {
  if (imageBuffer.length === 0) {
    throw new ImageResizeError("Image file is empty (0 bytes)");
  }

  const image = sharp(imageBuffer, { failOn: "none" });
  const metadata = await image.metadata();
  const mediaType = metadata.format ?? ext;
  const normalizedMediaType = mediaType === "jpg" ? "jpeg" : mediaType;

  if (!metadata.width || !metadata.height) {
    if (originalSize > IMAGE_TARGET_RAW_SIZE) {
      const compressedBuffer = await sharp(imageBuffer)
        .jpeg({ quality: 80 })
        .toBuffer();
      return { buffer: compressedBuffer, mediaType: "jpeg" };
    }
    return { buffer: imageBuffer, mediaType: normalizedMediaType };
  }

  const originalWidth = metadata.width;
  const originalHeight = metadata.height;
  let width = originalWidth;
  let height = originalHeight;

  if (
    originalSize <= IMAGE_TARGET_RAW_SIZE &&
    width <= IMAGE_MAX_WIDTH &&
    height <= IMAGE_MAX_HEIGHT
  ) {
    return {
      buffer: imageBuffer,
      mediaType: normalizedMediaType,
      dimensions: {
        originalWidth,
        originalHeight,
        displayWidth: width,
        displayHeight: height,
      },
    };
  }

  const needsDimensionResize =
    width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT;
  const isPng = normalizedMediaType === "png";

  if (!needsDimensionResize && originalSize > IMAGE_TARGET_RAW_SIZE) {
    if (isPng) {
      const pngCompressed = await sharp(imageBuffer)
        .png({ compressionLevel: 9, palette: true })
        .toBuffer();
      if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
        return {
          buffer: pngCompressed,
          mediaType: "png",
          dimensions: {
            originalWidth,
            originalHeight,
            displayWidth: width,
            displayHeight: height,
          },
        };
      }
    }
    for (const quality of [80, 60, 40, 20]) {
      const compressedBuffer = await sharp(imageBuffer)
        .jpeg({ quality })
        .toBuffer();
      if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
        return {
          buffer: compressedBuffer,
          mediaType: "jpeg",
          dimensions: {
            originalWidth,
            originalHeight,
            displayWidth: width,
            displayHeight: height,
          },
        };
      }
    }
  }

  if (width > IMAGE_MAX_WIDTH) {
    height = Math.round((height * IMAGE_MAX_WIDTH) / width);
    width = IMAGE_MAX_WIDTH;
  }
  if (height > IMAGE_MAX_HEIGHT) {
    width = Math.round((width * IMAGE_MAX_HEIGHT) / height);
    height = IMAGE_MAX_HEIGHT;
  }

  const resizedImageBuffer = await sharp(imageBuffer)
    .resize(width, height, { fit: "inside", withoutEnlargement: true })
    .toBuffer();

  if (resizedImageBuffer.length > IMAGE_TARGET_RAW_SIZE) {
    if (isPng) {
      const pngCompressed = await sharp(imageBuffer)
        .resize(width, height, { fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true })
        .toBuffer();
      if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
        return {
          buffer: pngCompressed,
          mediaType: "png",
          dimensions: {
            originalWidth,
            originalHeight,
            displayWidth: width,
            displayHeight: height,
          },
        };
      }
    }
    for (const quality of [80, 60, 40, 20]) {
      const compressedBuffer = await sharp(imageBuffer)
        .resize(width, height, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
        return {
          buffer: compressedBuffer,
          mediaType: "jpeg",
          dimensions: {
            originalWidth,
            originalHeight,
            displayWidth: width,
            displayHeight: height,
          },
        };
      }
    }
    const smallerWidth = Math.min(width, 1000);
    const smallerHeight = Math.round(
      (height * smallerWidth) / Math.max(width, 1),
    );
    const compressedBuffer = await sharp(imageBuffer)
      .resize(smallerWidth, smallerHeight, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 20 })
      .toBuffer();
    return {
      buffer: compressedBuffer,
      mediaType: "jpeg",
      dimensions: {
        originalWidth,
        originalHeight,
        displayWidth: smallerWidth,
        displayHeight: smallerHeight,
      },
    };
  }

  return {
    buffer: resizedImageBuffer,
    mediaType: normalizedMediaType,
    dimensions: {
      originalWidth,
      originalHeight,
      displayWidth: width,
      displayHeight: height,
    },
  };
}

function createCompressedImageResult(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
): CompressedImageResult {
  const normalized = mediaType === "jpg" ? "jpeg" : mediaType;
  return {
    base64: buffer.toString("base64"),
    mediaType: `image/${normalized}` as ImageMediaType,
    originalSize,
  };
}

export async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes = IMAGE_TARGET_RAW_SIZE,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  const fallbackFormat = originalMediaType?.split("/")[1] ?? "jpeg";
  const metadata = await sharp(imageBuffer, { failOn: "none" }).metadata();
  const format = metadata.format ?? fallbackFormat;
  const originalSize = imageBuffer.length;
  if (originalSize <= maxBytes) {
    return createCompressedImageResult(imageBuffer, format, originalSize);
  }
  for (const scalingFactor of [1, 0.75, 0.5, 0.25]) {
    const resizedBuffer = await sharp(imageBuffer)
      .resize(
        Math.round((metadata.width ?? 2000) * scalingFactor),
        Math.round((metadata.height ?? 2000) * scalingFactor),
        {
          fit: "inside",
          withoutEnlargement: true,
        },
      )
      .jpeg({ quality: 80 })
      .toBuffer();
    if (resizedBuffer.length <= maxBytes) {
      return createCompressedImageResult(resizedBuffer, "jpeg", originalSize);
    }
  }
  const ultraCompressed = await sharp(imageBuffer)
    .resize(400, 400, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 20 })
    .toBuffer();
  if (ultraCompressed.length <= maxBytes) {
    return createCompressedImageResult(ultraCompressed, "jpeg", originalSize);
  }
  throw new ImageResizeError(
    `Unable to compress image (${formatFileSize(imageBuffer.length)}) to fit within ${formatFileSize(maxBytes)}. Please use a smaller image.`,
  );
}

export async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  const maxBase64Chars = Math.floor(maxTokens / 0.125);
  const maxBytes = Math.floor(maxBase64Chars * 0.75);
  return await compressImageBuffer(imageBuffer, maxBytes, originalMediaType);
}

export function assertImageFitsApi(base64: string): void {
  if (base64.length > API_IMAGE_MAX_BASE64_SIZE) {
    throw new ImageResizeError(
      `Image exceeds the API base64 limit (${formatFileSize(API_IMAGE_MAX_BASE64_SIZE)}).`,
    );
  }
}
