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
          {/* 双层轻遮罩：顶部/底部增强文字与卡片对比度，中段保留壁纸氛围 */}
          <div className="absolute inset-0 bg-gradient-to-b from-background/45 via-background/20 to-background/50 dark:from-background/60 dark:via-background/35 dark:to-background/65" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_45%,var(--background)_135%)] opacity-45 dark:opacity-55" />
        </>
      ) : null}
      {/* 失败时保留可访问提示；视觉上仍为默认背景 */}
      {failed ? (
        <span className="sr-only">{messages.layout.backgroundFallback}</span>
      ) : null}
    </div>
  );
}
