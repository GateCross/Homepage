import { useEffect, useState, type JSX } from "react";

import { isDisplayableAssetPath } from "@/lib/asset-path";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

export type BackgroundProps = {

  src?: string;
  className?: string;
};

export function Background({ src, className }: BackgroundProps): JSX.Element {
  const [failed, setFailed] = useState(false);
  const safeSrc = isDisplayableAssetPath(src) ? src.trim() : undefined;

  // 背景 URL 变化时重置失败态，允许重试新图
  useEffect(() => {
    setFailed(false);
  }, [safeSrc]);

  const showImage = Boolean(safeSrc) && !failed;

  return (
    <div
      aria-hidden="true"
      data-slot="dashboard-background"
      data-fallback={showImage ? "image" : "theme-default"}
      className={cn(
        // z-0：置于页面内容之下；勿用负 z-index，否则会掉进父级 stacking context 被 bg 盖住
        "pointer-events-none fixed inset-0 z-0 overflow-hidden bg-background",
        className,
      )}
    >
      {safeSrc && !failed ? (
        <>
          <img
            src={safeSrc}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => {
              setFailed(true);
            }}
          />
          {/* 轻遮罩：保证分组标题与顶栏文字可读，同时尽量露出背景图 */}
          <div className="absolute inset-0 bg-gradient-to-b from-background/35 via-background/15 to-background/40 dark:from-background/50 dark:via-background/25 dark:to-background/55" />
        </>
      ) : null}
      {/* 失败时保留可访问提示；视觉上仍为默认背景 */}
      {failed ? (
        <span className="sr-only">{messages.layout.backgroundFallback}</span>
      ) : null}
    </div>
  );
}
