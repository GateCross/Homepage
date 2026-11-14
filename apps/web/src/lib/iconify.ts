import type { IconifyJSON } from "@iconify/types";
import { getIconData, iconToSVG } from "@iconify/utils";

import mdiIconsUrl from "@iconify-json/mdi/icons.json?url";
import simpleIconsUrl from "@iconify-json/simple-icons/icons.json?url";

/** 内置图标集在产物中的 URL：构建期从 @iconify-json 包打包，运行时零外网依赖 */
const iconSetUrls = {
  mdi: mdiIconsUrl,
  si: simpleIconsUrl,
} as const;

export type IconifyKind = keyof typeof iconSetUrls;

export type IconifySvg = {
  viewBox: string;
  body: string;
};

const collections = new Map<IconifyKind, Promise<IconifyJSON>>();

/** 首次用到某类图标时才拉取整包 JSON；失败清缓存，下次渲染可重试 */
function loadCollection(kind: IconifyKind): Promise<IconifyJSON> {
  const pending = collections.get(kind);
  if (pending) {
    return pending;
  }
  const request = fetch(iconSetUrls[kind]).then((response) => {
    if (!response.ok) {
      throw new Error(`图标集加载失败：HTTP ${response.status}`);
    }
    return response.json() as Promise<IconifyJSON>;
  });
  request.catch(() => {
    collections.delete(kind);
  });
  collections.set(kind, request);
  return request;
}

/** 查询内置图标并转为 SVG 内容；集合未加载、加载失败或名称不存在时返回 null */
export async function lookupIconifySvg(
  kind: IconifyKind,
  name: string,
): Promise<IconifySvg | null> {
  let collection: IconifyJSON;
  try {
    collection = await loadCollection(kind);
  } catch {
    return null;
  }
  const icon = getIconData(collection, name);
  if (icon === null) {
    return null;
  }
  const { attributes, body } = iconToSVG(icon);
  return { viewBox: attributes.viewBox, body };
}
