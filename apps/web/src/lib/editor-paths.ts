/**
 * 配置编辑器列表的共用取值与错误路径判定。
 * 服务与书签两套编辑器结构一致，只有错误路径前缀不同。
 */

/**
 * 链接的简短展示形式：优先取 host，解析失败时截断原文。
 * 空串与纯空白返回 null。
 */
export function summarizeHref(href: string | undefined): string | null {
  if (!href?.trim()) return null;
  try {
    const u = new URL(href);
    return u.host || href;
  } catch {
    return href.length > 36 ? `${href.slice(0, 36)}…` : href;
  }
}

/**
 * 分组下是否有条目级错误；分组名本身的错误不计入。
 * root 取 `services` 或 `bookmarks`，须与校验器产出的路径前缀一致。
 */
export function groupHasItemErrors(
  errors: Record<string, string> | undefined,
  root: string,
  gi: number,
): boolean {
  if (!errors) return false;
  const prefix = `${root}.${gi}.`;
  return Object.keys(errors).some(
    (k) => k.startsWith(prefix) && k !== `${root}.${gi}.name`,
  );
}

/** 单个条目下是否有任何字段错误。 */
export function itemHasErrors(
  errors: Record<string, string> | undefined,
  root: string,
  gi: number,
  ii: number,
): boolean {
  if (!errors) return false;
  const prefix = `${root}.${gi}.items.${ii}.`;
  return Object.keys(errors).some((k) => k.startsWith(prefix));
}
