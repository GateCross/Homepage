package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/gatecross/homepage/api/internal/domain"
)

// 五份配置文件名，顺序即加载顺序。
const (
	FileSettings  = "settings.yaml"
	FileServices  = "services.yaml"
	FileBookmarks = "bookmarks.yaml"
	FileWidgets   = "widgets.yaml"
	FileDocker    = "docker.yaml"
)

// ConfigFileNames 是全部配置文件名的固定顺序副本。
var ConfigFileNames = []string{FileSettings, FileServices, FileBookmarks, FileWidgets, FileDocker}

// SettingsJSON 是 /api/config 设置段，未知键丢弃。
type SettingsJSON struct {
	Title           string                     `json:"title"`
	Background      *string                    `json:"background,omitempty"`
	Favicon         *string                    `json:"favicon,omitempty"`
	UseEqualHeights bool                       `json:"useEqualHeights"`
	Layout          map[string]LayoutGroupJSON `json:"layout"`
}

// LayoutGroupJSON 是布局分组，仅保留列数。
type LayoutGroupJSON struct {
	MaxColumns int `json:"maxColumns"`
}

// WidgetJSON 是信息组件的浏览器安全视图，密钥与出站目标不进入。
type WidgetJSON struct {
	InfoID      string         `json:"infoId"`
	Type        string         `json:"type"`
	Unsupported *bool          `json:"unsupported,omitempty"`
	Options     map[string]any `json:"options,omitempty"`
}

// ServiceDockerRefJSON 是服务卡片上的容器引用。
type ServiceDockerRefJSON struct {
	Server    string `json:"server"`
	Container string `json:"container"`
}

// ServiceWidgetRefJSON 是服务组件引用；error 非空表示该组件配置有误且未登记。
type ServiceWidgetRefJSON struct {
	Type        string  `json:"type"`
	WidgetID    *string `json:"widgetId,omitempty"`
	Unsupported *bool   `json:"unsupported,omitempty"`
	Error       *string `json:"error,omitempty"`
}

// ServiceHTTPProbeJSON 是服务卡片的探测开关，只带 ID。
type ServiceHTTPProbeJSON struct {
	Enabled bool   `json:"enabled"`
	ProbeID string `json:"probeId"`
}

// ServiceJSON 是服务条目；群组里另有无 name 的错误占位项。
type ServiceJSON struct {
	ID              string                `json:"id"`
	Name            string                `json:"name"`
	Href            *string               `json:"href,omitempty"`
	Target          string                `json:"target"`
	Icon            *string               `json:"icon,omitempty"`
	Description     *string               `json:"description,omitempty"`
	Weight          *float64              `json:"weight,omitempty"`
	HTTPProbe       *ServiceHTTPProbeJSON `json:"httpProbe,omitempty"`
	Docker          *ServiceDockerRefJSON `json:"docker,omitempty"`
	Widget          *ServiceWidgetRefJSON `json:"widget,omitempty"`
	PingUnsupported *bool                 `json:"pingUnsupported,omitempty"`
}

// ServiceItemErrorJSON 是服务条目解析失败时的占位，前端据此渲染错误行。
type ServiceItemErrorJSON struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// ServiceGroupJSON 是服务分组。
type ServiceGroupJSON struct {
	Name  string `json:"name"`
	Items []any  `json:"items"`
}

// BookmarkJSON 是书签条目。
type BookmarkJSON struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Href        string  `json:"href"`
	Target      string  `json:"target"`
	Icon        *string `json:"icon,omitempty"`
	Abbr        *string `json:"abbr,omitempty"`
	Description *string `json:"description,omitempty"`
}

// BookmarkItemErrorJSON 是书签条目解析失败时的占位。
type BookmarkItemErrorJSON struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// BookmarkGroupJSON 是书签分组。
type BookmarkGroupJSON struct {
	Name  string `json:"name"`
	Items []any  `json:"items"`
}

// ConfigJSON 是 /api/config 的成功响应体，不得包含任何密钥或出站目标。
type ConfigJSON struct {
	Settings    SettingsJSON        `json:"settings"`
	Services    []ServiceGroupJSON  `json:"services"`
	Bookmarks   []BookmarkGroupJSON `json:"bookmarks"`
	InfoWidgets []WidgetJSON        `json:"infoWidgets"`
}

// Snapshot 是一次加载的完整产物：浏览器视图、服务端允许列表与原始解析结果。
// Raw 保留五份文件的解析原文，后续切片写回配置时直接复用。
type Snapshot struct {
	Config    ConfigJSON
	AllowList *AllowList
	Raw       map[string]any
}

// Load 读取 configDir 下的五份 YAML 并构建快照。
// 缺失文件按空文档处理；解析或读取失败返回错误，由调用方决定是否保留旧快照。
// 整次五文件解析在读锁内完成，与写回互斥，不会读到替换中的混版。
func Load(dir string) (*Snapshot, error) {
	return withConfigRead(func() (*Snapshot, error) { return loadConfigUnlocked(dir) })
}

// 实际读取：调用方须已持有读锁或写锁。
func loadConfigUnlocked(dir string) (*Snapshot, error) {
	raw := make(map[string]any, len(ConfigFileNames))
	// 规范化用视图：值里的 ${ENV_VAR} 已替换；raw 保留占位符，写回时不落明文
	effective := make(map[string]any, len(ConfigFileNames))
	for _, name := range ConfigFileNames {
		value, err := readYAMLFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		raw[name] = value
		effective[name] = interpolateEnv(value)
	}

	snapshot := &Snapshot{
		AllowList: NewAllowList(),
		Raw:       raw,
		Config: ConfigJSON{
			Settings:    normalizeSettings(effective[FileSettings]),
			Services:    []ServiceGroupJSON{},
			Bookmarks:   []BookmarkGroupJSON{},
			InfoWidgets: []WidgetJSON{},
		},
	}

	// 先登记 docker 端点，服务容器登记依赖已声明端点
	registerDockerEndpoints(effective[FileDocker], snapshot.AllowList)
	snapshot.Config.Services = normalizeServices(effective[FileServices], snapshot.AllowList)
	snapshot.Config.Bookmarks = normalizeBookmarks(effective[FileBookmarks])
	snapshot.Config.InfoWidgets = normalizeInfoWidgets(effective[FileWidgets], snapshot.AllowList)

	return snapshot, nil
}

// 读单份 YAML；文件不存在视为空文档，其余读取错误原样上抛。
func readYAMLFile(path string) (any, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return decodeYAML(content)
}

// 解析 YAML 文本；空文档返回 nil。返回值保留 ${ENV_VAR} 原样。
func decodeYAML(content []byte) (any, error) {
	if strings.TrimSpace(string(content)) == "" {
		return nil, nil
	}
	var root yaml.Node
	if err := yaml.Unmarshal(content, &root); err != nil {
		return nil, err
	}
	return nodeToValue(&root)
}

// 把 YAML 语法树转成普通值；映射保留键声明顺序，分组索引与稳定 ID 依赖该顺序。
func nodeToValue(node *yaml.Node) (any, error) {
	switch node.Kind {
	case yaml.DocumentNode:
		if len(node.Content) == 0 {
			return nil, nil
		}
		return nodeToValue(node.Content[0])

	case yaml.AliasNode:
		return nodeToValue(node.Alias)

	case yaml.MappingNode:
		mapping := newOrderedMap(len(node.Content) / 2)
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := node.Content[i].Value
			value, err := nodeToValue(node.Content[i+1])
			if err != nil {
				return nil, err
			}
			mapping.set(key, value)
		}
		return mapping, nil

	case yaml.SequenceNode:
		items := make([]any, 0, len(node.Content))
		for _, item := range node.Content {
			value, err := nodeToValue(item)
			if err != nil {
				return nil, err
			}
			items = append(items, value)
		}
		return items, nil

	default:
		var value any
		if err := node.Decode(&value); err != nil {
			return nil, err
		}
		return value, nil
	}
}

// 深度遍历并把整值 ${ENV_VAR} 替换为环境变量值，返回新值而不改动原文档；
// 变量缺失时保留原样，由使用方决定是否报错。
func interpolateEnv(node any) any {
	switch value := node.(type) {
	case string:
		if name, isPlaceholder := envPlaceholderName(value); isPlaceholder {
			if resolved, ok := os.LookupEnv(name); ok {
				return resolved
			}
		}
		return value
	case *orderedMap:
		copied := newOrderedMap(len(value.keys))
		for _, key := range value.keys {
			copied.set(key, interpolateEnv(value.values[key]))
		}
		return copied
	case []any:
		copied := make([]any, len(value))
		for i, item := range value {
			copied[i] = interpolateEnv(item)
		}
		return copied
	default:
		return node
	}
}

// 顶层映射的 docker 文档；键为端点名，值为连接串。
func registerDockerEndpoints(raw any, allowList *AllowList) {
	doc := asMap(raw)
	for name, value := range doc {
		endpointName := strings.TrimSpace(name)
		if endpointName == "" {
			continue
		}
		text, ok := value.(string)
		if !ok {
			continue
		}
		endpoint, ok := ParseDockerEndpoint(text)
		if !ok {
			continue
		}
		allowList.DockerEndpoints[endpointName] = endpoint
	}
}

// 设置段只保留标题、背景、图标与等高开关，其它键安全忽略。
func normalizeSettings(raw any) SettingsJSON {
	doc := asMap(raw)
	const defaultTitle = "首页"

	settings := SettingsJSON{
		Title:           defaultTitle,
		UseEqualHeights: doc["useEqualHeights"] == true,
		Layout:          map[string]LayoutGroupJSON{},
	}
	if title := nonEmptyString(doc["title"]); title != "" {
		settings.Title = title
	}
	if background := backgroundURL(doc["background"]); background != "" {
		settings.Background = &background
	}
	if favicon := nonEmptyString(doc["favicon"]); favicon != "" {
		settings.Favicon = &favicon
	}

	layout := asMap(doc["layout"])
	for _, name := range mapKeysInOrder(doc["layout"]) {
		groupName := strings.TrimSpace(name)
		if groupName == "" {
			continue
		}
		columns, ok := asInt(asMap(layout[name])["columns"])
		if !ok || columns < 1 {
			continue
		}
		settings.Layout[groupName] = LayoutGroupJSON{MaxColumns: columns}
	}

	return settings
}

// 背景既接受字符串，也接受 {image: ...} 形式。
func backgroundURL(raw any) string {
	if text := nonEmptyString(raw); text != "" {
		return text
	}
	return nonEmptyString(asMap(raw)["image"])
}

// 服务分组顺序按 YAML 声明顺序；分组名去空白后为空则丢弃。
func normalizeServices(raw any, allowList *AllowList) []ServiceGroupJSON {
	groups := []ServiceGroupJSON{}
	groupIndex := 0

	for _, entry := range groupEntries(raw) {
		// 空名分组仍占用一个序号，稳定 ID 的分组索引据此对齐
		index := groupIndex
		groupIndex++
		if entry.name == "" {
			continue
		}
		groups = append(groups, ServiceGroupJSON{
			Name:  entry.name,
			Items: normalizeServiceItems(entry.items, index, allowList),
		})
	}
	return groups
}

// 条目按 weight 降序稳定排序，weight 大的在前；hidden 条目跳过，不进入公开视图也不登记授权。
func normalizeServiceItems(raw any, groupIndex int, allowList *AllowList) []any {
	list, ok := raw.([]any)
	if !ok {
		return []any{}
	}

	items := make([]any, 0, len(list))
	weights := make([]*float64, 0, len(list))
	for serviceIndex, entry := range list {
		if entryMap := asMap(entry); entryMap["hidden"] == true {
			continue
		}
		item := normalizeServiceItem(entry, groupIndex, serviceIndex, allowList)
		items = append(items, item)
		weights = append(weights, serviceWeight(item))
	}

	return sortByWeight(items, weights)
}

// 单个服务条目：名称无效时返回错误占位；其余字段能取到才写入。
func normalizeServiceItem(raw any, groupIndex, serviceIndex int, allowList *AllowList) any {
	doc, isMap := asMapOK(raw)
	if !isMap {
		return ServiceItemErrorJSON{Kind: "error", Message: "服务条目格式无效，须为包含 name 等字段的对象"}
	}

	name := nonEmptyString(doc["name"])
	if name == "" {
		return ServiceItemErrorJSON{Kind: "error", Message: "服务名称无效或为空"}
	}

	hrefRaw, _ := doc["href"].(string)
	service := ServiceJSON{
		ID:     domain.ServiceID(groupIndex, serviceIndex, hrefRaw),
		Name:   name,
		Target: normalizeTarget(doc["target"]),
	}
	if href := normalizeHref(hrefRaw); href != "" {
		service.Href = &href
	}
	if icon := nonEmptyString(doc["icon"]); icon != "" {
		service.Icon = &icon
	}
	if description := nonEmptyString(doc["description"]); description != "" {
		service.Description = &description
	}
	if weight, ok := asFloat(doc["weight"]); ok {
		service.Weight = &weight
	}
	if _, exists := doc["ping"]; exists {
		unsupported := true
		service.PingUnsupported = &unsupported
	}

	if probeURL := resolveProbeURL(doc["siteMonitor"], service.Href); probeURL != "" {
		probe := &ServiceHTTPProbeJSON{Enabled: true}
		probe.ProbeID = domain.ProbeID(groupIndex, serviceIndex, probeURL)
		target := HTTPProbeTarget{URL: probeURL, TimeoutMs: normalizeProbeTimeoutMs(doc["probeTimeout"])}
		if ranges := normalizeExpectedStatus(doc["expectedStatus"]); len(ranges) > 0 {
			target.ExpectedStatus = ranges
		}
		allowList.HTTPProbeTargets[probe.ProbeID] = target
		service.HTTPProbe = probe
	}

	if server, container, ok := registeredDockerRef(doc, allowList); ok {
		service.Docker = &ServiceDockerRefJSON{Server: server, Container: container}
	}

	if widget := normalizeServiceWidget(doc, groupIndex, serviceIndex, allowList); widget != nil {
		service.Widget = widget
	}

	return service
}

// 探测目标：siteMonitor 为字符串时按其 URL，为 true 时回落到规范化 href。
func resolveProbeURL(siteMonitor any, normalizedHref *string) string {
	if text, ok := siteMonitor.(string); ok {
		return normalizeHref(text)
	}
	if siteMonitor == true && normalizedHref != nil {
		return *normalizedHref
	}
	return ""
}

// 探测超时以秒声明，1–60 之间有效，其余取默认 10 秒。
func normalizeProbeTimeoutMs(raw any) int {
	const defaultTimeoutMs = 10_000
	seconds, ok := asInt(raw)
	if !ok || seconds < 1 || seconds > 60 {
		return defaultTimeoutMs
	}
	return seconds * 1000
}

// expectedStatus 接受单个值或数组：三位状态码、`200-299` 区间串或 {min,max}/{from,to} 对象。
func normalizeExpectedStatus(raw any) []domain.StatusRange {
	if raw == nil {
		return nil
	}
	items := asSlice(raw)
	if items == nil {
		items = []any{raw}
	}

	ranges := []domain.StatusRange{}
	for _, item := range items {
		if statusRange, ok := parseExpectedStatusItem(item); ok {
			ranges = append(ranges, statusRange)
		}
	}
	return ranges
}

func parseExpectedStatusItem(item any) (domain.StatusRange, bool) {
	switch value := item.(type) {
	case string:
		trimmed := strings.TrimSpace(value)
		if before, after, found := strings.Cut(trimmed, "-"); found {
			min, okMin := parseHTTPCode(before)
			max, okMax := parseHTTPCode(after)
			if okMin && okMax && min <= max {
				return domain.StatusRange{Min: min, Max: max}, true
			}
			return domain.StatusRange{}, false
		}
		code, ok := parseHTTPCode(trimmed)
		if !ok {
			return domain.StatusRange{}, false
		}
		return domain.StatusRange{Min: code, Max: code}, true

	default:
		doc, ok := asMapOK(item)
		if ok {
			// from/min 与 to/max 各自取首个非空值，不跨字段回退
			min, okMin := asInt(pickDefined(doc, "from", "min"))
			max, okMax := asInt(pickDefined(doc, "to", "max"))
			if okMin && okMax && min <= max && validHTTPCode(min) && validHTTPCode(max) {
				return domain.StatusRange{Min: min, Max: max}, true
			}
			return domain.StatusRange{}, false
		}
		// 单个数字状态码；小数按 TS 语义截断
		code, ok := asCode(item)
		if !ok || !validHTTPCode(code) {
			return domain.StatusRange{}, false
		}
		return domain.StatusRange{Min: code, Max: code}, true
	}
}

// 先取主字段，主字段缺失（nil）时才回落到备选字段。
func pickDefined(doc map[string]any, primary, fallback string) any {
	if value, exists := doc[primary]; exists && value != nil {
		return value
	}
	return doc[fallback]
}

// 数字状态码：浮点直接截断，不做四舍五入。
func asCode(raw any) (int, bool) {
	switch value := raw.(type) {
	case int:
		return value, true
	case float64:
		return int(value), true
	default:
		return 0, false
	}
}

func parseHTTPCode(raw string) (int, bool) {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) != 3 {
		return 0, false
	}
	code, err := strconv.Atoi(trimmed)
	if err != nil || !validHTTPCode(code) {
		return 0, false
	}
	return code, true
}

func validHTTPCode(code int) bool {
	return code >= 100 && code <= 599
}

// server+container 都非空且 server 已在 docker.yaml 声明时才登记容器。
func registeredDockerRef(doc map[string]any, allowList *AllowList) (string, string, bool) {
	server := nonEmptyString(doc["server"])
	container := nonEmptyString(doc["container"])
	if server == "" || container == "" {
		return "", "", false
	}
	if _, declared := allowList.DockerEndpoints[server]; !declared {
		return "", "", false
	}
	allowList.DockerContainers[DockerContainerKey(server, container)] = struct{}{}
	return server, container, true
}

// 只取首个受支持组件；未支持类型标记 unsupported，配置有误时给出中文 error。
func normalizeServiceWidget(doc map[string]any, groupIndex, serviceIndex int, allowList *AllowList) *ServiceWidgetRefJSON {
	declarations := widgetDeclarations(doc)
	if len(declarations) == 0 {
		return nil
	}

	widgetIndex, widgetType, found := firstSupportedWidget(declarations)
	if !found {
		if fallback := firstTypedWidget(declarations); fallback != "" {
			unsupported := true
			return &ServiceWidgetRefJSON{Type: fallback, Unsupported: &unsupported}
		}
		unsupported := true
		return &ServiceWidgetRefJSON{Type: "unknown", Unsupported: &unsupported}
	}

	raw := asMap(declarations[widgetIndex])
	targetURL := normalizeHref(nonEmptyString(raw["url"]))
	if targetURL == "" {
		return widgetError(widgetType, "服务组件 url 无效或缺失，须为绝对 http(s) URL")
	}

	secrets, options, errMessage := buildWidgetPayload(widgetType, raw)
	if errMessage != "" {
		return widgetError(widgetType, errMessage)
	}

	widgetID := domain.WidgetID(groupIndex, serviceIndex, widgetIndex, widgetType, targetURL)
	allowList.WidgetTargets[widgetID] = WidgetTarget{
		Type:    widgetType,
		URL:     targetURL,
		Secrets: secrets,
		Options: options,
	}
	return &ServiceWidgetRefJSON{Type: widgetType, WidgetID: &widgetID}
}

func widgetError(widgetType, message string) *ServiceWidgetRefJSON {
	return &ServiceWidgetRefJSON{Type: widgetType, Error: &message}
}

// widgets 数组优先；单个 widget 对象视为只含一个组件。
func widgetDeclarations(doc map[string]any) []any {
	if list, ok := doc["widgets"].([]any); ok {
		return list
	}
	if _, ok := asMapOK(doc["widget"]); ok {
		return []any{doc["widget"]}
	}
	return nil
}

// 受支持组件类型，与前端可渲染的适配器一致。
var supportedWidgetTypes = map[string]struct{}{
	"qbittorrent":  {},
	"transmission": {},
	"emby":         {},
	"customapi":    {},
	"immich":       {},
	"caddy":        {},
}

func firstSupportedWidget(list []any) (int, string, bool) {
	for index, entry := range list {
		widgetType := normalizeTypeToken(nonEmptyString(asMap(entry)["type"]))
		if _, supported := supportedWidgetTypes[widgetType]; supported {
			return index, widgetType, true
		}
	}
	return 0, "", false
}

func firstTypedWidget(list []any) string {
	for _, entry := range list {
		if widgetType := normalizeTypeToken(nonEmptyString(asMap(entry)["type"])); widgetType != "" {
			return widgetType
		}
	}
	return ""
}

// 按类型收集密钥与选项；密钥只进 AllowList，任何一项无法解析即返回中文错误。
func buildWidgetPayload(widgetType string, raw map[string]any) (map[string]string, any, string) {
	switch widgetType {
	case "qbittorrent", "transmission":
		secrets, errMessage := resolveSecretFields(raw, []string{"username", "password"})
		if errMessage != "" {
			return nil, nil, errMessage
		}
		return secrets, map[string]any{}, ""

	case "emby", "immich":
		secrets, errMessage := resolveEmbyLikeSecrets(raw)
		if errMessage != "" {
			return nil, nil, errMessage
		}
		options := map[string]any{}
		if widgetType == "emby" {
			for _, flag := range []string{"enableBlocks", "enableNowPlaying", "enableUser", "showEpisodeNumber"} {
				if enabled, ok := raw[flag].(bool); ok {
					options[flag] = enabled
				}
			}
		} else if version, ok := asInt(raw["version"]); ok && (version == 1 || version == 2) {
			options["version"] = version
		}
		if fields := normalizeWidgetFields(raw["fields"]); len(fields) > 0 {
			options["fields"] = fields
		}
		return secrets, options, ""

	case "caddy":
		options := map[string]any{}
		if fields := normalizeWidgetFields(raw["fields"]); len(fields) > 0 {
			options["fields"] = fields
		}
		return map[string]string{}, options, ""

	default: // customapi
		if message := checkCustomAPIRequest(raw); message != "" {
			return nil, nil, message
		}
		secrets, errMessage := resolveSecretFields(raw, []string{"password", "key", "apiKey", "token", "username"})
		if errMessage != "" {
			return nil, nil, errMessage
		}
		options := map[string]any{"method": "GET"}
		if headers, message := resolveHeaders(raw["headers"]); message != "" {
			return nil, nil, message
		} else if len(headers) > 0 {
			options["headers"] = headers
		}
		if mappings, ok := normalizeMappings(raw["mappings"]); ok {
			options["mappings"] = mappings
		}
		return secrets, options, ""
	}
}

// 首期只允许 GET；未声明视为 GET。
func checkCustomAPIRequest(raw map[string]any) string {
	methodRaw, present := raw["method"]
	if !present || methodRaw == nil {
		return ""
	}
	method, isString := methodRaw.(string)
	if !isString {
		return "customapi 仅支持 GET 方法，method 配置无效"
	}
	trimmed := strings.TrimSpace(method)
	if trimmed == "" || strings.EqualFold(trimmed, "GET") {
		return ""
	}
	return "customapi 首期仅支持 GET，不支持 method=" + trimmed
}

// 请求头的值必须是字符串；空名请求头与空表都不进入选项。
func resolveHeaders(raw any) (map[string]string, string) {
	if raw == nil {
		return nil, ""
	}
	doc, ok := asMapOK(raw)
	if !ok {
		return nil, "customapi 的 headers 必须为对象"
	}

	headers := make(map[string]string, len(doc))
	for name, value := range doc {
		headerName := strings.TrimSpace(name)
		if headerName == "" {
			continue
		}
		if _, isString := value.(string); !isString {
			return nil, "customapi 请求头 " + headerName + " 的值必须为字符串"
		}
		resolved, errMessage := resolveSecretString(value, "请求头 "+headerName)
		if errMessage != "" {
			return nil, errMessage
		}
		headers[headerName] = resolved
	}
	return headers, ""
}

// 映射项只保留已知展示字段，其余键丢弃。
func normalizeMappings(raw any) ([]map[string]any, bool) {
	list, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	mappings := make([]map[string]any, 0, len(list))
	for _, item := range list {
		source, isMap := asMapOK(item)
		if !isMap {
			continue
		}
		entry := make(map[string]any, 5)
		for _, key := range []string{"id", "label", "field", "path", "format"} {
			if text, ok := source[key].(string); ok {
				entry[key] = text
			}
		}
		mappings = append(mappings, entry)
	}
	return mappings, true
}

// fields 只保留去空白后非空的字符串，并统一转小写。
func normalizeWidgetFields(raw any) []string {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	fields := make([]string, 0, len(list))
	for _, item := range list {
		if text := normalizeTypeToken(nonEmptyString(item)); text != "" {
			fields = append(fields, text)
		}
	}
	return fields
}

// 密钥字段的中文名，用于错误文案。
var secretFieldLabels = map[string]string{
	"password": "密码",
	"key":      "密钥",
	"apiKey":   "API 密钥",
	"token":    "令牌",
	"username": "用户名",
}

func secretFieldLabel(field string) string {
	if label, ok := secretFieldLabels[field]; ok {
		return label
	}
	return "凭证字段"
}

// 整值 ${ENV_VAR} 插值：环境变量缺失或为空都视为无法解析。
func resolveSecretString(raw any, fieldLabel string) (string, string) {
	text, ok := raw.(string)
	if !ok {
		return "", fieldLabel + "必须为字符串"
	}
	name, isPlaceholder := envPlaceholderName(text)
	if !isPlaceholder {
		return text, ""
	}
	value, present := os.LookupEnv(name)
	if !present {
		return "", "环境变量 " + name + " 未设置，无法解析" + fieldLabel
	}
	if value == "" {
		return "", "环境变量 " + name + " 为空，无法解析" + fieldLabel
	}
	return value, ""
}

// 密钥三选一：key 优先，其次 apiKey，最后 token；统一写入 key。
func resolveEmbyLikeSecrets(raw map[string]any) (map[string]string, string) {
	for _, field := range []string{"key", "apiKey", "token"} {
		value, present := raw[field]
		if !present || value == nil {
			continue
		}
		resolved, errMessage := resolveSecretString(value, secretFieldLabel(field))
		if errMessage != "" {
			return nil, errMessage
		}
		if resolved == "" {
			continue
		}
		return map[string]string{"key": resolved}, ""
	}
	return map[string]string{}, ""
}

func resolveSecretFields(raw map[string]any, names []string) (map[string]string, string) {
	secrets := make(map[string]string, len(names))
	for _, name := range names {
		value, present := raw[name]
		if !present || value == nil {
			continue
		}
		resolved, errMessage := resolveSecretString(value, secretFieldLabel(name))
		if errMessage != "" {
			return nil, errMessage
		}
		if resolved == "" {
			continue
		}
		secrets[name] = resolved
	}
	return secrets, ""
}

func normalizeBookmarks(raw any) []BookmarkGroupJSON {
	groups := []BookmarkGroupJSON{}
	groupIndex := 0

	for _, entry := range groupEntries(raw) {
		// 空名分组仍占用一个序号，稳定 ID 的分组索引据此对齐
		index := groupIndex
		groupIndex++
		if entry.name == "" {
			continue
		}
		groups = append(groups, BookmarkGroupJSON{
			Name:  entry.name,
			Items: normalizeBookmarkItems(entry.items, index),
		})
	}
	return groups
}

func normalizeBookmarkItems(raw any, groupIndex int) []any {
	list, ok := raw.([]any)
	if !ok {
		return []any{}
	}

	items := make([]any, 0, len(list))
	for itemIndex, entry := range list {
		items = append(items, normalizeBookmarkItem(entry, groupIndex, itemIndex))
	}
	return items
}

// 名称与链接任一无效即返回错误占位；链接不是绝对 http(s) URL 时无法生成稳定 ID。
func normalizeBookmarkItem(raw any, groupIndex, itemIndex int) any {
	doc := asMap(raw)
	name := nonEmptyString(doc["name"])
	if name == "" {
		return BookmarkItemErrorJSON{Kind: "error", Message: "书签名称无效或为空"}
	}

	hrefText, _ := doc["href"].(string)
	href := normalizeHref(hrefText)
	if href == "" {
		return BookmarkItemErrorJSON{Kind: "error", Message: "书签链接无效，须为绝对 HTTP 或 HTTPS URL"}
	}

	bookmark := BookmarkJSON{
		ID:     domain.BookmarkID(groupIndex, itemIndex, href),
		Name:   name,
		Href:   href,
		Target: normalizeTarget(doc["target"]),
	}
	if icon := nonEmptyString(doc["icon"]); icon != "" {
		bookmark.Icon = &icon
	}
	if abbr := nonEmptyString(doc["abbr"]); abbr != "" {
		bookmark.Abbr = &abbr
	}
	if description := nonEmptyString(doc["description"]); description != "" {
		bookmark.Description = &description
	}
	return bookmark
}

// widgets.yaml 既接受条目数组，也接受「类型名: 配置」的映射简写。
func normalizeInfoWidgets(raw any, allowList *AllowList) []WidgetJSON {
	widgets := []WidgetJSON{}
	for entryIndex, entry := range infoWidgetEntries(raw) {
		doc := expandInfoWidgetEntry(entry)
		if doc == nil {
			continue
		}
		infoType := normalizeTypeToken(nonEmptyString(doc["type"]))
		if infoType == "" {
			continue
		}
		widgets = append(widgets, normalizeInfoWidget(doc, entryIndex, infoType, allowList))
	}
	return widgets
}

func infoWidgetEntries(raw any) []any {
	switch raw.(type) {
	case []any:
		return raw.([]any)
	case *orderedMap, map[string]any:
		entries := []any{}
		for _, key := range mapKeysInOrder(raw) {
			value := asMap(raw)[key]
			if inner, ok := asMapOK(value); ok {
				if _, hasType := inner["type"]; hasType {
					entries = append(entries, value)
					continue
				}
				// 映射键作为类型名的简写：`datetime: { timezone: ... }`
				merged := map[string]any{"type": key}
				for itemKey, itemValue := range inner {
					merged[itemKey] = itemValue
				}
				entries = append(entries, merged)
				continue
			}
			if value == nil {
				entries = append(entries, map[string]any{"type": key})
			}
		}
		return entries
	default:
		return nil
	}
}

// 单个条目要么自身带 type，要么是「类型名: 配置」的单键映射。
func expandInfoWidgetEntry(raw any) map[string]any {
	doc, ok := asMapOK(raw)
	if !ok {
		return nil
	}
	if normalizeTypeToken(nonEmptyString(doc["type"])) != "" {
		return doc
	}
	keys := mapKeysInOrder(raw)
	if len(keys) != 1 {
		return nil
	}
	typeKey := keys[0]
	if strings.TrimSpace(typeKey) == "" {
		return nil
	}
	merged := map[string]any{"type": typeKey}
	if innerMap, ok := asMapOK(doc[typeKey]); ok {
		for itemKey, itemValue := range innerMap {
			merged[itemKey] = itemValue
		}
	}
	return merged
}

// 信息组件：目标身份决定 infoId；受支持类型才登记服务端目标。
func normalizeInfoWidget(doc map[string]any, entryIndex int, infoType string, allowList *AllowList) WidgetJSON {
	identity, ok := infoTargetIdentity(infoType, doc)
	if !ok {
		unsupported := true
		return WidgetJSON{
			InfoID:      domain.InfoID(entryIndex, infoType, identity),
			Type:        infoType,
			Unsupported: &unsupported,
		}
	}

	infoID := domain.InfoID(entryIndex, infoType, identity)
	widget := WidgetJSON{InfoID: infoID, Type: infoType}
	options := map[string]any{}

	switch infoType {
	case "datetime":
		timezone := normalizeTimeZone(doc["timezone"])
		format := normalizeDatetimeFormat(doc["format"])
		options["timezone"] = timezone
		options["format"] = format
		allowList.InfoTargets[infoID] = InfoTarget{
			Type:    "datetime",
			Options: map[string]any{"timezone": timezone, "format": format},
		}

	case "openmeteo":
		cityID := normalizeCityID(doc["cityId"])
		location := nonEmptyString(doc["location"])
		if location == "" {
			location = nonEmptyString(doc["label"])
		}
		if cityID != "" && location != "" {
			allowList.InfoTargets[infoID] = InfoTarget{
				Type:    "openmeteo",
				Options: map[string]any{"cityId": cityID, "location": location},
			}
		}
		if location != "" {
			options["location"] = location
		}

	case "resources":
		diskPaths := collectResourceDiskPaths(doc)
		cpu := normalizeBoolFlag(doc["cpu"], true)
		memory := normalizeBoolFlag(doc["memory"], true)
		allowList.InfoTargets[infoID] = InfoTarget{
			Type: "resources",
			Options: map[string]any{
				"diskPaths": diskPaths,
				"cpu":       cpu,
				"memory":    memory,
			},
		}
		options["cpu"] = cpu
		options["memory"] = memory
	}

	if label := nonEmptyString(doc["label"]); label != "" {
		options["label"] = label
	}
	if len(options) > 0 {
		widget.Options = options
	}
	return widget
}

// 目标身份：openmeteo 取原始城市编码，resources 取排序后的磁盘路径，未知类型无身份。
func infoTargetIdentity(infoType string, doc map[string]any) (domain.InfoIdentity, bool) {
	switch infoType {
	case "datetime":
		return domain.InfoIdentity{Kind: "datetime"}, true
	case "openmeteo":
		// 身份用原始 cityId，prefix 与校验只影响目标登记，不影响 ID
		return domain.InfoIdentity{Kind: "openmeteo", CityID: rawCityID(doc["cityId"])}, true
	case "resources":
		return domain.InfoIdentity{Kind: "resources", DiskPaths: collectResourceDiskPaths(doc)}, true
	default:
		return domain.InfoIdentity{Kind: "none"}, false
	}
}

// 身份侧的城市编码只做字符串化：数字截断，其它类型视为空。
func rawCityID(raw any) string {
	switch value := raw.(type) {
	case string:
		return value
	case int:
		return strconv.Itoa(value)
	case float64:
		return strconv.FormatInt(int64(value), 10)
	default:
		return ""
	}
}

// 磁盘路径按 path、diskPath、disks、disk 的顺序收集并去重排序。
func collectResourceDiskPaths(doc map[string]any) []string {
	paths := []string{}
	for _, key := range []string{"diskPaths", "diskPath", "disks", "disk"} {
		paths = append(paths, diskPathsFrom(doc[key])...)
	}
	return sortedUniquePaths(paths)
}

func diskPathsFrom(raw any) []string {
	switch value := raw.(type) {
	case string:
		paths := []string{}
		for _, chunk := range strings.Split(value, ",") {
			for _, part := range strings.Split(chunk, "，") {
				if path := normalizeDiskPath(part); path != "" {
					paths = append(paths, path)
				}
			}
		}
		return paths
	case []any:
		paths := []string{}
		for _, item := range value {
			paths = append(paths, diskPathsFrom(item)...)
		}
		return paths
	default:
		doc, ok := asMapOK(raw)
		if !ok {
			return nil
		}
		for _, field := range []string{"path", "disk", "mount"} {
			if text, ok := doc[field].(string); ok {
				if path := normalizeDiskPath(text); path != "" {
					return []string{path}
				}
			}
		}
		return nil
	}
}

// 「路径|别名」或「路径:别名」取路径侧；Windows 盘符的冒号不拆。
func normalizeDiskPath(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if pipe := strings.Index(trimmed, "|"); pipe > 0 {
		return domain.NormalizeDiskPathIdentity(strings.TrimSpace(trimmed[:pipe]))
	}
	if colon := strings.IndexAny(trimmed, "：:"); colon > 0 {
		left := strings.TrimSpace(trimmed[:colon])
		// 单字母加冒号是 Windows 盘符，不能拆
		if len(left) != 1 {
			return domain.NormalizeDiskPathIdentity(left)
		}
	}
	return domain.NormalizeDiskPathIdentity(trimmed)
}

// 规范化后去重并按字典序排序，与稳定 ID 的路径集合顺序一致。
func sortedUniquePaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	unique := make([]string, 0, len(paths))
	for _, path := range paths {
		if path == "" {
			continue
		}
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}
		unique = append(unique, path)
	}
	sort.Strings(unique)
	return unique
}

// 布尔开关接受 true/false、"true"/"1"/"yes" 与 0/1 数字；其余取默认值。
func normalizeBoolFlag(raw any, fallback bool) bool {
	switch value := raw.(type) {
	case bool:
		return value
	case string:
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "true", "1", "yes":
			return true
		case "false", "0", "no":
			return false
		}
	case int:
		if value == 1 {
			return true
		}
		if value == 0 {
			return false
		}
	}
	return fallback
}

// 时区取 IANA 名称，空值回落 UTC。
func normalizeTimeZone(raw any) string {
	if text := nonEmptyString(raw); text != "" {
		return text
	}
	return "UTC"
}

// 时间格式只保留三种尺寸与 12/24 小时开关。
func normalizeDatetimeFormat(raw any) map[string]any {
	format := map[string]any{}
	doc, ok := asMapOK(raw)
	if !ok {
		return format
	}
	for _, style := range []string{"timeStyle", "dateStyle"} {
		switch value := normalizeTypeToken(nonEmptyString(doc[style])); value {
		case "short", "medium", "long":
			format[style] = value
		}
	}
	if hour12, ok := doc["hour12"].(bool); ok {
		format["hour12"] = hour12
	}
	return format
}

// cityId 允许纯数字或 weathercn: 前缀，长度 6–12 位。
func normalizeCityID(raw any) string {
	text := ""
	switch value := raw.(type) {
	case int:
		text = strconv.Itoa(value)
	case float64:
		// 与 TS 一致，小数部分截断后按整数处理
		text = strconv.FormatInt(int64(value), 10)
	case string:
		text = strings.TrimSpace(value)
		if len(text) >= len("weathercn:") && strings.EqualFold(text[:len("weathercn:")], "weathercn:") {
			text = text[len("weathercn:"):]
		}
	}
	if len(text) < 6 || len(text) > 12 {
		return ""
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return text
}

// 顶层分组：数组形式每个元素是单键映射，映射形式按键声明顺序取分组。
type groupEntry struct {
	name  string
	items any
}

func groupEntries(raw any) []groupEntry {
	switch raw.(type) {
	case []any:
		entries := []groupEntry{}
		for _, item := range raw.([]any) {
			doc := asMap(item)
			for _, name := range mapKeysInOrder(item) {
				entries = append(entries, groupEntry{name: strings.TrimSpace(name), items: doc[name]})
			}
		}
		return entries
	case *orderedMap, map[string]any:
		doc := asMap(raw)
		entries := []groupEntry{}
		for _, name := range mapKeysInOrder(raw) {
			entries = append(entries, groupEntry{name: strings.TrimSpace(name), items: doc[name]})
		}
		return entries
	default:
		return nil
	}
}

// 带 weight 的条目按 weight 降序排在前面，其余保持声明顺序。
func sortByWeight(items []any, weights []*float64) []any {
	indexes := make([]int, len(items))
	for i := range indexes {
		indexes[i] = i
	}
	sort.SliceStable(indexes, func(a, b int) bool {
		left, right := weights[indexes[a]], weights[indexes[b]]
		if left != nil && right != nil {
			return *left > *right
		}
		return left != nil && right == nil
	})

	sorted := make([]any, len(items))
	for position, index := range indexes {
		sorted[position] = items[index]
	}
	return sorted
}

// 只有服务条目带 weight，错误占位与其它类型返回 nil。
func serviceWeight(item any) *float64 {
	service, ok := item.(ServiceJSON)
	if !ok {
		return nil
	}
	return service.Weight
}
