// 服务入口：加载配置目录、监听文件变化，并装配全部已实现的路由。
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/gatecross/homepage/api/internal/adapters"
	"github.com/gatecross/homepage/api/internal/assets"
	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/docker"
	"github.com/gatecross/homepage/api/internal/healthcheck"
	"github.com/gatecross/homepage/api/internal/httpapi"
	"github.com/gatecross/homepage/api/internal/httpx"
	"github.com/gatecross/homepage/api/internal/icons"
	"github.com/gatecross/homepage/api/internal/probe"
	"github.com/gatecross/homepage/api/internal/providers"
	"github.com/gatecross/homepage/api/internal/routes"
)

// 监听参数，环境变量缺省时使用镜像内的约定值。
const (
	envConfigDir = "CONFIG_DIR"
	envPort      = "PORT"
	envHost      = "HOST"

	defaultConfigDir = "/app/config"
	defaultPort      = "3000"

	shutdownTimeout = 10 * time.Second
)

func main() {
	// 容器健康检查复用同一份二进制，不额外安装 curl/wget
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck.Run(envOrDefault(envPort, defaultPort)))
	}

	if err := run(); err != nil {
		log.Printf("服务异常退出：%v", err)
		os.Exit(1)
	}
}

func run() error {
	configDir := envOrDefault(envConfigDir, defaultConfigDir)
	// 空主机名表示监听全部网卡，与容器内暴露端口的行为一致
	addr := net.JoinHostPort(envOrDefault(envHost, ""), envOrDefault(envPort, defaultPort))

	store := config.NewStore()
	if err := store.Load(configDir); err != nil {
		// 首次加载失败不阻断启动：保持空快照，等待配置目录修复后热加载
		log.Printf("配置加载失败，暂以空配置启动：%v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		if err := store.Watch(ctx, configDir); err != nil {
			log.Printf("配置目录监听已停止：%v", err)
		}
	}()

	// 天气与资源客户端在进程内复用：资源采集需要跨请求保留上一拍 CPU 时间片
	weatherClient := providers.NewWeatherClient(providers.WeatherClientOptions{})
	resourcesClient := providers.NewResourcesClient(providers.ResourcesClientOptions{})

	router := httpapi.NewRouter(httpapi.Options{
		Mounts: httpapi.Mounts{
			// 写回需要磁盘目录，读端点仍只读快照
			Config: config.NewHandler(store).WithConfigDir(configDir),
			// 允许列表按请求取自当前快照，热加载后下一次请求即生效
			Docker: docker.NewHandler(currentAllowList(store), docker.Options{}),
			Assets: assets.NewHandler(configDir),
			// 图标导入落点与上传一致，都在配置目录的 images 子目录
			Icons: icons.NewHandler(icons.NewService(icons.Options{
				ImagesDir: filepath.Join(configDir, "images"),
			})),
			// mdi-* / si-* 图标经本站代理 Iconify，浏览器不直连 CDN
			Iconify: icons.NewIconifyHandler(),
			Data: routes.NewHandler(routes.Deps{
				AllowList:        currentAllowList(store),
				Probe:            probe.Run,
				RunWidget:        adapters.Run,
				FetchWeather:     weatherClient.Fetch,
				CollectResources: resourcesClient.Collect,
			}),
		},
		// 配置目录下的 images 与 icons 两个资产根直接映射到前端引用路径
		Static: httpx.NewStaticForConfig(configDir),
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		log.Printf("已监听 %s，配置目录 %s", addr, configDir)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		stop()
		<-watchDone
		return err
	case <-ctx.Done():
		log.Printf("收到退出信号，正在关闭…")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return err
	}
	<-watchDone
	return nil
}

// 环境变量为空返回默认值。
func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// 允许列表按请求取自当前快照，热加载后下一次请求即生效。
func currentAllowList(store *config.Store) func(*http.Request) *config.AllowList {
	return func(*http.Request) *config.AllowList {
		return store.Snapshot().AllowList
	}
}
