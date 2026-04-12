import { z } from "zod/v4";

export function semanticBoolean<T extends z.ZodType>(inner: T = z.boolean() as unknown as T): z.ZodPipe<z.ZodTransform<unknown, unknown>, T> {
  return z.preprocess((value: unknown) => {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return value;
  }, inner);
}
