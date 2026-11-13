// Package routes 实现按允许列表授权的数据端点：HTTP 探测、服务组件与信息组件。
package routes

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/gatecross/homepage/api/internal/adapters"
	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
	"github.com/gatecross/homepage/api/internal/httpapi"
	"github.com/gatecross/homepage/api/internal/probe"
	"github.com/gatecross/homepage/api/internal/providers"
)

// 固定失败文案，均不含内部细节。
const (
	msgProbeForbidden  = "探测目标未登记或无权访问"
	msgWidgetForbidden = "服务组件目标未登记或无权访问"
	msgInfoForbidden   = "信息组件目标未登记或无权访问"
	msgDatetimeNoData  = "日期时间组件由前端本地格式化，不提供数据接口"
	msgInfoUnsupported = "信息组件类型不受支持或未登记"
	msgInvalidConfig   = "组件配置无效或未登记"
	msgInternal        = "服务暂时不可用，请稍后重试"
	msgWidgetGeneric   = "服务组件请求失败"
	msgAPINotFound     = "未找到请求的 API 接口"
)

// 三个数据端点的公共依赖；未注入的回调按对应能力不可用处理。
type Deps struct {
	// AllowList 按请求返回当次允许列表；返回值不得被修改。
	AllowList func(*http.Request) *config.AllowList
	// Probe 执行一次站点探测。
	Probe func(ctx context.Context, targetURL string, timeoutMs int, expected []domain.StatusRange) probe.Result
	// RunWidget 执行一次服务组件调用。
	RunWidget func(ctx context.Context, request adapters.RunRequest) adapters.ServiceWidgetResult
	// FetchWeather 拉取指定城市的天气。
	FetchWeather func(ctx context.Context, target providers.OpenMeteoTarget) (providers.OpenMeteoInfoResponse, error)
	// CollectResources 采集系统资源。
	CollectResources func(ctx context.Context, target providers.ResourcesTarget) providers.ResourcesInfoResponse
}

// 只有已登记的探测目标才出网；未登记返回 403 且 0 次请求。
func handleProbe(deps Deps, w http.ResponseWriter, r *http.Request, rawID string) {
	allowList := currentAllowList(deps, r)
	probeID, ok := decodeSegment(rawID)
	if !ok {
		httpapi.Forbidden(msgProbeForbidden).Write(w)
		return
	}

	target, registered := allowListTarget(allowList, probeID)
	if !registered {
		httpapi.Forbidden(msgProbeForbidden).Write(w)
		return
	}
	if deps.Probe == nil {
		httpapi.Internal(msgInternal).Write(w)
		return
	}

	result := deps.Probe(r.Context(), target.URL, target.TimeoutMs, target.ExpectedStatus)
	writeScanned(w, result, allowList, "探测")
}

// 只有已登记的服务组件才出网；适配器业务失败仍以 200 + ok:false 返回。
func handleWidget(deps Deps, w http.ResponseWriter, r *http.Request, rawID string) {
	allowList := currentAllowList(deps, r)
	widgetID, ok := decodeSegment(rawID)
	if !ok {
		httpapi.Forbidden(msgWidgetForbidden).Write(w)
		return
	}

	var (
		target     config.WidgetTarget
		registered bool
	)
	if allowList != nil {
		target, registered = allowList.WidgetTargets[widgetID]
	}
	if !registered {
		httpapi.Forbidden(msgWidgetForbidden).Write(w)
		return
	}
	if deps.RunWidget == nil {
		httpapi.Internal(msgInternal).Write(w)
		return
	}

	result := deps.RunWidget(r.Context(), adapters.RunRequest{
		Type: target.Type,
		RunInput: adapters.RunInput{
			URL:     target.URL,
			Secrets: target.Secrets,
			Options: target.Options,
		},
	})
	if !result.Ok {
		// 失败只带中文原因；命中密钥时替换成固定文案，避免把凭据带出去
		if containsSecret(result, allowList) {
			logSecretHit("服务组件")
			httpapi.WriteJSON(w, http.StatusOK, adapters.FailureResult(msgWidgetGeneric))
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, result)
		return
	}
	writeScanned(w, result, allowList, "服务组件")
}

// 按信息组件类型分派；datetime 只在前端格式化，不提供数据接口。
func handleInfo(deps Deps, w http.ResponseWriter, r *http.Request, rawID string) {
	allowList := currentAllowList(deps, r)
	infoID, ok := decodeSegment(rawID)
	if !ok {
		httpapi.Forbidden(msgInfoForbidden).Write(w)
		return
	}

	var (
		target     config.InfoTarget
		registered bool
	)
	if allowList != nil {
		target, registered = allowList.InfoTargets[infoID]
	}
	if !registered {
		httpapi.Forbidden(msgInfoForbidden).Write(w)
		return
	}

	switch target.Type {
	case "datetime":
		httpapi.Forbidden(msgDatetimeNoData).Write(w)

	case "openmeteo":
		options, parsed := parseWeatherTarget(target.Options)
		if !parsed {
			httpapi.Forbidden(msgInvalidConfig).Write(w)
			return
		}
		if deps.FetchWeather == nil {
			httpapi.Internal(msgInternal).Write(w)
			return
		}
		info, err := deps.FetchWeather(r.Context(), options)
		if err != nil {
			writeWeatherFailure(w, err)
			return
		}
		writeScanned(w, info, allowList, "天气")

	case "resources":
		options, parsed := providers.ParseResourcesTarget(target.Options)
		if !parsed {
			httpapi.Forbidden(msgInvalidConfig).Write(w)
			return
		}
		if deps.CollectResources == nil {
			httpapi.Internal(msgInternal).Write(w)
			return
		}
		writeScanned(w, deps.CollectResources(r.Context(), options), allowList, "资源")

	default:
		httpapi.Forbidden(msgInfoUnsupported).Write(w)
	}
}

// 天气失败按来源映射：超时 504，其余出站失败 502，识别不了的按内部错误。
func writeWeatherFailure(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		httpapi.Internal(msgInternal).Write(w)
	case isWeatherTimeout(err):
		httpapi.NewError(httpapi.CodeExternalTmo, err.Error()).Write(w)
	case isWeatherKnown(err):
		httpapi.NewError(httpapi.CodeExternal, err.Error()).Write(w)
	default:
		httpapi.Internal(msgInternal).Write(w)
	}
}

// 天气客户端只回三种可外露的错误，文案本身可直接下发。
func isWeatherKnown(err error) bool {
	return err == providers.ErrWeatherUnavailable || err == providers.ErrWeatherInvalid
}

// 超时错误单独判定，避免把超时与不可达混为一谈。
func isWeatherTimeout(err error) bool {
	return err == providers.ErrWeatherTimeout
}

// 取当次允许列表；未注入时返回 nil，所有目标都按未登记处理。
func currentAllowList(deps Deps, r *http.Request) *config.AllowList {
	if deps.AllowList == nil {
		return nil
	}
	return deps.AllowList(r)
}

// 按 ID 查探测目标；空允许列表不命中任何目标。
func allowListTarget(allowList *config.AllowList, probeID string) (config.HTTPProbeTarget, bool) {
	if allowList == nil {
		return config.HTTPProbeTarget{}, false
	}
	target, ok := allowList.HTTPProbeTargets[probeID]
	return target, ok
}

// 路径片段按百分号解码并去空白；非法转义或空串按未登记处理。
func decodeSegment(raw string) (string, bool) {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(decoded)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// 天气目标只接受 6–12 位纯数字城市编码与非空地点名，避免拼出任意 locationKey。
func parseWeatherTarget(options any) (providers.OpenMeteoTarget, bool) {
	doc, ok := options.(map[string]any)
	if !ok {
		return providers.OpenMeteoTarget{}, false
	}
	cityID, ok := doc["cityId"].(string)
	if !ok {
		return providers.OpenMeteoTarget{}, false
	}
	location, ok := doc["location"].(string)
	if !ok {
		return providers.OpenMeteoTarget{}, false
	}
	cityID = strings.TrimSpace(cityID)
	location = strings.TrimSpace(location)
	if cityID == "" || location == "" || !numericCityID(cityID) {
		return providers.OpenMeteoTarget{}, false
	}
	return providers.OpenMeteoTarget{CityID: cityID, Location: location}, true
}

// 城市编码为 6–12 位纯数字。
func numericCityID(cityID string) bool {
	if len(cityID) < 6 || len(cityID) > 12 {
		return false
	}
	for _, char := range cityID {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// 序列化后扫描敏感值；命中改发 INTERNAL，绝不下发原响应。
// 序列化只做一次，扫描通过后直接写字节。
func writeScanned(w http.ResponseWriter, payload any, allowList *config.AllowList, scope string) {
	body, err := json.Marshal(payload)
	if err != nil {
		// 序列化失败说明结构自身有误，按需要拦截处理
		logSecretHit(scope)
		httpapi.Internal(msgInternal).Write(w)
		return
	}
	if config.JSONContainsAnySecret(body, config.CollectSensitiveValues(allowList)) {
		logSecretHit(scope)
		httpapi.Internal(msgInternal).Write(w)
		return
	}
	httpapi.WriteJSONBytes(w, http.StatusOK, body)
}

// 序列化后的响应是否含允许列表中的任一敏感值；空列表直接放行。
func containsSecret(payload any, allowList *config.AllowList) bool {
	secrets := config.CollectSensitiveValues(allowList)
	if len(secrets) == 0 {
		return false
	}
	body, err := json.Marshal(payload)
	if err != nil {
		// 序列化失败说明结构自身有误，按需要拦截处理
		return true
	}
	return config.JSONContainsAnySecret(body, secrets)
}

// 记录一条不含敏感内容的拒绝日志。
func logSecretHit(scope string) {
	log.Printf("%s 响应疑似包含敏感值，已拒绝下发", scope)
}

