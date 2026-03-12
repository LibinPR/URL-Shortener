import { z } from 'zod';

/**
 * Zod validates the shape AND content of request bodies at runtime.
 *
 * Why Zod instead of manual checks?
 *   Without Zod:
 *     if (!req.body.url) return res.status(400).json({ error: 'url required' });
 *     if (typeof req.body.url !== 'string') return res.status(400).json(...);
 *     try { new URL(req.body.url) } catch { return res.status(400).json(...); }
 *     // ...20 more lines of this
 *
 *   With Zod: declare the schema once, call .safeParse(), get typed result.
 *
 * z.object() — defines an object schema with named fields
 * z.string() — field must be a string
 * .url()     — string must be a valid URL (uses the WHATWG URL spec)
 * .max(2048) — URL max length (browsers have practical limits ~2000 chars)
 * .optional()— field is not required in the request body
 */
export const ShortenSchema = z.object({
  url: z
    .string()
    .nonempty('url is required')
    .url('url must be a valid URL including http:// or https://')
    .max(2048, 'url must be under 2048 characters'),

  customAlias: z
    .string()
    .min(4, 'customAlias must be at least 4 characters')
    .max(30, 'customAlias must be at most 30 characters')
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'customAlias can only contain letters, numbers, hyphens, and underscores'
    )
    .optional(),

  expiresInDays: z
    .number()
    .int('expiresInDays must be a whole number')
    .min(1, 'expiresInDays must be at least 1')
    .max(3650, 'expiresInDays cannot exceed 10 years')
    .optional(),
});

// TypeScript type inferred from the Zod schema.
// This means your validated data is fully typed — no `any`.
export type ShortenInput = z.infer<typeof ShortenSchema>;