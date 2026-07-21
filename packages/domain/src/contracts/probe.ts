import { z } from "zod";

export const HttpUnreachableReasonSchema = z.enum([
  "dns",
  "connect",
  "tls",
  "timeout",
  "other",
]);

export type HttpUnreachableReason = z.infer<typeof HttpUnreachableReasonSchema>;

const httpCodeSchema = z.number().int().min(100).max(599);
const latencyMsSchema = z.number().nonnegative();

export const HttpProbeStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("loading"),
  }),
  z.object({
    status: z.literal("reachable"),
    httpCode: httpCodeSchema.optional(),
    latencyMs: latencyMsSchema.optional(),
  }),
  z.object({
    status: z.literal("reachable_abnormal"),
    httpCode: httpCodeSchema,
    latencyMs: latencyMsSchema.optional(),
  }),
  z.object({
    status: z.literal("unreachable"),
    reason: HttpUnreachableReasonSchema,
  }),
]);

export type HttpProbeState = z.infer<typeof HttpProbeStateSchema>;

export const HttpProbeResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("reachable"),
    httpCode: httpCodeSchema.optional(),
    latencyMs: latencyMsSchema.optional(),
  }),
  z.object({
    status: z.literal("reachable_abnormal"),
    httpCode: httpCodeSchema,
    latencyMs: latencyMsSchema.optional(),
  }),
  z.object({
    status: z.literal("unreachable"),
    reason: HttpUnreachableReasonSchema,
  }),
]);

export type HttpProbeResponse = z.infer<typeof HttpProbeResponseSchema>;
