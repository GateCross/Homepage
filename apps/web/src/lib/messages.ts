export const messages = {

  common: {
    loading: "加载中…",
    empty: "暂无数据",
    error: "出错了",
    unsupported: "暂不支持",
    retry: "重试",
    retryHint: "请稍后重试，或检查网络与配置后再次尝试。",
    unknownError: "发生未知错误",
  },

  config: {
    loading: "正在加载配置…",
    errorTitle: "配置加载失败",
    errorFallback: "无法加载仪表盘配置",
    emptyDashboard: "当前没有可展示的内容",
  },

  boundary: {
    pageTitle: "页面出现错误",
    pageDescription: "渲染过程中发生异常，已阻止整页白屏。你可以尝试重试恢复。",
    sectionTitle: "该区域出现错误",
    sectionDescription: "此区域渲染失败，其他区域不受影响。你可以尝试重试。",
    detailsLabel: "错误详情",
  },

  empty: {
    services: "暂无服务",
    bookmarks: "暂无书签",
    info: "暂无信息组件",
    embySessions: "当前没有正在播放的内容",
    search: "未找到匹配的服务或书签",
    metrics: "暂无指标数据",
  },

  loading: {
    probe: "正在探测…",
    docker: "正在查询容器状态…",
    widget: "正在加载组件数据…",
    info: "正在加载信息…",
    weather: "正在加载天气…",
    resources: "正在加载资源占用…",
    search: "正在搜索…",
  },

  error: {
    network: "网络请求失败",
    timeout: "请求超时",
    invalidJson: "服务器返回了无法解析的响应",
    invalidResponse: "服务器返回了无效数据",
    forbidden: "无权访问该资源",
    notFound: "未找到请求的资源",
    server: "服务暂时不可用",
    probe: "探测请求失败",
    docker: "容器状态查询失败",
    widget: "组件数据加载失败",
    info: "信息组件加载失败",
    partialConfig: "配置项无效",
  },

  unsupported: {
    generic: "暂不支持",
    widget: "该服务组件类型暂不支持",
    info: "该信息组件类型暂不支持",
    ping: "Ping 探测暂不支持",
    feature: "该功能暂不支持",
  },

  probe: {
    loading: "探测中…",
    reachable: "可达",
    reachableAbnormal: "可达但状态异常",
    unreachable: "不可达",
    reason: {
      dns: "DNS 解析失败",
      connect: "连接失败",
      tls: "TLS 握手失败",
      timeout: "探测超时",
      other: "探测失败",
    },
  },

  docker: {
    loading: "查询中…",
    running: "运行中",
    starting: "启动中",
    restarting: "重启中",
    paused: "已暂停",
    stopped: "已停止",
    unavailable: "不可用",
    unavailableFallback: "无法获取容器状态",
    health: {
      healthy: "健康",
      unhealthy: "不健康",
      starting: "检查中",
    },
  },

  theme: {
    label: "主题",
    system: "跟随系统",
    light: "浅色",
    dark: "深色",
    current: "当前主题",
  },

  search: {
    label: "搜索",
    placeholder: "搜索服务与书签…",
    open: "打开搜索",
    close: "关闭搜索",
    noResults: "未找到匹配的服务或书签",
    hint: "输入关键词以筛选服务与书签",
    navigateHint: "使用方向键选择，回车打开",
    emptyHref: "该条目没有有效链接",
  },

  layout: {
    servicesSection: "服务",
    bookmarksSection: "书签",
    infoSection: "信息",
    backgroundFallback: "背景图加载失败，已回退为默认背景",
    collapseGroup: "折叠分组",
    expandGroup: "展开分组",
  },

  version: {
    label: "版本",
    checking: "正在检查版本…",
    current: "当前版本",
    updateAvailable: "有新版本",
    viewRelease: "查看发布说明",
  },
} as const;

export type Messages = typeof messages;

export type ProbeUnreachableReasonKey = keyof typeof messages.probe.reason;

export function probeUnreachableReasonText(
  reason: string | undefined,
): string {
  if (reason && reason in messages.probe.reason) {
    return messages.probe.reason[reason as ProbeUnreachableReasonKey];
  }
  return messages.probe.reason.other;
}

export function probeStatusText(
  status: "loading" | "reachable" | "reachable_abnormal" | "unreachable",
  reason?: string,
): string {
  switch (status) {
    case "loading":
      return messages.probe.loading;
    case "reachable":
      return messages.probe.reachable;
    case "reachable_abnormal":
      return messages.probe.reachableAbnormal;
    case "unreachable":
      return reason
        ? `${messages.probe.unreachable}（${probeUnreachableReasonText(reason)}）`
        : messages.probe.unreachable;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function dockerStatusText(
  status:
    | "loading"
    | "running"
    | "starting"
    | "restarting"
    | "paused"
    | "stopped"
    | "unavailable",
  reason?: string,
  opts?: {
    health?: "healthy" | "unhealthy" | "starting" | undefined;
  },
): string {
  let base: string;
  switch (status) {
    case "loading":
      base = messages.docker.loading;
      break;
    case "running":
      base = messages.docker.running;
      break;
    case "starting":
      base = messages.docker.starting;
      break;
    case "restarting":
      base = messages.docker.restarting;
      break;
    case "paused":
      base = messages.docker.paused;
      break;
    case "stopped":
      base = messages.docker.stopped;
      break;
    case "unavailable": {
      const detail = reason?.trim();
      if (detail) {
        return `${messages.docker.unavailable}（${detail}）`;
      }
      return messages.docker.unavailable;
    }
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }

  // running + healthy：只显示「健康」，避免「运行中 · 健康」冗余
  if (status === "running" && opts?.health === "healthy") {
    return messages.docker.health.healthy;
  }
  // running + unhealthy / starting：只显示健康态文案
  if (status === "running" && opts?.health) {
    return messages.docker.health[opts.health];
  }
  return base;
}
