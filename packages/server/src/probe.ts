/** HTTP 在线探测执行器（）。 - 优先 HEAD，必要时回退 GET - 超时 / DNS / TLS / 连接 → classifyHttpProbe → unreachable */
import {
  HttpProbeResponseSchema,
  classifyHttpProbe,
  type HttpProbeResponse,
  type NetworkProbeResult,
  type StatusRange,
} from "@homepage/domain";

import {
  HttpLocalError,
  timedFetch,
  type FetchLike,
} from "./http-utils.js";

export type ProbeTarget = {
  url: string;
  expectedStatus?: StatusRange[];
  timeoutMs: number;
};

export type RunHttpProbeOptions = {
  fetchImpl?: FetchLike;
};

/** 判断是否应在 HEAD 后回退 GET。 - 网络错误：不回退（已失败） - 405/501 或不支持：回退 - 其它 100–599：直接采用 */
function shouldFallbackToGet(statusCode: number): boolean {
  return statusCode === 405 || statusCode === 501;
}

async function attempt(
  url: string,
  method: "HEAD" | "GET",
  timeoutMs: number,
  fetchImpl?: FetchLike,
): Promise<NetworkProbeResult> {
  const started = Date.now();
  try {
    const response = await timedFetch(url, {
      method,
      timeoutMs,
      redirect: "manual",
      // 内网服务常见自签/IP 证书，探测时不因证书不受信判不可达
      insecureTls: true,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
    const latencyMs = Math.max(0, Date.now() - started);
    // 丢弃 body，避免占用
    try {
      await response.arrayBuffer();
    } catch {
      // ignore
    }
    return {
      kind: "http",
      statusCode: response.status,
      latencyMs,
    };
  } catch (err) {
    if (err instanceof HttpLocalError) {
      return {
        kind: "network_error",
        reason: err.unreachableReason,
      };
    }
    return { kind: "network_error", reason: "other" };
  }
}

export async function runHttpProbe(
  target: ProbeTarget,
  options: RunHttpProbeOptions = {},
): Promise<HttpProbeResponse> {
  const headResult = await attempt(
    target.url,
    "HEAD",
    target.timeoutMs,
    options.fetchImpl,
  );

  let networkResult = headResult;
  if (headResult.kind === "http" && shouldFallbackToGet(headResult.statusCode)) {
    networkResult = await attempt(
      target.url,
      "GET",
      target.timeoutMs,
      options.fetchImpl,
    );
  }

  const classified = classifyHttpProbe(
    networkResult,
    target.expectedStatus,
  );

  return HttpProbeResponseSchema.parse(classified);
}
