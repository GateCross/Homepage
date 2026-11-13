/** HTTP 探测契约（GET /api/probe/{probeId}）。 */

export type HttpUnreachableReason = "dns" | "connect" | "tls" | "timeout" | "other";

/** 探测状态判别联合；loading 仅前端本地占位，服务端不会下发 */
export type HttpProbeState =
  | { status: "loading" }
  | {
      status: "reachable";
      httpCode?: number | undefined;
      latencyMs?: number | undefined;
    }
  | {
      status: "reachable_abnormal";
      httpCode: number;
      latencyMs?: number | undefined;
    }
  | { status: "unreachable"; reason: HttpUnreachableReason };

/** 服务端下发的探测结果（不含 loading） */
export type HttpProbeResponse = Exclude<
  HttpProbeState,
  { status: "loading" }
>;
