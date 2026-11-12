package config

import (
	"encoding/json"
	"fmt"
	"math"
)

// PUT /api/config 的写回载荷：字段名与前端 EditableConfigWrite 契约逐字对应。
// 与可编辑视图同形，差别只在密钥字段是写回三态而不是状态视图。

// 密钥字段的写回模式。
const (
	SecretModeKeep  = "keep"
	SecretModeSet   = "set"
	SecretModeClear = "clear"
)

// 载荷校验失败的固定中文前缀。
const invalidPayloadPrefix = "写回载荷校验失败："

// 单个密钥字段的写回指令：保留磁盘原值、写入新值或清除。
type SecretFieldWrite struct {
	Mode  string
	Value string
}

// 设置段的写回值；布局以编辑器列表为准重建。
type EditableSettingsWrite struct {
	Title           string
	Background      *string
	Favicon         *string
	UseEqualHeights bool
	Layout          []EditableLayoutEntry
}

// 组件请求头的写回值，值为密钥三态。
type EditableHeaderWrite struct {
	Name  string
	Value SecretFieldWrite
}

// 服务组件的写回值。
type EditableServiceWidgetWrite struct {
	Type              string
	URL               *string
	Username          *SecretFieldWrite
	Password          *SecretFieldWrite
	Key               *SecretFieldWrite
	APIKey            *SecretFieldWrite
	Token             *SecretFieldWrite
	Method            *string
	Headers           *[]EditableHeaderWrite
	Mappings          *[]EditableMapping
	EnableBlocks      *bool
	EnableNowPlaying  *bool
	EnableUser        *bool
	ShowEpisodeNumber *bool
	Fields            []string
	Version           *int
}

// 服务条目的写回值。
type EditableServiceItemWrite struct {
	Name        string
	Href        *string
	Target      *string
	Icon        *string
	Description *string
	Hidden      *bool
	HTTPProbe   *EditableHTTPProbe
	Docker      *EditableServiceDocker
	Widget      *EditableServiceWidgetWrite
}

// 服务分组的写回值。
type EditableServiceGroupWrite struct {
	Name  string
	Items []EditableServiceItemWrite
}

// 书签条目的写回值；链接为必填，保留原始写法。
type EditableBookmarkItemWrite struct {
	Name        string
	Href        string
	Target      *string
	Icon        *string
	Abbr        *string
	Description *string
}

// 书签分组的写回值。
type EditableBookmarkGroupWrite struct {
	Name  string
	Items []EditableBookmarkItemWrite
}

// 资源组件的磁盘声明：单字符串或条目数组。
type EditableDiskField struct {
	IsList bool
	Text   string
	Items  []EditableDiskEntryWrite
}

// 磁盘条目：路径与可选展示别名；别名缺失时序列化为裸字符串。
type EditableDiskEntryWrite struct {
	Path  string
	Label *string
}

// 信息组件的写回值，按 type 只取对应字段。
type EditableInfoWidgetWrite struct {
	Type     string
	Timezone *string
	Label    *string
	Format   *EditableDatetimeFormat
	CityID   *string
	Location *string
	CPU      *bool
	Memory   *bool
	Disk     *EditableDiskField
}

// 整份写回载荷。
type EditableConfigWrite struct {
	Settings        EditableSettingsWrite
	Services        []EditableServiceGroupWrite
	Bookmarks       []EditableBookmarkGroupWrite
	InfoWidgets     []EditableInfoWidgetWrite
	DockerEndpoints []EditableDockerEndpoint
}

// 载荷里的对象读取器：路径自动拼接，缺字段与类型不符都产出带路径的中文错误。
type payloadReader struct {
	doc  map[string]any
	path string
}

func newPayloadReader(value any, path string) (*payloadReader, *EditableConfigError) {
	doc, ok := value.(map[string]any)
	if !ok {
		return nil, invalidPayload(path, "必须为对象")
	}
	return &payloadReader{doc: doc, path: path}, nil
}

// 子字段路径；根对象下的字段不带前导点。
func (r *payloadReader) fieldPath(key string) string {
	if r.path == "" {
		return key
	}
	return r.path + "." + key
}

// 布尔字段；缺省是否允许由 required 决定，显式 null 一律按类型不符处理。
func (r *payloadReader) boolField(key string, required bool) (*bool, *EditableConfigError) {
	value, exists := r.doc[key]
	if !exists {
		if required {
			return nil, invalidPayload(r.fieldPath(key), "为必填项")
		}
		return nil, nil
	}
	flag, ok := value.(bool)
	if !ok {
		return nil, invalidPayload(r.fieldPath(key), "必须为布尔值")
	}
	return &flag, nil
}

// 字符串字段；缺省返回 nil，显式 null 按类型不符处理。
func (r *payloadReader) stringField(key string, required bool) (*string, *EditableConfigError) {
	value, exists := r.doc[key]
	if !exists {
		if required {
			return nil, invalidPayload(r.fieldPath(key), "为必填项")
		}
		return nil, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, invalidPayload(r.fieldPath(key), "必须为字符串")
	}
	return &text, nil
}

// 非空字符串字段；是否为空只看原始长度，不做去空白。
func (r *payloadReader) nonEmptyStringField(key string, required bool) (*string, *EditableConfigError) {
	text, err := r.stringField(key, required)
	if err != nil || text == nil {
		return text, err
	}
	if len(*text) == 0 {
		return nil, invalidPayload(r.fieldPath(key), "不能为空")
	}
	return text, nil
}

// 对象字段；required 为 true 时缺失即报错。
func (r *payloadReader) objectField(key string, required bool) (*payloadReader, *EditableConfigError) {
	value, exists := r.doc[key]
	if !exists {
		if required {
			return nil, invalidPayload(r.fieldPath(key), "为必填项")
		}
		return nil, nil
	}
	return newPayloadReader(value, r.fieldPath(key))
}

// 数组字段；第二个返回值表示键是否出现，显式 null 按类型不符处理。
func (r *payloadReader) arrayField(key string) ([]any, bool, *EditableConfigError) {
	value, exists := r.doc[key]
	if !exists {
		return nil, false, nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil, true, invalidPayload(r.fieldPath(key), "必须为数组")
	}
	return list, true, nil
}

// 整数字段：接受 JSON 整数与小数部分为零的写法，其余按整数不符处理。
func (r *payloadReader) intField(key string, required bool) (*int, *EditableConfigError) {
	value, exists := r.doc[key]
	if !exists {
		if required {
			return nil, invalidPayload(r.fieldPath(key), "为必填项")
		}
		return nil, nil
	}
	parsed, ok := jsonInteger(value)
	if !ok {
		return nil, invalidPayload(r.fieldPath(key), "必须为整数")
	}
	return &parsed, nil
}

// 密钥字段：缺省返回 nil，出现时必须是合法的三态指令。
func (r *payloadReader) secretField(key string) (*SecretFieldWrite, *EditableConfigError) {
	value, exists := r.doc[key]
	if !exists {
		return nil, nil
	}
	return parseSecretField(value, r.fieldPath(key))
}

// JSON 数字转整数：只接受精确落在整数范围内的写法。
func jsonInteger(value any) (int, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	if parsed, err := number.Int64(); err == nil {
		return int(parsed), true
	}
	asFloat, err := number.Float64()
	if err != nil || math.IsNaN(asFloat) || math.IsInf(asFloat, 0) || asFloat != math.Trunc(asFloat) {
		return 0, false
	}
	if asFloat < math.MinInt64 || asFloat > math.MaxInt64 {
		return 0, false
	}
	return int(asFloat), true
}

// 载荷结构错误：文案带字段路径，交给 CONFIG_INVALID 下发。
func invalidPayload(path, detail string) *EditableConfigError {
	return &EditableConfigError{Message: invalidPayloadPrefix + detail, Path: path}
}

// 解析写回载荷：逐段校验类型与必填项，并拒绝含内嵌凭据的 Docker 连接串。
// 未出现在契约里的键一律忽略，因此 allowList、secrets、resolved* 等旁路字段不会生效。
func ParseEditableConfigWrite(body any) (EditableConfigWrite, error) {
	root, ok := body.(map[string]any)
	if !ok {
		return EditableConfigWrite{}, &EditableConfigError{Message: "写回载荷必须为对象", Path: "$"}
	}
	reader := &payloadReader{doc: root}

	settings, err := decodeSettings(reader)
	if err != nil {
		return EditableConfigWrite{}, err
	}
	services, err := decodeServiceGroups(reader)
	if err != nil {
		return EditableConfigWrite{}, err
	}
	bookmarks, err := decodeBookmarkGroups(reader)
	if err != nil {
		return EditableConfigWrite{}, err
	}
	infoWidgets, err := decodeInfoWidgets(reader)
	if err != nil {
		return EditableConfigWrite{}, err
	}
	dockerEndpoints, err := decodeDockerEndpoints(reader)
	if err != nil {
		return EditableConfigWrite{}, err
	}

	// 连接串校验放在结构校验之后，与 TS 侧解析完成后再检查的顺序一致
	for index, endpoint := range dockerEndpoints {
		if !dockerConnectionHasUserInfo(endpoint.Connection) {
			continue
		}
		return EditableConfigWrite{}, &EditableConfigError{
			Message: dockerConnectionSensitiveMessage,
			Code:    codeDockerConnectionSensitive,
			File:    FileDocker,
			Path:    fmt.Sprintf("dockerEndpoints.%d.connection", index),
		}
	}

	return EditableConfigWrite{
		Settings:        settings,
		Services:        services,
		Bookmarks:       bookmarks,
		InfoWidgets:     infoWidgets,
		DockerEndpoints: dockerEndpoints,
	}, nil
}

func decodeSettings(reader *payloadReader) (EditableSettingsWrite, *EditableConfigError) {
	settingsReader, err := reader.objectField("settings", true)
	if err != nil {
		return EditableSettingsWrite{}, err
	}
	title, err := settingsReader.stringField("title", true)
	if err != nil {
		return EditableSettingsWrite{}, err
	}
	background, err := settingsReader.stringField("background", false)
	if err != nil {
		return EditableSettingsWrite{}, err
	}
	favicon, err := settingsReader.stringField("favicon", false)
	if err != nil {
		return EditableSettingsWrite{}, err
	}
	useEqualHeights, err := settingsReader.boolField("useEqualHeights", true)
	if err != nil {
		return EditableSettingsWrite{}, err
	}

	layoutItems, present, err := settingsReader.arrayField("layout")
	if err != nil {
		return EditableSettingsWrite{}, err
	}
	if !present {
		return EditableSettingsWrite{}, invalidPayload(settingsReader.fieldPath("layout"), "为必填项")
	}
	layout := make([]EditableLayoutEntry, 0, len(layoutItems))
	for index, item := range layoutItems {
		entryReader, entryErr := newPayloadReader(item, fmt.Sprintf("%s.%d", settingsReader.fieldPath("layout"), index))
		if entryErr != nil {
			return EditableSettingsWrite{}, entryErr
		}
		groupName, entryErr := entryReader.stringField("groupName", true)
		if entryErr != nil {
			return EditableSettingsWrite{}, entryErr
		}
		maxColumns, entryErr := entryReader.intField("maxColumns", true)
		if entryErr != nil {
			return EditableSettingsWrite{}, entryErr
		}
		if *maxColumns < 1 {
			return EditableSettingsWrite{}, invalidPayload(entryReader.fieldPath("maxColumns"), "必须为正整数")
		}
		layout = append(layout, EditableLayoutEntry{GroupName: *groupName, MaxColumns: *maxColumns})
	}

	return EditableSettingsWrite{
		Title:           *title,
		Background:      background,
		Favicon:         favicon,
		UseEqualHeights: *useEqualHeights,
		Layout:          layout,
	}, nil
}

func decodeServiceGroups(reader *payloadReader) ([]EditableServiceGroupWrite, *EditableConfigError) {
	items, present, err := reader.arrayField("services")
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, invalidPayload(reader.fieldPath("services"), "为必填项")
	}

	groups := make([]EditableServiceGroupWrite, 0, len(items))
	for index, item := range items {
		groupPath := fmt.Sprintf("services.%d", index)
		groupReader, groupErr := newPayloadReader(item, groupPath)
		if groupErr != nil {
			return nil, groupErr
		}
		name, groupErr := groupReader.stringField("name", true)
		if groupErr != nil {
			return nil, groupErr
		}
		groupItems, itemsPresent, groupErr := groupReader.arrayField("items")
		if groupErr != nil {
			return nil, groupErr
		}
		if !itemsPresent {
			return nil, invalidPayload(groupReader.fieldPath("items"), "为必填项")
		}

		services := make([]EditableServiceItemWrite, 0, len(groupItems))
		for itemIndex, rawItem := range groupItems {
			service, serviceErr := decodeServiceItem(rawItem, fmt.Sprintf("%s.items.%d", groupPath, itemIndex))
			if serviceErr != nil {
				return nil, serviceErr
			}
			services = append(services, service)
		}
		groups = append(groups, EditableServiceGroupWrite{Name: *name, Items: services})
	}
	return groups, nil
}

func decodeServiceItem(raw any, path string) (EditableServiceItemWrite, *EditableConfigError) {
	reader, err := newPayloadReader(raw, path)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	name, err := reader.stringField("name", true)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	href, err := reader.stringField("href", false)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	target, err := decodeLinkTarget(reader)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	icon, err := reader.stringField("icon", false)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	description, err := reader.stringField("description", false)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	hidden, err := reader.boolField("hidden", false)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	probe, err := decodeHTTPProbe(reader)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	docker, err := decodeServiceDocker(reader)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}
	widget, err := decodeServiceWidget(reader)
	if err != nil {
		return EditableServiceItemWrite{}, err
	}

	return EditableServiceItemWrite{
		Name:        *name,
		Href:        href,
		Target:      target,
		Icon:        icon,
		Description: description,
		Hidden:      hidden,
		HTTPProbe:   probe,
		Docker:      docker,
		Widget:      widget,
	}, nil
}

// 窗口目标只接受契约里的四个安全值。
func decodeLinkTarget(reader *payloadReader) (*string, *EditableConfigError) {
	target, err := reader.stringField("target", false)
	if err != nil || target == nil {
		return target, err
	}
	if _, safe := safeTargets[*target]; !safe {
		return nil, invalidPayload(reader.fieldPath("target"), "只能为 _blank、_self、_parent 或 _top")
	}
	return target, nil
}

func decodeHTTPProbe(reader *payloadReader) (*EditableHTTPProbe, *EditableConfigError) {
	probeReader, err := reader.objectField("httpProbe", false)
	if err != nil || probeReader == nil {
		return nil, err
	}
	enabled, err := probeReader.boolField("enabled", true)
	if err != nil {
		return nil, err
	}
	url, err := probeReader.stringField("url", false)
	if err != nil {
		return nil, err
	}
	expectedStatus, err := probeReader.stringField("expectedStatus", false)
	if err != nil {
		return nil, err
	}
	timeoutSec, err := probeReader.intField("timeoutSec", false)
	if err != nil {
		return nil, err
	}
	if timeoutSec != nil && (*timeoutSec < 1 || *timeoutSec > 60) {
		return nil, invalidPayload(probeReader.fieldPath("timeoutSec"), "必须在 1 到 60 之间")
	}
	return &EditableHTTPProbe{
		Enabled:        *enabled,
		URL:            url,
		ExpectedStatus: expectedStatus,
		TimeoutSec:     timeoutSec,
	}, nil
}

func decodeServiceDocker(reader *payloadReader) (*EditableServiceDocker, *EditableConfigError) {
	dockerReader, err := reader.objectField("docker", false)
	if err != nil || dockerReader == nil {
		return nil, err
	}
	server, err := dockerReader.nonEmptyStringField("server", true)
	if err != nil {
		return nil, err
	}
	container, err := dockerReader.nonEmptyStringField("container", true)
	if err != nil {
		return nil, err
	}
	return &EditableServiceDocker{Server: *server, Container: *container}, nil
}

func decodeServiceWidget(reader *payloadReader) (*EditableServiceWidgetWrite, *EditableConfigError) {
	widgetReader, err := reader.objectField("widget", false)
	if err != nil || widgetReader == nil {
		return nil, err
	}
	widgetType, err := widgetReader.nonEmptyStringField("type", true)
	if err != nil {
		return nil, err
	}
	url, err := widgetReader.stringField("url", false)
	if err != nil {
		return nil, err
	}
	username, err := widgetReader.secretField("username")
	if err != nil {
		return nil, err
	}
	password, err := widgetReader.secretField("password")
	if err != nil {
		return nil, err
	}
	key, err := widgetReader.secretField("key")
	if err != nil {
		return nil, err
	}
	apiKey, err := widgetReader.secretField("apiKey")
	if err != nil {
		return nil, err
	}
	token, err := widgetReader.secretField("token")
	if err != nil {
		return nil, err
	}
	method, err := widgetReader.stringField("method", false)
	if err != nil {
		return nil, err
	}
	if method != nil && *method != "GET" {
		return nil, invalidPayload(widgetReader.fieldPath("method"), "只能为 GET")
	}
	headers, err := decodeWidgetHeaders(widgetReader)
	if err != nil {
		return nil, err
	}
	mappings, err := decodeWidgetMappings(widgetReader)
	if err != nil {
		return nil, err
	}
	enableBlocks, err := widgetReader.boolField("enableBlocks", false)
	if err != nil {
		return nil, err
	}
	enableNowPlaying, err := widgetReader.boolField("enableNowPlaying", false)
	if err != nil {
		return nil, err
	}
	enableUser, err := widgetReader.boolField("enableUser", false)
	if err != nil {
		return nil, err
	}
	showEpisodeNumber, err := widgetReader.boolField("showEpisodeNumber", false)
	if err != nil {
		return nil, err
	}
	fields, err := decodeStringList(widgetReader, "fields")
	if err != nil {
		return nil, err
	}
	version, err := widgetReader.intField("version", false)
	if err != nil {
		return nil, err
	}
	if version != nil && *version != 1 && *version != 2 {
		return nil, invalidPayload(widgetReader.fieldPath("version"), "只能为 1 或 2")
	}

	return &EditableServiceWidgetWrite{
		Type:              *widgetType,
		URL:               url,
		Username:          username,
		Password:          password,
		Key:               key,
		APIKey:            apiKey,
		Token:             token,
		Method:            method,
		Headers:           headers,
		Mappings:          mappings,
		EnableBlocks:      enableBlocks,
		EnableNowPlaying:  enableNowPlaying,
		EnableUser:        enableUser,
		ShowEpisodeNumber: showEpisodeNumber,
		Fields:            fields,
		Version:           version,
	}, nil
}

// 请求头数组；缺省返回 nil，出现时逐项校验名称与三态值。
func decodeWidgetHeaders(reader *payloadReader) (*[]EditableHeaderWrite, *EditableConfigError) {
	items, present, err := reader.arrayField("headers")
	if err != nil || !present {
		return nil, err
	}
	headers := make([]EditableHeaderWrite, 0, len(items))
	for index, item := range items {
		headerPath := fmt.Sprintf("%s.%d", reader.fieldPath("headers"), index)
		headerReader, headerErr := newPayloadReader(item, headerPath)
		if headerErr != nil {
			return nil, headerErr
		}
		name, headerErr := headerReader.nonEmptyStringField("name", true)
		if headerErr != nil {
			return nil, headerErr
		}
		value, headerErr := headerReader.secretField("value")
		if headerErr != nil {
			return nil, headerErr
		}
		if value == nil {
			return nil, invalidPayload(headerReader.fieldPath("value"), "为必填项")
		}
		headers = append(headers, EditableHeaderWrite{Name: *name, Value: *value})
	}
	return &headers, nil
}

// 取值映射数组；缺省返回 nil，出现时按键序只保留契约里的展示字段。
func decodeWidgetMappings(reader *payloadReader) (*[]EditableMapping, *EditableConfigError) {
	items, present, err := reader.arrayField("mappings")
	if err != nil || !present {
		return nil, err
	}
	mappings := make([]EditableMapping, 0, len(items))
	for index, item := range items {
		mappingPath := fmt.Sprintf("%s.%d", reader.fieldPath("mappings"), index)
		mappingReader, mappingErr := newPayloadReader(item, mappingPath)
		if mappingErr != nil {
			return nil, mappingErr
		}
		entry := EditableMapping{}
		for _, key := range []string{"field", "label", "format", "path", "id"} {
			text, fieldErr := mappingReader.stringField(key, false)
			if fieldErr != nil {
				return nil, fieldErr
			}
			switch key {
			case "field":
				entry.Field = text
			case "label":
				entry.Label = text
			case "format":
				entry.Format = text
			case "path":
				entry.Path = text
			case "id":
				entry.ID = text
			}
		}
		mappings = append(mappings, entry)
	}
	return &mappings, nil
}

// 字符串数组字段；缺省返回 nil，出现时逐项校验类型。
func decodeStringList(reader *payloadReader, key string) ([]string, *EditableConfigError) {
	items, present, err := reader.arrayField(key)
	if err != nil || !present {
		return nil, err
	}
	values := make([]string, 0, len(items))
	for index, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil, invalidPayload(fmt.Sprintf("%s.%d", reader.fieldPath(key), index), "必须为字符串")
		}
		values = append(values, text)
	}
	return values, nil
}

func decodeBookmarkGroups(reader *payloadReader) ([]EditableBookmarkGroupWrite, *EditableConfigError) {
	items, present, err := reader.arrayField("bookmarks")
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, invalidPayload(reader.fieldPath("bookmarks"), "为必填项")
	}

	groups := make([]EditableBookmarkGroupWrite, 0, len(items))
	for index, item := range items {
		groupPath := fmt.Sprintf("bookmarks.%d", index)
		groupReader, groupErr := newPayloadReader(item, groupPath)
		if groupErr != nil {
			return nil, groupErr
		}
		name, groupErr := groupReader.stringField("name", true)
		if groupErr != nil {
			return nil, groupErr
		}
		groupItems, itemsPresent, groupErr := groupReader.arrayField("items")
		if groupErr != nil {
			return nil, groupErr
		}
		if !itemsPresent {
			return nil, invalidPayload(groupReader.fieldPath("items"), "为必填项")
		}

		bookmarks := make([]EditableBookmarkItemWrite, 0, len(groupItems))
		for itemIndex, rawItem := range groupItems {
			bookmark, bookmarkErr := decodeBookmarkItem(rawItem, fmt.Sprintf("%s.items.%d", groupPath, itemIndex))
			if bookmarkErr != nil {
				return nil, bookmarkErr
			}
			bookmarks = append(bookmarks, bookmark)
		}
		groups = append(groups, EditableBookmarkGroupWrite{Name: *name, Items: bookmarks})
	}
	return groups, nil
}

func decodeBookmarkItem(raw any, path string) (EditableBookmarkItemWrite, *EditableConfigError) {
	reader, err := newPayloadReader(raw, path)
	if err != nil {
		return EditableBookmarkItemWrite{}, err
	}
	name, err := reader.stringField("name", true)
	if err != nil {
		return EditableBookmarkItemWrite{}, err
	}
	href, err := reader.stringField("href", true)
	if err != nil {
		return EditableBookmarkItemWrite{}, err
	}
	target, err := decodeLinkTarget(reader)
	if err != nil {
		return EditableBookmarkItemWrite{}, err
	}
	icon, err := reader.stringField("icon", false)
	if err != nil {
		return EditableBookmarkItemWrite{}, err
	}
	abbr, err := reader.stringField("abbr", false)
	if err != nil {
		return EditableBookmarkItemWrite{}, err
	}
	description, err := reader.stringField("description", false)
	if err != nil {
		return EditableBookmarkItemWrite{}, err
	}
	return EditableBookmarkItemWrite{
		Name:        *name,
		Href:        *href,
		Target:      target,
		Icon:        icon,
		Abbr:        abbr,
		Description: description,
	}, nil
}

func decodeInfoWidgets(reader *payloadReader) ([]EditableInfoWidgetWrite, *EditableConfigError) {
	items, present, err := reader.arrayField("infoWidgets")
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, invalidPayload(reader.fieldPath("infoWidgets"), "为必填项")
	}

	widgets := make([]EditableInfoWidgetWrite, 0, len(items))
	for index, item := range items {
		itemPath := fmt.Sprintf("infoWidgets.%d", index)
		itemReader, itemErr := newPayloadReader(item, itemPath)
		if itemErr != nil {
			return nil, itemErr
		}
		widgetType, itemErr := itemReader.stringField("type", true)
		if itemErr != nil {
			return nil, itemErr
		}
		widget, itemErr := decodeInfoWidget(itemReader, *widgetType)
		if itemErr != nil {
			return nil, itemErr
		}
		widgets = append(widgets, widget)
	}
	return widgets, nil
}

// 按类型分发：时间、天气、资源三种，其余类型拒绝。
func decodeInfoWidget(reader *payloadReader, widgetType string) (EditableInfoWidgetWrite, *EditableConfigError) {
	switch widgetType {
	case "datetime":
		timezone, err := reader.stringField("timezone", false)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		label, err := reader.stringField("label", false)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		format, err := decodeDatetimeFormat(reader)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		return EditableInfoWidgetWrite{Type: widgetType, Timezone: timezone, Label: label, Format: format}, nil

	case "openmeteo":
		cityID, err := reader.nonEmptyStringField("cityId", true)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		location, err := reader.nonEmptyStringField("location", true)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		label, err := reader.stringField("label", false)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		return EditableInfoWidgetWrite{Type: widgetType, CityID: cityID, Location: location, Label: label}, nil

	case "resources":
		cpu, err := reader.boolField("cpu", false)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		memory, err := reader.boolField("memory", false)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		label, err := reader.stringField("label", false)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		disk, err := decodeDiskField(reader)
		if err != nil {
			return EditableInfoWidgetWrite{}, err
		}
		return EditableInfoWidgetWrite{Type: widgetType, CPU: cpu, Memory: memory, Label: label, Disk: disk}, nil

	default:
		return EditableInfoWidgetWrite{}, invalidPayload(reader.fieldPath("type"), "只能为 datetime、openmeteo 或 resources")
	}
}

// 时间格式只接受三种键，键序固定为 timeStyle、dateStyle、hour12。
func decodeDatetimeFormat(reader *payloadReader) (*EditableDatetimeFormat, *EditableConfigError) {
	formatReader, err := reader.objectField("format", false)
	if err != nil || formatReader == nil {
		return nil, err
	}
	timeStyle, err := formatReader.stringField("timeStyle", false)
	if err != nil {
		return nil, err
	}
	dateStyle, err := formatReader.stringField("dateStyle", false)
	if err != nil {
		return nil, err
	}
	hour12, err := formatReader.boolField("hour12", false)
	if err != nil {
		return nil, err
	}
	return &EditableDatetimeFormat{TimeStyle: timeStyle, DateStyle: dateStyle, Hour12: hour12}, nil
}

// 磁盘声明：单字符串或条目数组，数组项为路径字符串或 {path,label} 对象。
func decodeDiskField(reader *payloadReader) (*EditableDiskField, *EditableConfigError) {
	value, exists := reader.doc["disk"]
	if !exists {
		return nil, nil
	}
	if text, ok := value.(string); ok {
		return &EditableDiskField{Text: text}, nil
	}

	list, ok := value.([]any)
	if !ok {
		return nil, invalidPayload(reader.fieldPath("disk"), "只能为字符串或数组")
	}
	entries := make([]EditableDiskEntryWrite, 0, len(list))
	for index, item := range list {
		entryPath := fmt.Sprintf("%s.%d", reader.fieldPath("disk"), index)
		if text, isString := item.(string); isString {
			entries = append(entries, EditableDiskEntryWrite{Path: text})
			continue
		}
		entryReader, entryErr := newPayloadReader(item, entryPath)
		if entryErr != nil {
			return nil, invalidPayload(entryPath, "只能为字符串或 {path, label} 对象")
		}
		pathValue, entryErr := entryReader.nonEmptyStringField("path", true)
		if entryErr != nil {
			return nil, entryErr
		}
		entry := EditableDiskEntryWrite{Path: *pathValue}
		if labelValue, labelExists := entryReader.doc["label"]; labelExists {
			label, isString := labelValue.(string)
			if !isString || label == "" {
				return nil, invalidPayload(entryReader.fieldPath("label"), "必须为非空字符串")
			}
			entry.Label = &label
		}
		entries = append(entries, entry)
	}
	return &EditableDiskField{IsList: true, Items: entries}, nil
}

func decodeDockerEndpoints(reader *payloadReader) ([]EditableDockerEndpoint, *EditableConfigError) {
	items, present, err := reader.arrayField("dockerEndpoints")
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, invalidPayload(reader.fieldPath("dockerEndpoints"), "为必填项")
	}

	endpoints := make([]EditableDockerEndpoint, 0, len(items))
	for index, item := range items {
		entryPath := fmt.Sprintf("dockerEndpoints.%d", index)
		entryReader, entryErr := newPayloadReader(item, entryPath)
		if entryErr != nil {
			return nil, entryErr
		}
		name, entryErr := entryReader.nonEmptyStringField("name", true)
		if entryErr != nil {
			return nil, entryErr
		}
		connection, entryErr := entryReader.stringField("connection", true)
		if entryErr != nil {
			return nil, entryErr
		}
		endpoints = append(endpoints, EditableDockerEndpoint{Name: *name, Connection: *connection})
	}
	return endpoints, nil
}

// 密钥三态：keep 与 clear 不带值，set 必须给出字符串值。
func parseSecretField(value any, path string) (*SecretFieldWrite, *EditableConfigError) {
	reader, err := newPayloadReader(value, path)
	if err != nil {
		return nil, err
	}
	modeValue, exists := reader.doc["mode"]
	if !exists {
		return nil, invalidPayload(reader.fieldPath("mode"), "为必填项")
	}
	mode, ok := modeValue.(string)
	if !ok {
		return nil, invalidPayload(reader.fieldPath("mode"), "只能为 keep、set 或 clear")
	}
	switch mode {
	case SecretModeKeep:
		return &SecretFieldWrite{Mode: SecretModeKeep}, nil
	case SecretModeClear:
		return &SecretFieldWrite{Mode: SecretModeClear}, nil
	case SecretModeSet:
		valueRaw, hasValue := reader.doc["value"]
		if !hasValue {
			return nil, invalidPayload(reader.fieldPath("value"), "为必填项")
		}
		text, isString := valueRaw.(string)
		if !isString {
			return nil, invalidPayload(reader.fieldPath("value"), "必须为字符串")
		}
		return &SecretFieldWrite{Mode: SecretModeSet, Value: text}, nil
	default:
		return nil, invalidPayload(reader.fieldPath("mode"), "只能为 keep、set 或 clear")
	}
}
