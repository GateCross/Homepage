#!/bin/sh
# 单镜像入口：Go 服务以 homepage 用户后台运行，nginx 前台对外；
# 任一进程退出即终止另一个，避免出现「只剩一半服务」的假活容器。
set -u

# 清理异常退出残留的 pid，避免 nginx 拒绝启动
rm -f /var/run/nginx.pid 2>/dev/null || true

# 设了 API_GID 时把 Go 进程主组换成它（如宿主 docker 组），用于访问挂载的 docker.sock
if [ -n "${API_GID:-}" ]; then
  su-exec "homepage:${API_GID}" /app/homepage-api &
else
  su-exec homepage /app/homepage-api &
fi
API_PID=$!
nginx -g "daemon off;" &
NGINX_PID=$!

# 收到停止信号时把两个子进程一并带走
trap 'kill "$API_PID" "$NGINX_PID" 2>/dev/null' TERM INT

while kill -0 "$API_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 1
done

# 某个进程自行退出时兜底清理另一个
kill "$API_PID" "$NGINX_PID" 2>/dev/null || true
wait
