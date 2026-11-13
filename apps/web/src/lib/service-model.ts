/**
 * 服务编辑器的纯模型：空值构造、关键字摘要、已绑定容器键。
 * 不依赖 React，便于单测与在多个子组件间共享。
 */
import type {
  EditableServiceGroupWrite,
  EditableServiceItemWrite,
} from "@/lib/contracts";

import { summarizeHref } from "@/lib/editor-paths";

/** 新建服务的默认值 */
export function emptyService(): EditableServiceItemWrite {
  return { name: "新服务" };
}

/** 新建分组：默认带一条服务，避免空分组无从下手 */
export function emptyGroup(): EditableServiceGroupWrite {
  return { name: "新分组", items: [emptyService()] };
}

/** 深拷贝条目，防止编辑态污染原对象 */
export function cloneService(
  item: EditableServiceItemWrite,
): EditableServiceItemWrite {
  return structuredClone(item);
}

/** 列表行上的关键字标签：隐藏态、主机、探测、容器、组件类型、描述 */
export function serviceKeywords(item: EditableServiceItemWrite): string[] {
  const tags: string[] = [];
  if (item.hidden === true) tags.push("已隐藏");
  const host = summarizeHref(item.href);
  if (host) tags.push(host);
  if (item.httpProbe?.enabled) tags.push("探测");
  if (item.docker?.container) {
    tags.push(
      item.docker.server
        ? `${item.docker.server}/${item.docker.container}`
        : item.docker.container,
    );
  }
  if (item.widget?.type) tags.push(item.widget.type);
  if (item.description?.trim()) tags.push(item.description.trim());
  return tags;
}

/** 已绑定容器的 `server::container` 键集，用于 Docker 导入时标记已占用 */
export function collectBoundDockerKeys(
  groups: EditableServiceGroupWrite[],
): Set<string> {
  const keys = new Set<string>();
  for (const g of groups) {
    for (const it of g.items) {
      if (it.docker?.server && it.docker.container) {
        keys.add(`${it.docker.server}::${it.docker.container}`);
      }
    }
  }
  return keys;
}

/** 各组件可选字段，供表单多选网格使用 */
export const EMBY_FIELD_OPTIONS = [
  { id: "movies", label: "电影" },
  { id: "series", label: "剧集" },
  { id: "episodes", label: "集数" },
  { id: "songs", label: "歌曲" },
] as const;

export const IMMICH_FIELD_OPTIONS = [
  { id: "users", label: "用户" },
  { id: "photos", label: "照片" },
  { id: "videos", label: "视频" },
  { id: "storage", label: "存储" },
] as const;

export const CADDY_FIELD_OPTIONS = [
  { id: "upstreams", label: "上游" },
  { id: "requests", label: "请求" },
  { id: "requests_failed", label: "失败" },
] as const;

/** customapi 取值格式的合法取值，与后端 mapping.format 一致 */
export const CUSTOM_API_FORMAT_OPTIONS = [
  "number",
  "percent",
  "bytes",
  "duration",
  "text",
] as const;
