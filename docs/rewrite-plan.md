# 起始页重构方案

可行性 0.83（Jev，修订部署之后）。未过线的旧版是 0.54：起始页跑在容器里，连不上宿主机 `127.0.0.1`。

这是个人起始页，不是 Homepage 兼容仪表盘的移植。

## 目标

一个人在电脑和手机上打开同一份清单，找到链接，看见服务活没活，并看到 qBittorrent、Emby 和历法信息。进程是一个 Go 二进制。电脑和手机是两份服务端渲染的 HTML。整站要登录，包括只读。端口映射到公网也不能改配置，不能拿本服务打内网。

## 不做

- 不持续兼容五文件 YAML。旧配置只导入一次。
- 起始页进程和起始页容器都不挂 Docker socket，没有 start / stop / exec。
- 不做用户、角色、JWT、OAuth。
- 不做 React、数据库、gin、gorm、插件框架、浏览器里的配置工作室。
- 天气和本机磁盘不进第一个能部署的版本。

## 留着

- 管理页里的图标出站抓取。
- 六个 widget：qBittorrent、Transmission、Emby、Immich、Caddy、Custom API。
- qBittorrent / Transmission 的四格面板，Emby 的媒体库数量和正在播放。
- 农历、节气、法定节日、时辰。

## 形态

```
cmd/homepage/main.go
internal/board/         # 清单读写、校验
internal/auth/          # setup-token、口令、cookie
internal/egress/        # 唯一出站
internal/widgets/       # 六个函数，不是框架
internal/icons/         # 管理页抓取与导入
internal/export/        # docker-export 子命令
internal/httpx/         # 路由、CSP、模板
web/desk/
web/phone/
web/admin/
web/calendar.js         # 现有无依赖历法，约 800 行
deploy/Dockerfile
```

依赖：`gopkg.in/yaml.v3`（只给导入）、`golang.org/x/crypto`（argon2id 和密钥盒）、标准库。

开发时模板从磁盘读。生产用 `go:embed`。没有 Vite，没有 Tailwind。

## 数据

```
data/                   # 数据卷。不含加密密钥
  board.json            # 不含任何密钥
  secrets.bin           # 密文
  auth.json             # 口令哈希、会话版本
  setup-token           # 设完口令即删，0600
  media/                # 图标、背景
  export.names          # 要看的容器名，给 export 读

/run/homepage/key       # 加密密钥，单独挂载，不进 data 卷，不进这份备份
/run/homepage/export.sock
```

密钥和 `secrets.bin` 分开。卷或备份被拷走也不等于明文。丢了密钥就重设密钥。

书签和服务是同一种条目。

```json
{
  "title": "Home",
  "background": "media/bg.jpg",
  "groups": [
    {
      "id": "server",
      "name": "Server",
      "items": [
        {
          "id": "a1b2c3d4",
          "name": "PVE",
          "href": "https://192.168.50.100:8006",
          "icon": "media/pve.png",
          "note": "",
          "probe": "https://192.168.50.100:8006",
          "tlsSkip": true,
          "widget": null,
          "docker": null
        }
      ]
    }
  ]
}
```

`widget` 可选：`type` 是六个之一，`url`，`secretId`，以及该类型自己的开关（Emby 的字段、正在播放；Custom API 的路径和格式）。`docker` 可选：`host`、`container`。

校验：

- `href` / `probe` / widget URL 只允许 `http` 和 `https`。
- 永远拒绝 `169.254.0.0/16`、`0.0.0.0/8`、组播、未指定地址。云元数据地址写死拒绝。
- 私网允许，因为清单就是 `192.168.50.0/24` 和 `172.17.0.0/16`。
- `tlsSkip` 只允许用在没有密钥的私网探测，以及没有密钥的图标抓取。
- 带密钥的请求禁止 `tlsSkip`。qBittorrent 登录、Emby、Custom API 的 Cookie 都算。当前这几个是明文 HTTP，不受影响。改成自签 HTTPS 时，要么装可信证书，要么该 widget 失败。
- `icon` 必须落在 `data/media` 内。

## 安全

默认可以听 `:3000`，因为手机在局域网里要开。没有会话就只能看见登录页或初始化页。

1. 没有 `auth.json` 时只开放 `/setup`。
2. 写 `setup-token`，权限 `0600`，并打到日志。重启不轮换。
3. token 常量时间比较。口令用 argon2id。成功后删除 token。
4. 会话是签名 cookie：`HttpOnly`、`SameSite=Strict`、`Path=/`，30 天。有 TLS 时加 `Secure`。改口令使旧 cookie 失效。
5. 同一 IP 五次登录失败后停 60 秒。

响应头：`nosniff`、`no-referrer`、`X-Frame-Options: DENY`、CSP 为 `default-src 'self'`，无 `unsafe-inline`。

`config/services.yaml` 里现有明文口令。文件已被 gitignore。若复制或打过包，那些口令要换。导入程序不把密钥写进日志或 `board.json`。

## 出站

探针、widget、图标抓取共用 `internal/egress`。

- 探针和 widget 只拨清单里保存的 URL。接口收条目 id，不收 URL。
- 先解析，再拨该 IP，拨号前再查一次。
- 超时 3 秒（图标抓取 8 秒）。探针和 widget 最多读 64 KiB。不跟随跨主机重定向。
- 公网校验证书。
- 探测结果缓存 15 秒。qBittorrent / Transmission 15 秒刷新，其余 widget 30 秒。

## 容器状态

起始页容器连不上宿主机 `127.0.0.1`，所以不用 TCP。

- `homepage docker-export` 只监听 Unix socket，不监听任何端口。
- socket 放在共享卷上，只读挂进 homepage 容器。起始页用标准库拨这个文件，`GET /metrics`。
- `docker.sock` 只读挂给 export，不挂给起始页。
- export 不接受请求里的容器名。保存清单时把名字写入 `export.names`。export 只报这份名单。
- socket 权限 `0660`。文件还没生成时，起始页重试拨号。

## 图标抓取

只在管理页由人触发。看板加载不出网找图标。

不带 Cookie，不带密钥。HTML 和图片各最多 2 MiB。候选放内存，几分钟过期，选中后写入 `data/media`。新上传不收 SVG。抓回来的 SVG 可以留下，只给 `<img>` 用；直接打开该地址时以附件下载。

## Widget 面板

六个类型各一个函数。

- qBittorrent、Transmission：下载速度、上传速度、下载中、做种中。SID 只活在进程内存。
- Emby：电影、剧集、集数、歌曲（按原字段开关），外加最多 5 条正在播放。密钥只放在 `X-Emby-Token`。
- Immich、Caddy、Custom API：保持现在的数字和上游列表。IYUU 走 Custom API。

电脑上面板铺在磁贴里。手机上一行仍是图标、名字、状态点；点按展开面板。

## 历法

两套布局内容相同：公历、农历、当年干支、节气、时辰、下一个法定节日倒计时。时区 `Asia/Shanghai`。法定节日只算当天，不算调休。

用现有无依赖脚本，不移植到 Go，不带 React。电脑上是顶上的一张卡。手机上是页头，字小一号，信息不减。

## 页面与路由

第一次访问用 `matchMedia('(max-width: 767px)')` 写 cookie `layout=phone|desk`，然后跳转。页脚可切换。不嗅 User-Agent。

| 方法 | 路径 | 谁 | 作用 |
|---|---|---|---|
| GET/POST | `/setup` | 未初始化 | 设口令 |
| GET/POST | `/login` | 匿名 | 登录 |
| POST | `/logout` | 会话 | 清 cookie |
| GET | `/` | 会话 | 看板 |
| GET | `/api/status` | 会话 | 按 id 返回探测点 |
| GET | `/api/widgets` | 会话 | 按 id 返回面板数据 |
| GET/POST | `/admin` | 会话 | 表单，不是工作室 |
| POST | `/admin/icons/resolve` | 会话 | 抓取图标 |
| POST | `/admin/icons/import` | 会话 | 写入 media |
| POST | `/admin/media` | 会话 | 上传 png / jpeg / webp / ico，最大 2 MiB |
| GET | `/media/*` | 会话 | 图标和背景 |

上传用文件头判断类型。没有公开的配置 JSON。

## 导入

`homepage import --from <旧 config 目录> --into <data 目录>`

- 组和条目导入 `board.json`。
- `siteMonitor` 否则 `href` 成为 `probe`。私网 `https` 设 `tlsSkip: true`。
- `ping` 丢掉。
- 图标文件复制进 `data/media`。
- `server` + `container` 写入 `docker`，并生成 `export.names`。
- widget 的口令、key、Cookie、用户名抽进 `secrets.bin`，清单只留 `secretId`。
- 报告写到 stdout，不写进网页，不打印密钥值。

服务启动之后只读 `data/`。

## 第一个能部署的版本

一次包含：登录、两套页面、导入、管理表单、时间卡、HTTP 探测、Unix socket 容器状态、六个 widget、图标抓取和导入。

验收：

- 手机和电脑是两份不同的 HTML。
- 未登录看不到任何内网地址。
- 没有 href 的容器卡片能看到运行状态。
- qBittorrent 四格和 Emby 正在播放都在。
- 页面源码和接口响应里没有旧 YAML 的口令。
- 起始页容器的挂载里没有 `docker.sock`。
- 把 `169.254.169.254` 写进条目，探测失败且不发请求。

天气和本机磁盘是后一版。磁盘路径只接受清单里的绝对路径。

## 部署

scratch 或 distroless static。`linux/amd64` 和 `linux/arm64`。非 root。

```
homepage 容器：
  挂 data 卷
  只读挂 export.sock
  不挂 docker.sock
  密钥文件单独挂到 /run/homepage/key

export：
  只读挂 docker.sock
  读写共享卷上的 socket 和 export.names
  不发布端口
```

环境变量只有 `DATA_DIR`、`KEY_FILE`、`EXPORT_SOCKET`、`LISTEN`。

本地开发：`go run ./cmd/homepage`。测试至少覆盖：地址策略、导入不把密钥写进 `board.json`、媒体路径不能跳出 `data/media`、改口令后旧 cookie 失效、export 忽略请求里的容器名。

## 已知残余

可行性 0.83 之后，剩下的是实现验证，不是再改架构：export socket 的启动顺序，以及容器能否路由到 `192.168.50.0/24`。用一次真实 compose 启动确认。
