package config

import (
	"math"
	"strconv"
	"strings"
)

// 可编辑视图与前端 EditableConfig 契约一一对应。
// 投影来源是快照里的原始解析树，展示值保留 YAML 原始写法；密钥字段只给状态。

// 密钥字段状态取值，与前端契约一致。
const (
	SecretStatusConfigured = "configured"
	SecretStatusUnset      = "unset"
)

// 连接串含 URI userinfo 时拒绝投影的固定文案。
const dockerConnectionSensitiveMessage = "Docker 连接串不得包含用户名或密码等内嵌凭据，请改用环境变量或安全的服务端配置方式"

// 密钥字段视图：只说是否已配置，任何情况下都不含明文。
type SecretFieldView struct {
	Status string `json:"status"`
}

// 布局分组，按 YAML 声明顺序输出。
type EditableLayoutEntry struct {
	GroupName  string `json:"groupName"`
	MaxColumns int    `json:"maxColumns"`
}

// 设置段的可编辑视图。
type EditableSettings struct {
	Title           string                `json:"title"`
	Background      *string               `json:"background,omitempty"`
	Favicon         *string               `json:"favicon,omitempty"`
	UseEqualHeights bool                  `json:"useEqualHeights"`
	Layout          []EditableLayoutEntry `json:"layout"`
}

// 探测开关，原始树里未声明的取值不输出。
type EditableHTTPProbe struct {
	Enabled        bool    `json:"enabled"`
	URL            *string `json:"url,omitempty"`
	ExpectedStatus *string `json:"expectedStatus,omitempty"`
	TimeoutSec     *int    `json:"timeoutSec,omitempty"`
}

// customapi 的取值映射，字段原样保留。
type EditableMapping struct {
	Field  *string `json:"field,omitempty"`
	Label  *string `json:"label,omitempty"`
	Format *string `json:"format,omitempty"`
	Path   *string `json:"path,omitempty"`
	ID     *string `json:"id,omitempty"`
}

// customapi 请求头，值同样是密钥视图。
type EditableHeader struct {
	Name  string          `json:"name"`
	Value SecretFieldView `json:"value"`
}

// 服务组件的可编辑视图；密钥字段只出现在原始树声明过的时候。
type EditableServiceWidgetView struct {
	Type              string            `json:"type"`
	URL               *string           `json:"url,omitempty"`
	Username          *SecretFieldView  `json:"username,omitempty"`
	Password          *SecretFieldView  `json:"password,omitempty"`
	Key               *SecretFieldView  `json:"key,omitempty"`
	APIKey            *SecretFieldView  `json:"apiKey,omitempty"`
	Token             *SecretFieldView  `json:"token,omitempty"`
	Method            string            `json:"method,omitempty"`
	Headers           []EditableHeader  `json:"headers,omitempty"`
	Mappings          []EditableMapping `json:"mappings,omitempty"`
	EnableBlocks      *bool             `json:"enableBlocks,omitempty"`
	EnableNowPlaying  *bool             `json:"enableNowPlaying,omitempty"`
	EnableUser        *bool             `json:"enableUser,omitempty"`
	ShowEpisodeNumber *bool             `json:"showEpisodeNumber,omitempty"`
	Fields            []string          `json:"fields,omitempty"`
	Version           *int              `json:"version,omitempty"`
}

// 服务卡片上的容器引用。
type EditableServiceDocker struct {
	Server    string `json:"server"`
	Container string `json:"container"`
}

// 服务条目的可编辑视图；隐藏条目同样投影，供编辑器修改。
type EditableServiceItemView struct {
	Name        string                     `json:"name"`
	Href        *string                    `json:"href,omitempty"`
	Target      *string                    `json:"target,omitempty"`
	Icon        *string                    `json:"icon,omitempty"`
	Description *string                    `json:"description,omitempty"`
	Hidden      *bool                      `json:"hidden,omitempty"`
	HTTPProbe   *EditableHTTPProbe         `json:"httpProbe,omitempty"`
	Docker      *EditableServiceDocker     `json:"docker,omitempty"`
	Widget      *EditableServiceWidgetView `json:"widget,omitempty"`
}

// 服务分组。
type EditableServiceGroupView struct {
	Name  string                    `json:"name"`
	Items []EditableServiceItemView `json:"items"`
}

// 书签条目，链接保留原始写法。
type EditableBookmarkItem struct {
	Name        string  `json:"name"`
	Href        string  `json:"href"`
	Target      *string `json:"target,omitempty"`
	Icon        *string `json:"icon,omitempty"`
	Abbr        *string `json:"abbr,omitempty"`
	Description *string `json:"description,omitempty"`
}

// 书签分组。
type EditableBookmarkGroup struct {
	Name  string                 `json:"name"`
	Items []EditableBookmarkItem `json:"items"`
}

// 时间组件的显示格式。
type EditableDatetimeFormat struct {
	TimeStyle *string `json:"timeStyle,omitempty"`
	DateStyle *string `json:"dateStyle,omitempty"`
	Hour12    *bool   `json:"hour12,omitempty"`
}

// 资源组件的磁盘条目，路径与别名都保留原始写法。
type EditableDiskEntry struct {
	Path  string  `json:"path"`
	Label *string `json:"label,omitempty"`
}

// 信息组件的可编辑视图，按 type 只填充对应字段。
type EditableInfoWidget struct {
	Type     string                  `json:"type"`
	Timezone *string                 `json:"timezone,omitempty"`
	Label    *string                 `json:"label,omitempty"`
	Format   *EditableDatetimeFormat `json:"format,omitempty"`
	CityID   *string                 `json:"cityId,omitempty"`
	Location *string                 `json:"location,omitempty"`
	CPU      *bool                   `json:"cpu,omitempty"`
	Memory   *bool                   `json:"memory,omitempty"`
	Disk     any                     `json:"disk,omitempty"`
}

// docker.yaml 中一条端点声明。
type EditableDockerEndpoint struct {
	Name       string `json:"name"`
	Connection string `json:"connection"`
}

// 可编辑视图的响应体，字段名与前端契约一致。
type EditableConfig struct {
	Settings        EditableSettings           `json:"settings"`
	Services        []EditableServiceGroupView `json:"services"`
	Bookmarks       []EditableBookmarkGroup    `json:"bookmarks"`
	InfoWidgets     []EditableInfoWidget       `json:"infoWidgets"`
	DockerEndpoints []EditableDockerEndpoint   `json:"dockerEndpoints"`
}

// 原始配置无法安全投影时的错误；Message 可直接外露。
// Code 为空按配置无效处理，非空时取契约里的错误码。
type EditableConfigError struct {
	Message string
	Code    string
	File    string
	Path    string
}

func (e *EditableConfigError) Error() string { return e.Message }

// 把快照里的原始解析树投影为可编辑视图，密钥只输出状态。
// docker 连接串含内嵌凭据时返回错误，调用方不得回显原始值。
func BuildEditableConfig(snapshot *Snapshot) (EditableConfig, error) {
	raw := map[string]any{}
	if snapshot != nil && snapshot.Raw != nil {
		raw = snapshot.Raw
	}

	dockerEndpoints, err := buildEditableDockerEndpoints(raw[FileDocker])
	if err != nil {
		return EditableConfig{}, err
	}

	return EditableConfig{
		Settings:        buildEditableSettings(raw[FileSettings]),
		Services:        buildEditableServices(raw[FileServices]),
		Bookmarks:       buildEditableBookmarks(raw[FileBookmarks]),
		InfoWidgets:     buildEditableInfoWidgets(raw[FileWidgets]),
		DockerEndpoints: dockerEndpoints,
	}, nil
}

// 设置段；原始文档不是映射时退回空标题与空布局。
func buildEditableSettings(raw any) EditableSettings {
	doc, ok := asMapOK(raw)
	if !ok {
		return EditableSettings{Layout: []EditableLayoutEntry{}}
	}

	settings := EditableSettings{
		Title:           stringValue(doc["title"]),
		UseEqualHeights: doc["useEqualHeights"] == true,
		Layout:          []EditableLayoutEntry{},
	}
	if background := backgroundURL(doc["background"]); background != "" {
		settings.Background = &background
	}
	if favicon := nonEmptyString(doc["favicon"]); favicon != "" {
		settings.Favicon = &favicon
	}
	settings.Layout = editableLayout(doc["layout"])
	return settings
}

// 布局分组按声明顺序输出，列数只接受不小于 1 的整数。
func editableLayout(raw any) []EditableLayoutEntry {
	entries := []EditableLayoutEntry{}
	layout := asMap(raw)
	for _, key := range mapKeysInOrder(raw) {
		groupName := strings.TrimSpace(key)
		if groupName == "" {
			continue
		}
		group, ok := asMapOK(layout[key])
		if !ok {
			continue
		}
		columns, ok := asInt(group["columns"])
		if !ok || columns < 1 {
			continue
		}
		entries = append(entries, EditableLayoutEntry{GroupName: groupName, MaxColumns: columns})
	}
	return entries
}

// 服务分组：数组与映射两种顶层形态都接受，空名分组跳过。
func buildEditableServices(raw any) []EditableServiceGroupView {
	groups := []EditableServiceGroupView{}
	for _, group := range editableGroups(raw) {
		items := make([]EditableServiceItemView, 0, len(group.items))
		for _, entry := range group.items {
			item, ok := buildEditableServiceItem(entry)
			if !ok {
				continue
			}
			items = append(items, item)
		}
		groups = append(groups, EditableServiceGroupView{Name: group.name, Items: items})
	}
	return groups
}

// 原始条目不是映射时跳过；名称等展示字段保留原始写法，链接与图标去空白。
func buildEditableServiceItem(raw any) (EditableServiceItemView, bool) {
	doc, ok := asMapOK(raw)
	if !ok {
		return EditableServiceItemView{}, false
	}

	item := EditableServiceItemView{Name: stringValue(doc["name"])}
	if href := nonEmptyString(doc["href"]); href != "" {
		item.Href = &href
	}
	if target, ok := editableTarget(doc["target"]); ok {
		item.Target = &target
	}
	if icon := nonEmptyString(doc["icon"]); icon != "" {
		item.Icon = &icon
	}
	if description, ok := doc["description"].(string); ok {
		item.Description = &description
	}
	if hidden, ok := doc["hidden"].(bool); ok && hidden {
		item.Hidden = &hidden
	}
	if probe := buildEditableHTTPProbe(doc); probe != nil {
		item.HTTPProbe = probe
	}
	server := nonEmptyString(doc["server"])
	container := nonEmptyString(doc["container"])
	if server != "" && container != "" {
		item.Docker = &EditableServiceDocker{Server: server, Container: container}
	}
	if widget := buildEditableWidget(doc); widget != nil {
		item.Widget = widget
	}
	return item, true
}

// 只接受四种安全窗口目标，其余取值不输出。
func editableTarget(raw any) (string, bool) {
	text, ok := raw.(string)
	if !ok {
		return "", false
	}
	target := strings.TrimSpace(text)
	if _, safe := safeTargets[target]; !safe {
		return "", false
	}
	return target, true
}

// 探测项：siteMonitor 缺失、为空或显式为 false 时不输出。
func buildEditableHTTPProbe(doc map[string]any) *EditableHTTPProbe {
	siteMonitor, exists := doc["siteMonitor"]
	if !exists || siteMonitor == nil {
		return nil
	}
	if enabled, ok := siteMonitor.(bool); ok && !enabled {
		return nil
	}

	probe := &EditableHTTPProbe{Enabled: true}
	if url := nonEmptyString(siteMonitor); url != "" {
		probe.URL = &url
	}
	if status, ok := editableExpectedStatus(doc["expectedStatus"]); ok {
		probe.ExpectedStatus = &status
	}
	if timeout, ok := asInt(doc["probeTimeout"]); ok && timeout >= 1 && timeout <= 60 {
		probe.TimeoutSec = &timeout
	}
	return probe
}

// 期望状态原样展示：字符串去空白后非空，数字转十进制文本。
func editableExpectedStatus(raw any) (string, bool) {
	if text, ok := raw.(string); ok {
		trimmed := strings.TrimSpace(text)
		return trimmed, trimmed != ""
	}
	return numberText(raw)
}

// 数字转十进制文本，非有限值不接受。
func numberText(raw any) (string, bool) {
	switch value := raw.(type) {
	case int:
		return strconv.Itoa(value), true
	case int64:
		return strconv.FormatInt(value, 10), true
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return "", false
		}
		return strconv.FormatFloat(value, 'g', -1, 64), true
	default:
		return "", false
	}
}

// 服务组件优先取第一个受支持类型；没有时取第一个带 type 的声明，不支持的类型也让编辑器可见。
func buildEditableWidget(doc map[string]any) *EditableServiceWidgetView {
	declarations := widgetDeclarations(doc)
	if len(declarations) == 0 {
		return nil
	}

	var (
		source     map[string]any
		widgetType string
	)
	if index, supported, found := firstSupportedWidget(declarations); found {
		source = asMap(declarations[index])
		widgetType = supported
	} else {
		for _, entry := range declarations {
			entryDoc, ok := asMapOK(entry)
			if !ok {
				continue
			}
			text, ok := entryDoc["type"].(string)
			if !ok {
				continue
			}
			trimmed := strings.TrimSpace(text)
			if trimmed == "" {
				continue
			}
			source = entryDoc
			widgetType = trimmed
			break
		}
	}
	if source == nil || widgetType == "" {
		return nil
	}

	widget := &EditableServiceWidgetView{Type: widgetType}
	if url := nonEmptyString(source["url"]); url != "" {
		widget.URL = &url
	}

	// 密钥字段只在原始树里声明时才输出状态；空串与非字符串都算未配置
	secretField := func(name string) *SecretFieldView {
		value, exists := source[name]
		if !exists {
			return nil
		}
		secret := secretView(value)
		return &secret
	}
	widget.Username = secretField("username")
	widget.Password = secretField("password")
	widget.Key = secretField("key")
	widget.APIKey = secretField("apiKey")
	widget.Token = secretField("token")

	if method, ok := source["method"].(string); ok && strings.EqualFold(strings.TrimSpace(method), "GET") {
		widget.Method = "GET"
	}

	headerRaw := source["headers"]
	if headers, ok := asMapOK(headerRaw); ok {
		entries := make([]EditableHeader, 0, len(headers))
		for _, name := range mapKeysInOrder(headerRaw) {
			headerName := strings.TrimSpace(name)
			if headerName == "" {
				continue
			}
			entries = append(entries, EditableHeader{Name: headerName, Value: secretView(headers[name])})
		}
		if len(entries) > 0 {
			widget.Headers = entries
		}
	}

	if mappings, ok := source["mappings"].([]any); ok {
		entries := make([]EditableMapping, 0, len(mappings))
		for _, rawMapping := range mappings {
			mapping, ok := asMapOK(rawMapping)
			if !ok {
				continue
			}
			entries = append(entries, EditableMapping{
				Field:  stringPtr(mapping["field"]),
				Label:  stringPtr(mapping["label"]),
				Format: stringPtr(mapping["format"]),
				Path:   stringPtr(mapping["path"]),
				ID:     stringPtr(mapping["id"]),
			})
		}
		if len(entries) > 0 {
			widget.Mappings = entries
		}
	}

	widget.EnableBlocks = boolPtr(source["enableBlocks"])
	widget.EnableNowPlaying = boolPtr(source["enableNowPlaying"])
	widget.EnableUser = boolPtr(source["enableUser"])
	widget.ShowEpisodeNumber = boolPtr(source["showEpisodeNumber"])

	if fields := normalizeWidgetFields(source["fields"]); len(fields) > 0 {
		widget.Fields = fields
	}
	if version, ok := widgetAPIVersion(source["version"]); ok {
		widget.Version = &version
	}
	return widget
}

// Immich 版本只接受 1 与 2，字符串形式须精确匹配。
func widgetAPIVersion(raw any) (int, bool) {
	switch value := raw.(type) {
	case string:
		switch value {
		case "1":
			return 1, true
		case "2":
			return 2, true
		}
	case int:
		if value == 1 || value == 2 {
			return value, true
		}
	case float64:
		if value == 1 || value == 2 {
			return int(value), true
		}
	}
	return 0, false
}

// 书签分组；条目不是映射时跳过，名称与链接保留原始写法。
func buildEditableBookmarks(raw any) []EditableBookmarkGroup {
	groups := []EditableBookmarkGroup{}
	for _, group := range editableGroups(raw) {
		items := make([]EditableBookmarkItem, 0, len(group.items))
		for _, entry := range group.items {
			doc, ok := asMapOK(entry)
			if !ok {
				continue
			}
			item := EditableBookmarkItem{
				Name: stringValue(doc["name"]),
				Href: stringValue(doc["href"]),
			}
			if target, ok := editableTarget(doc["target"]); ok {
				item.Target = &target
			}
			if icon := nonEmptyString(doc["icon"]); icon != "" {
				item.Icon = &icon
			}
			if abbr := nonEmptyString(doc["abbr"]); abbr != "" {
				item.Abbr = &abbr
			}
			if description, ok := doc["description"].(string); ok {
				item.Description = &description
			}
			items = append(items, item)
		}
		groups = append(groups, EditableBookmarkGroup{Name: group.name, Items: items})
	}
	return groups
}

// 信息组件只投影时间、天气、资源三种类型；未知类型留在原始树，不进主字段。
func buildEditableInfoWidgets(raw any) []EditableInfoWidget {
	widgets := []EditableInfoWidget{}
	for _, entry := range infoWidgetEntries(raw) {
		doc := expandInfoWidgetEntry(entry)
		if doc == nil {
			continue
		}
		text, ok := doc["type"].(string)
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(text)) {
		case "datetime":
			widgets = append(widgets, buildEditableDatetime(doc))
		case "openmeteo":
			if widget, ok := buildEditableOpenMeteo(doc); ok {
				widgets = append(widgets, widget)
			}
		case "resources":
			widgets = append(widgets, buildEditableResources(doc))
		}
	}
	return widgets
}

// 时间组件：时区与标签按字符串原样保留，格式只取三种键。
func buildEditableDatetime(doc map[string]any) EditableInfoWidget {
	widget := EditableInfoWidget{Type: "datetime"}
	if timezone, ok := doc["timezone"].(string); ok {
		widget.Timezone = &timezone
	}
	if label, ok := doc["label"].(string); ok {
		widget.Label = &label
	}
	if format, ok := asMapOK(doc["format"]); ok {
		parsed := EditableDatetimeFormat{
			TimeStyle: stringPtr(format["timeStyle"]),
			DateStyle: stringPtr(format["dateStyle"]),
			Hour12:    boolPtr(format["hour12"]),
		}
		if parsed.TimeStyle != nil || parsed.DateStyle != nil || parsed.Hour12 != nil {
			widget.Format = &parsed
		}
	}
	return widget
}

// 天气组件：城市编码剥掉 weathercn: 前缀，地点缺失时回落到标签；两者都缺则跳过。
func buildEditableOpenMeteo(doc map[string]any) (EditableInfoWidget, bool) {
	cityID := editableCityID(doc["cityId"])
	location := strings.TrimSpace(stringValue(doc["location"]))
	if location == "" {
		location = strings.TrimSpace(stringValue(doc["label"]))
	}
	if cityID == "" || location == "" {
		return EditableInfoWidget{}, false
	}

	widget := EditableInfoWidget{Type: "openmeteo", CityID: &cityID, Location: &location}
	if label, ok := doc["label"].(string); ok {
		widget.Label = &label
	}
	return widget, true
}

// 城市编码只做字符串化与前缀剥离，长度与数字校验留给规范化流程。
func editableCityID(raw any) string {
	if text, ok := raw.(string); ok {
		trimmed := strings.TrimSpace(text)
		if len(trimmed) >= len("weathercn:") && strings.EqualFold(trimmed[:len("weathercn:")], "weathercn:") {
			trimmed = trimmed[len("weathercn:"):]
		}
		return trimmed
	}
	switch value := raw.(type) {
	case int:
		return strconv.Itoa(value)
	case int64:
		return strconv.FormatInt(value, 10)
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return ""
		}
		// 与规范化一致，小数部分直接截断
		return strconv.FormatInt(int64(value), 10)
	default:
		return ""
	}
}

// 资源组件：开关缺省不输出，磁盘条目按声明形态保留。
func buildEditableResources(doc map[string]any) EditableInfoWidget {
	widget := EditableInfoWidget{Type: "resources"}
	if cpu, ok := doc["cpu"].(bool); ok {
		widget.CPU = &cpu
	}
	if memory, ok := doc["memory"].(bool); ok {
		widget.Memory = &memory
	}
	if label, ok := doc["label"].(string); ok {
		widget.Label = &label
	}
	widget.Disk = editableDisk(doc)
	return widget
}

// 磁盘字段按 disk、diskPath、diskPaths、disks 的顺序取第一份有效声明。
func editableDisk(doc map[string]any) any {
	if value, exists := doc["disk"]; exists {
		switch typed := value.(type) {
		case string:
			return typed
		case []any:
			if entries := editableDiskEntries(typed); len(entries) > 0 {
				return entries
			}
			return nil
		}
	}
	if text, ok := doc["diskPath"].(string); ok {
		return text
	}
	for _, key := range []string{"diskPaths", "disks"} {
		list, ok := doc[key].([]any)
		if !ok {
			continue
		}
		if entries := editableDiskEntries(list); len(entries) > 0 {
			return entries
		}
		return nil
	}
	return nil
}

// 磁盘条目只保留路径与展示别名。
// 返回值是 []any 而非结构体切片：契约允许数组里混排字符串与 {path,label}。
func editableDiskEntries(list []any) []any {
	entries := make([]any, 0, len(list))
	for _, item := range list {
		if text, ok := item.(string); ok {
			if strings.TrimSpace(text) != "" {
				entries = append(entries, text)
			}
			continue
		}
		doc, ok := asMapOK(item)
		if !ok {
			continue
		}
		path, ok := doc["path"].(string)
		if !ok || strings.TrimSpace(path) == "" {
			continue
		}
		entry := EditableDiskEntry{Path: path}
		if label := firstTrimmedString(doc, "label", "name", "alias"); label != "" {
			entry.Label = &label
		}
		entries = append(entries, entry)
	}
	return entries
}

// 按给定顺序取第一个去空白后非空的字符串。
func firstTrimmedString(doc map[string]any, keys ...string) string {
	for _, key := range keys {
		text, ok := doc[key].(string)
		if !ok {
			continue
		}
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// docker 端点按声明顺序输出；连接串含内嵌凭据时整体失败，绝不回显原串。
func buildEditableDockerEndpoints(raw any) ([]EditableDockerEndpoint, error) {
	endpoints := []EditableDockerEndpoint{}
	doc, ok := asMapOK(raw)
	if !ok {
		return endpoints, nil
	}
	for _, key := range mapKeysInOrder(raw) {
		name := strings.TrimSpace(key)
		if name == "" {
			continue
		}
		connection, ok := doc[key].(string)
		if !ok {
			continue
		}
		if dockerConnectionHasUserInfo(connection) {
			return nil, &EditableConfigError{
				Message: dockerConnectionSensitiveMessage,
				Code:    codeDockerConnectionSensitive,
				File:    FileDocker,
				Path:    "dockerEndpoints." + name,
			}
		}
		endpoints = append(endpoints, EditableDockerEndpoint{Name: name, Connection: connection})
	}
	return endpoints, nil
}

// 检测连接串是否含 URI userinfo；只做结构判断，不解析也不回显原串。
func dockerConnectionHasUserInfo(connection string) bool {
	trimmed := strings.TrimSpace(connection)
	if trimmed == "" {
		return false
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "unix://") {
		return false
	}
	if strings.HasPrefix(lower, "tcp://") {
		return authorityHasUserInfo(trimmed[len("tcp://"):])
	}
	if separator := strings.Index(trimmed, "://"); separator > 0 {
		return authorityHasUserInfo(trimmed[separator+3:])
	}
	return false
}

// userinfo 位于 authority 的 @ 之前，取路径之前的片段判断。
func authorityHasUserInfo(authority string) bool {
	auth := authority
	if slash := strings.Index(authority, "/"); slash >= 0 {
		auth = authority[:slash]
	}
	at := strings.LastIndex(auth, "@")
	if at <= 0 {
		return false
	}
	return auth[:at] != ""
}

// 分组投影的中间态。
type editableGroup struct {
	name  string
	items []any
}

// 分组既接受「名字: 条目数组」映射，也接受每个元素为单键映射的数组；空名与非对象元素跳过。
func editableGroups(raw any) []editableGroup {
	groups := make([]editableGroup, 0)

	appendEntry := func(entry any) {
		doc := asMap(entry)
		for _, key := range mapKeysInOrder(entry) {
			name := strings.TrimSpace(key)
			if name == "" {
				continue
			}
			items := asSlice(doc[key])
			if items == nil {
				items = []any{}
			}
			groups = append(groups, editableGroup{name: name, items: items})
		}
	}

	if list, ok := raw.([]any); ok {
		for _, entry := range list {
			if _, ok := asMapOK(entry); !ok {
				continue
			}
			appendEntry(entry)
		}
		return groups
	}
	if _, ok := asMapOK(raw); ok {
		appendEntry(raw)
	}
	return groups
}

// 密钥是否已配置只看原始值是否为非空字符串，不做去空白。
func secretView(raw any) SecretFieldView {
	if text, ok := raw.(string); ok && text != "" {
		return SecretFieldView{Status: SecretStatusConfigured}
	}
	return SecretFieldView{Status: SecretStatusUnset}
}

// 原样取字符串，非字符串视为空串。
func stringValue(raw any) string {
	text, _ := raw.(string)
	return text
}

// 原样保留字符串值，非字符串返回 nil。
func stringPtr(raw any) *string {
	text, ok := raw.(string)
	if !ok {
		return nil
	}
	return &text
}

// 布尔值原样保留，非布尔返回 nil。
func boolPtr(raw any) *bool {
	value, ok := raw.(bool)
	if !ok {
		return nil
	}
	return &value
}
