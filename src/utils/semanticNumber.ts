import { z } from "zod/v4";

export function semanticNumber<T extends z.ZodType>(
  inner: T = z.number() as unknown as T,
): z.ZodPipe<z.ZodTransform<unknown, unknown>, T> {
  return z.preprocess((value: unknown) => {
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return value;
  }, inner);
}
