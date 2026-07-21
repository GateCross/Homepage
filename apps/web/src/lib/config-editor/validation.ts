import {
  DEFAULT_DASHBOARD_TITLE,
  isAbsoluteHttpUrl,
  normalizeTitle,
  type EditableConfig,
  type EditableConfigWrite,
  type EditableInfoWidget,
  type SecretFieldView,
  type SecretFieldWrite,
} from "@homepage/domain";

/** Docker 含 userinfo 时的固定中文提示，不回显原串 */
export const DOCKER_USERINFO_CLIENT_MESSAGE =
  "Docker 连接串不得包含用户名或密码等内嵌凭据，请改用环境变量或安全的服务端配置方式" as const;

export type FieldErrors = Record<string, string>;

export type ClientDraft = EditableConfigWrite;

function dockerConnectionHasUserInfo(connection: string): boolean {
  const trimmed = connection.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("unix://")) return false;
  if (lower.startsWith("tcp://")) {
    const rest = trimmed.slice("tcp://".length);
    const slash = rest.indexOf("/");
    const auth = slash >= 0 ? rest.slice(0, slash) : rest;
    const at = auth.lastIndexOf("@");
    return at > 0 && auth.slice(0, at).length > 0;
  }
  const schemeSep = trimmed.indexOf("://");
  if (schemeSep > 0) {
    const rest = trimmed.slice(schemeSep + 3);
    const slash = rest.indexOf("/");
    const auth = slash >= 0 ? rest.slice(0, slash) : rest;
    const at = auth.lastIndexOf("@");
    return at > 0 && auth.slice(0, at).length > 0;
  }
  return false;
}

function isSupportedDockerConnection(connection: string): boolean {
  const trimmed = connection.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("unix://")) {
    const socketPath = trimmed.slice("unix://".length);
    return socketPath.startsWith("/") && socketPath.length > 1;
  }
  if (lower.startsWith("tcp://")) {
    return trimmed.length > "tcp://".length;
  }
  return false;
}

function requireName(value: string, path: string, errors: FieldErrors): void {
  if (value.trim().length === 0) {
    errors[path] = "名称不能为空";
  }
}

function requireHttpUrl(
  value: string | undefined,
  path: string,
  errors: FieldErrors,
  required: boolean,
): void {
  if (value === undefined || value.trim().length === 0) {
    if (required) errors[path] = "链接不能为空";
    return;
  }
  if (!isAbsoluteHttpUrl(value.trim())) {
    errors[path] = "须为绝对 HTTP 或 HTTPS 链接";
  }
}

export type NormalizedDiskEntry =
  | string
  | { path: string; label?: string | undefined };

/**
 * 将磁盘草稿规范为 string | 数组：
 * - 支持 path|别名、path：别名
 * - 对象 { path, label }
 * - 逗号分隔多条
 */
export function normalizeDiskDraft(
  disk:
    | string
    | Array<string | { path: string; label?: string | undefined }>
    | undefined,
): string | NormalizedDiskEntry[] | undefined {
  if (disk === undefined) return undefined;

  const entries: NormalizedDiskEntry[] = [];

  const pushRaw = (raw: string): void => {
    const t = raw.trim();
    if (t.length === 0) return;
    const pipe = t.indexOf("|");
    if (pipe > 0) {
      const path = t.slice(0, pipe).trim();
      const label = t.slice(pipe + 1).trim();
      if (path.length === 0) return;
      entries.push(label.length > 0 ? { path, label } : path);
      return;
    }
    const colon = t.match(/^(.+?)[：:](.+)$/);
    if (colon) {
      const left = colon[1]!.trim();
      const right = colon[2]!.trim();
      if (!(left.length === 1 && /[A-Za-z]/.test(left)) && left.length > 0) {
        entries.push(right.length > 0 ? { path: left, label: right } : left);
        return;
      }
    }
    entries.push(t);
  };

  if (typeof disk === "string") {
    for (const part of disk.split(/[,，]/)) pushRaw(part);
  } else {
    for (const item of disk) {
      if (typeof item === "string") {
        pushRaw(item);
      } else if (item && typeof item.path === "string") {
        const path = item.path.trim();
        if (path.length === 0) continue;
        const label = item.label?.trim();
        entries.push(label && label.length > 0 ? { path, label } : path);
      }
    }
  }

  if (entries.length === 0) return undefined;
  if (entries.length === 1) {
    const only = entries[0]!;
    // 单条对象也保持数组，避免丢失 label 结构
    return typeof only === "string" ? only : [only];
  }
  return entries;
}

/** 保存前规范化草稿中的磁盘路径字段 */
export function prepareDraftForSave(draft: ClientDraft): ClientDraft {
  return {
    ...draft,
    infoWidgets: draft.infoWidgets.map((w) => {
      if (w.type !== "resources") return w;
      const disk = normalizeDiskDraft(w.disk);
      if (disk === undefined) {
        const { disk: _removed, ...rest } = w;
        void _removed;
        return rest;
      }
      return { ...w, disk };
    }),
  };
}

/**
 * 客户端校验：失败时返回字段路径 → 中文错误；通过返回 null。
 * 校验失败不得发起写回。
 */
export function validateEditableDraft(draft: ClientDraft): FieldErrors | null {
  const errors: FieldErrors = {};

  for (let gi = 0; gi < draft.services.length; gi += 1) {
    const group = draft.services[gi];
    if (!group) continue;
    requireName(group.name, `services.${gi}.name`, errors);
    for (let ii = 0; ii < group.items.length; ii += 1) {
      const item = group.items[ii];
      if (!item) continue;
      requireName(item.name, `services.${gi}.items.${ii}.name`, errors);
      requireHttpUrl(
        item.href,
        `services.${gi}.items.${ii}.href`,
        errors,
        false,
      );
      if (item.httpProbe?.enabled && item.httpProbe.url) {
        requireHttpUrl(
          item.httpProbe.url,
          `services.${gi}.items.${ii}.httpProbe.url`,
          errors,
          false,
        );
      }
      if (item.widget?.url) {
        requireHttpUrl(
          item.widget.url,
          `services.${gi}.items.${ii}.widget.url`,
          errors,
          true,
        );
      }
    }
  }

  for (let gi = 0; gi < draft.bookmarks.length; gi += 1) {
    const group = draft.bookmarks[gi];
    if (!group) continue;
    requireName(group.name, `bookmarks.${gi}.name`, errors);
    for (let ii = 0; ii < group.items.length; ii += 1) {
      const item = group.items[ii];
      if (!item) continue;
      requireName(item.name, `bookmarks.${gi}.items.${ii}.name`, errors);
      requireHttpUrl(
        item.href,
        `bookmarks.${gi}.items.${ii}.href`,
        errors,
        true,
      );
    }
  }

  for (let i = 0; i < draft.infoWidgets.length; i += 1) {
    const w = draft.infoWidgets[i] as EditableInfoWidget | undefined;
    if (!w) continue;
    if (w.type === "openmeteo") {
      const cityId = w.cityId.trim().replace(/^weathercn:/i, "");
      if (!/^\d{6,12}$/.test(cityId)) {
        errors[`infoWidgets.${i}`] = "天气组件须填写有效城市编码（如 101020100）";
      } else if (w.location.trim().length === 0) {
        errors[`infoWidgets.${i}`] = "天气组件须填写地点名称";
      }
    }
  }

  for (let i = 0; i < draft.dockerEndpoints.length; i += 1) {
    const ep = draft.dockerEndpoints[i];
    if (!ep) continue;
    requireName(ep.name, `dockerEndpoints.${i}.name`, errors);
    const conn = ep.connection.trim();
    if (conn.length === 0) {
      errors[`dockerEndpoints.${i}.connection`] = "连接串不能为空";
    } else if (dockerConnectionHasUserInfo(conn)) {
      errors[`dockerEndpoints.${i}.connection`] =
        DOCKER_USERINFO_CLIENT_MESSAGE;
    } else if (!isSupportedDockerConnection(conn)) {
      errors[`dockerEndpoints.${i}.connection`] =
        "连接串须为 unix:///path 或 tcp://host:port 形式";
    }
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

function viewToKeepWrite(
  view: SecretFieldView | undefined,
): SecretFieldWrite | undefined {
  if (view === undefined) return undefined;
  // 仅已配置密钥进入 keep；unset 不写入 draft，避免 UI 误显示「已配置」
  if (view.status !== "configured") return undefined;
  return { mode: "keep" };
}

/**
 * 从 GET editable 视图生成默认写回载荷：全部密钥为 keep。
 */
export function editableViewToDefaultWrite(
  view: EditableConfig,
): EditableConfigWrite {
  return {
    settings: {
      title: view.settings.title,
      useEqualHeights: view.settings.useEqualHeights,
      layout: view.settings.layout.map((e) => ({ ...e })),
      ...(view.settings.background !== undefined
        ? { background: view.settings.background }
        : {}),
      ...(view.settings.favicon !== undefined
        ? { favicon: view.settings.favicon }
        : {}),
    },
    services: view.services.map((g) => ({
      name: g.name,
      items: g.items.map((item) => {
        const writeItem: EditableConfigWrite["services"][number]["items"][number] =
          {
            name: item.name,
            ...(item.href !== undefined ? { href: item.href } : {}),
            ...(item.target !== undefined ? { target: item.target } : {}),
            ...(item.icon !== undefined ? { icon: item.icon } : {}),
            ...(item.description !== undefined
              ? { description: item.description }
              : {}),
            ...(item.httpProbe !== undefined
              ? { httpProbe: { ...item.httpProbe } }
              : {}),
            ...(item.docker !== undefined
              ? { docker: { ...item.docker } }
              : {}),
          };
        if (item.widget !== undefined) {
          writeItem.widget = {
            type: item.widget.type,
            ...(item.widget.url !== undefined ? { url: item.widget.url } : {}),
            ...(item.widget.method !== undefined
              ? { method: item.widget.method }
              : {}),
            ...(item.widget.username !== undefined
              ? { username: viewToKeepWrite(item.widget.username) }
              : {}),
            ...(item.widget.password !== undefined
              ? { password: viewToKeepWrite(item.widget.password) }
              : {}),
            ...(item.widget.key !== undefined
              ? { key: viewToKeepWrite(item.widget.key) }
              : {}),
            ...(item.widget.apiKey !== undefined
              ? { apiKey: viewToKeepWrite(item.widget.apiKey) }
              : {}),
            ...(item.widget.token !== undefined
              ? { token: viewToKeepWrite(item.widget.token) }
              : {}),
            ...(item.widget.headers !== undefined
              ? {
                  headers: item.widget.headers.map((h) => ({
                    name: h.name,
                    value: viewToKeepWrite(h.value) ?? { mode: "keep" },
                  })),
                }
              : {}),
            ...(item.widget.mappings !== undefined
              ? { mappings: item.widget.mappings.map((m) => ({ ...m })) }
              : {}),
          };
        }
        return writeItem;
      }),
    })),
    bookmarks: view.bookmarks.map((g) => ({
      name: g.name,
      items: g.items.map((item) => ({ ...item })),
    })),
    infoWidgets: view.infoWidgets.map((w) => ({ ...w })),
    dockerEndpoints: view.dockerEndpoints.map((e) => ({ ...e })),
  };
}

/** 标题 trim；空则中文默认标题 */
export function resolveDocumentTitle(title: string | undefined): string {
  return normalizeTitle(title ?? "");
}

export { DEFAULT_DASHBOARD_TITLE };

/** 列表上移 */
export function moveItemUp<T>(list: T[], index: number): T[] {
  if (index <= 0 || index >= list.length) return list;
  const next = [...list];
  const a = next[index - 1];
  const b = next[index];
  if (a === undefined || b === undefined) return list;
  next[index - 1] = b;
  next[index] = a;
  return next;
}

/** 列表下移 */
export function moveItemDown<T>(list: T[], index: number): T[] {
  if (index < 0 || index >= list.length - 1) return list;
  const next = [...list];
  const a = next[index];
  const b = next[index + 1];
  if (a === undefined || b === undefined) return list;
  next[index] = b;
  next[index + 1] = a;
  return next;
}

/** 将 from 位置元素移到 to 位置；索引非法或相同则原样返回 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length
  ) {
    return list;
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return list;
  next.splice(to, 0, item);
  return next;
}
