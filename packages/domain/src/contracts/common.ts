import { z } from "zod";

export const PublicErrorSchema = z.object({
  message: z.string().min(1),
  file: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  code: z.string().min(1).optional(),
});

export type PublicError = z.infer<typeof PublicErrorSchema>;

export const StatusRangeSchema = z
  .object({
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  })
  .refine((range) => range.min <= range.max, {
    message: "状态码范围的 min 不得大于 max",
    path: ["min"],
  });

export type StatusRange = z.infer<typeof StatusRangeSchema>;

export const MetricStatusSchema = z.enum([
  "ok",
  "warn",
  "error",
  "unavailable",
]);

export type MetricStatus = z.infer<typeof MetricStatusSchema>;

export const MetricSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  unit: z.string().min(1).optional(),
  status: MetricStatusSchema.optional(),
});

export type Metric = z.infer<typeof MetricSchema>;

export const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: PublicErrorSchema,
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
