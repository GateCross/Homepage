package config

import (
	"fmt"
	"strings"
)

// 把写回载荷合并进磁盘上的原始解析树：只改动编辑器支持的字段，
// 未在表单里出现的键、以及编辑器无法投影的形态一律原样保留。

// 合并结果与磁盘原文一样按声明顺序输出，因此中间态统一用有序映射。

// 以磁盘值为基底复制一份有序映射；磁盘为空或不是映射时从空映射起步。
// 键序跟着磁盘原文走，写回后字段位置保持稳定。
func cloneMapInOrder(raw any) *orderedMap {
	cloned := newOrderedMap(8)
	rawMap, ok := raw.(*orderedMap)
	if !ok || rawMap == nil {
		return cloned
	}
	for _, key := range rawMap.keys {
		cloned.set(key, deepCopyValue(rawMap.values[key]))
	}
	return cloned
}

// 深度复制解析树；标量原样复用，映射与序列逐层新建。
func deepCopyValue(raw any) any {
	switch value := raw.(type) {
	case *orderedMap:
		if value == nil {
			return nil
		}
		copied := newOrderedMap(len(value.keys))
		for _, key := range value.keys {
			copied.set(key, deepCopyValue(value.values[key]))
		}
		return copied
	case []any:
		copied := make([]any, len(value))
		for index, item := range value {
			copied[index] = deepCopyValue(item)
		}
		return copied
	default:
		return raw
	}
}

// 按原始参数形态取映射：写回中间态统一走有序映射。
func mergedMap(container *orderedMap, key string) *orderedMap {
	if existing, ok := container.values[key].(*orderedMap); ok {
		return existing
	}
	created := newOrderedMap(4)
	container.set(key, created)
	return created
}

// 键是否存在，用于区分「未提交」与「显式清除」。
func hasKey(container *orderedMap, key string) bool {
	_, exists := container.values[key]
	return exists
}

// 删除键并保持其余键的声明顺序。
func removeKey(container *orderedMap, key string) {
	if _, exists := container.values[key]; !exists {
		return
	}
	delete(container.values, key)
	keys := make([]string, 0, len(container.keys))
	for _, existing := range container.keys {
		if existing != key {
			keys = append(keys, existing)
		}
	}
	container.keys = keys
}

// 合并五份文档；返回与输入同形的有序树，供序列化直接使用。
// 条目无法安全对应磁盘原文时返回错误，调用方不得落盘。
func MergeEditableIntoSources(payload EditableConfigWrite, sources map[string]any) (map[string]any, error) {
	services, err := mergeServicesSource(sources[FileServices], payload.Services)
	if err != nil {
		return nil, err
	}
	bookmarks, err := mergeBookmarksSource(sources[FileBookmarks], payload.Bookmarks)
	if err != nil {
		return nil, err
	}

	merged := make(map[string]any, len(ConfigFileNames))
	dockerSource, err := mergeDockerSource(sources[FileDocker], payload.DockerEndpoints)
	if err != nil {
		return nil, err
	}

	merged[FileSettings] = mergeSettingsSource(sources[FileSettings], payload.Settings)
	merged[FileServices] = services
	merged[FileBookmarks] = bookmarks
	merged[FileWidgets] = mergeInfoWidgetsSource(sources[FileWidgets], payload.InfoWidgets)
	merged[FileDocker] = dockerSource
	return merged, nil
}

// 设置段：标题与等高开关照写，背景、图标与布局按编辑器取值取舍。
func mergeSettingsSource(disk any, editable EditableSettingsWrite) *orderedMap {
	base := cloneMapInOrder(disk)
	base.set("title", editable.Title)
	base.set("useEqualHeights", editable.UseEqualHeights)

	applyBackground(base, editable.Background)
	applyFavicon(base, editable.Favicon)
	applyLayout(base, editable.Layout)
	return base
}

// 背景：编辑器给出非空值才写；磁盘原为含 image 键的对象时保持对象形态。
// 编辑器留空则删键，连同对象形态一起清除。
func applyBackground(base *orderedMap, background *string) {
	if background == nil || strings.TrimSpace(*background) == "" {
		removeKey(base, "background")
		return
	}
	if previous, ok := base.values["background"].(*orderedMap); ok && hasKey(previous, "image") {
		previous.set("image", *background)
		return
	}
	base.set("background", *background)
}

// 图标：编辑器留空即删键。
func applyFavicon(base *orderedMap, favicon *string) {
	if favicon == nil || strings.TrimSpace(*favicon) == "" {
		removeKey(base, "favicon")
		return
	}
	base.set("favicon", strings.TrimSpace(*favicon))
}

// 布局：分组集合以编辑器为准；编辑器未列出的分组只保留未知子键，
// 仅含 columns（或完全为空）的分组整体删除。
func applyLayout(base *orderedMap, layout []EditableLayoutEntry) {
	layoutOut := newOrderedMap(4)
	if previous, ok := base.values["layout"].(*orderedMap); ok {
		for _, key := range previous.keys {
			layoutOut.set(key, deepCopyValue(previous.values[key]))
		}
	}

	editorNames := make(map[string]struct{}, len(layout))
	for _, entry := range layout {
		if name := strings.TrimSpace(entry.GroupName); name != "" {
			editorNames[name] = struct{}{}
		}
	}

	for _, key := range append([]string(nil), layoutOut.keys...) {
		if _, listed := editorNames[key]; listed {
			continue
		}
		group, ok := layoutOut.values[key].(*orderedMap)
		if !ok {
			removeKey(layoutOut, key)
			continue
		}
		if len(group.keys) == 0 {
			removeKey(layoutOut, key)
			continue
		}
		if len(group.keys) == 1 && group.keys[0] == "columns" {
			removeKey(layoutOut, key)
			continue
		}
		removeKey(group, "columns")
	}

	for _, entry := range layout {
		name := strings.TrimSpace(entry.GroupName)
		if name == "" {
			continue
		}
		group := mergedMap(layoutOut, name)
		group.set("columns", entry.MaxColumns)
	}

	if len(layoutOut.keys) > 0 {
		base.set("layout", layoutOut)
		return
	}
	removeKey(base, "layout")
}

// 服务分组：输出数组形态，每个元素是「分组名: 条目数组」的单键映射。
// 同名分组按出现序号对应；分组内同名条目过多且索引对不上时拒绝写回。
func mergeServicesSource(disk any, editable []EditableServiceGroupWrite) ([]any, error) {
	diskGroups := expandMergedGroups(disk)
	result := make([]any, 0, len(editable))
	occurrences := map[string]int{}

	for groupIndex, group := range editable {
		groupName := strings.TrimSpace(group.Name)
		if groupName == "" {
			// 空名分组无法落到磁盘，直接判为载荷非法而不是静默丢弃
			return nil, &EditableConfigError{
				Message: "服务分组名称不能为空",
				File:    FileServices,
				Path:    fmt.Sprintf("services.%d.name", groupIndex),
			}
		}
		occurrence := occurrences[groupName]
		occurrences[groupName] = occurrence + 1
		diskGroup := pickGroupOccurrence(diskGroups, groupName, occurrence)

		items := make([]any, 0, len(group.Items))
		for itemIndex, item := range group.Items {
			diskItem := findDiskServiceItem(diskGroups, groupName, occurrence, item.Name, itemIndex)
			if diskGroup != nil {
				// 分组内同名多条且索引位不是同名条目时拒绝写回，避免把条目挂到错误基底
				if duplicateNameAmbiguous(diskGroup.items, item.Name, itemIndex) {
					return nil, ambiguousServiceItemError(groupName, item.Name, groupIndex, itemIndex)
				}
				if diskItem == nil {
					diskItem = mergedMapAt(diskGroup.items, itemIndex)
				}
			}
			mergedItem, mergeErr := mergeServiceItem(item, diskItem)
			if mergeErr != nil {
				return nil, mergeErr
			}
			items = append(items, mergedItem)
		}

		entry := newOrderedMap(1)
		entry.set(groupName, items)
		result = append(result, entry)
	}
	return result, nil
}

// 分组内同名条目无法安全对应磁盘原文时的错误，指向具体条目。
func ambiguousServiceItemError(groupName, itemName string, groupIndex, itemIndex int) *EditableConfigError {
	message := "服务条目无法安全对应：分组「" + groupName + "」中存在重复名称「" + itemName + "」"
	return &EditableConfigError{
		Message: message,
		File:    FileServices,
		Path:    fmt.Sprintf("services.%d.items.%d", groupIndex, itemIndex),
	}
}

// 单个服务条目：以磁盘条目为基底，逐字段按编辑器取值落盘。
func mergeServiceItem(editable EditableServiceItemWrite, diskItem *orderedMap) (*orderedMap, error) {
	base := cloneMapInOrder(diskItem)
	base.set("name", editable.Name)

	if editable.Href != nil && strings.TrimSpace(*editable.Href) != "" {
		base.set("href", strings.TrimSpace(*editable.Href))
	} else {
		removeKey(base, "href")
	}

	if editable.Target != nil {
		base.set("target", *editable.Target)
	}

	if editable.Icon != nil {
		if icon := strings.TrimSpace(*editable.Icon); icon != "" {
			base.set("icon", icon)
		} else {
			removeKey(base, "icon")
		}
	}

	if editable.Description != nil {
		if description := strings.TrimSpace(*editable.Description); description != "" {
			base.set("description", description)
		} else {
			removeKey(base, "description")
		}
	}

	if editable.Hidden != nil && *editable.Hidden {
		base.set("hidden", true)
	} else {
		removeKey(base, "hidden")
	}

	mergeHTTPProbe(base, editable.HTTPProbe, diskItem)

	if editable.Docker != nil && strings.TrimSpace(editable.Docker.Server) != "" && strings.TrimSpace(editable.Docker.Container) != "" {
		base.set("server", strings.TrimSpace(editable.Docker.Server))
		base.set("container", strings.TrimSpace(editable.Docker.Container))
	} else {
		removeKey(base, "server")
		removeKey(base, "container")
	}

	if err := mergeServiceWidget(base, editable.Widget, diskItem); err != nil {
		return nil, err
	}
	return base, nil
}

// 探测：关闭时清除三个支持字段；开启时地址为空回退 true，由加载器按 href 解析。
func mergeHTTPProbe(base *orderedMap, probe *EditableHTTPProbe, diskItem *orderedMap) {
	if probe == nil || !probe.Enabled {
		removeKey(base, "siteMonitor")
		removeKey(base, "expectedStatus")
		removeKey(base, "probeTimeout")
		return
	}

	if probe.URL != nil && strings.TrimSpace(*probe.URL) != "" {
		base.set("siteMonitor", strings.TrimSpace(*probe.URL))
	} else {
		base.set("siteMonitor", true)
	}

	// 期望状态与超时：编辑器给了就以其为准，没给则保留磁盘原值
	if probe.ExpectedStatus != nil {
		if status := strings.TrimSpace(*probe.ExpectedStatus); status != "" {
			base.set("expectedStatus", status)
		} else {
			removeKey(base, "expectedStatus")
		}
	} else if diskItem != nil && hasKey(diskItem, "expectedStatus") {
		base.set("expectedStatus", deepCopyValue(diskItem.values["expectedStatus"]))
	}

	if probe.TimeoutSec != nil {
		base.set("probeTimeout", *probe.TimeoutSec)
	} else if diskItem != nil && hasKey(diskItem, "probeTimeout") {
		base.set("probeTimeout", deepCopyValue(diskItem.values["probeTimeout"]))
	}
}

// 服务组件：编辑器没有组件时清除单数 widget 与 widgets 数组两个声明键。
func mergeServiceWidget(base *orderedMap, widget *EditableServiceWidgetWrite, diskItem *orderedMap) error {
	if widget == nil {
		removeKey(base, "widget")
		removeKey(base, "widgets")
		return nil
	}

	extracted := extractDiskWidget(diskItem)
	out := newOrderedMap(8)
	if extracted != nil {
		out = cloneMapInOrder(extracted.raw)
	}
	out.set("type", widget.Type)

	if widget.URL != nil && strings.TrimSpace(*widget.URL) != "" {
		out.set("url", strings.TrimSpace(*widget.URL))
	} else {
		removeKey(out, "url")
	}

	if err := applySecretWrite(out, "username", widget.Username, diskSecret(extracted, "username")); err != nil {
		return err
	}
	if err := applySecretWrite(out, "password", widget.Password, diskSecret(extracted, "password")); err != nil {
		return err
	}
	if err := applySecretWrite(out, "key", widget.Key, diskSecret(extracted, "key")); err != nil {
		return err
	}
	if err := applySecretWrite(out, "apiKey", widget.APIKey, diskSecret(extracted, "apiKey")); err != nil {
		return err
	}
	if err := applySecretWrite(out, "token", widget.Token, diskSecret(extracted, "token")); err != nil {
		return err
	}

	if widget.Method != nil {
		out.set("method", *widget.Method)
	}

	if widget.Headers != nil {
		if err := mergeWidgetHeaders(out, *widget.Headers, extracted); err != nil {
			return err
		}
	}

	if widget.Mappings != nil {
		out.set("mappings", encodeMappings(*widget.Mappings))
	}

	applyOptionalBool(out, "enableBlocks", widget.EnableBlocks)
	applyOptionalBool(out, "enableNowPlaying", widget.EnableNowPlaying)
	applyOptionalBool(out, "enableUser", widget.EnableUser)
	applyOptionalBool(out, "showEpisodeNumber", widget.ShowEpisodeNumber)

	if len(widget.Fields) > 0 {
		fields := make([]any, 0, len(widget.Fields))
		for _, field := range widget.Fields {
			if normalized := normalizeTypeToken(field); normalized != "" {
				fields = append(fields, normalized)
			}
		}
		if len(fields) > 0 {
			out.set("fields", fields)
		} else {
			removeKey(out, "fields")
		}
	} else {
		removeKey(out, "fields")
	}

	// Immich 版本只对 immich 写回，切换类型后不得残留在其它组件上
	if widget.Type == "immich" && widget.Version != nil && (*widget.Version == 1 || *widget.Version == 2) {
		out.set("version", *widget.Version)
	} else {
		removeKey(out, "version")
	}

	// 磁盘是多元素 widgets 数组时就地替换选中项，其余条目保持原样，避免静默丢数据
	if diskItem != nil && extracted != nil && extracted.source == "widgets" && extracted.index >= 0 {
		if list, ok := diskItem.values["widgets"].([]any); ok && len(list) > 1 && extracted.index < len(list) {
			updated := make([]any, len(list))
			copy(updated, list)
			updated[extracted.index] = out
			base.set("widgets", updated)
			removeKey(base, "widget")
			return nil
		}
	}

	base.set("widget", out)
	removeKey(base, "widgets")
	return nil
}

// 布尔开关：编辑器给出才写，未出现即删键，避免残留磁盘旧值。
func applyOptionalBool(target *orderedMap, key string, value *bool) {
	if value == nil {
		removeKey(target, key)
		return
	}
	target.set(key, *value)
}

// 请求头：以编辑器列表为准重建，值走密钥三态；磁盘里未列出的请求头丢弃。
func mergeWidgetHeaders(out *orderedMap, headers []EditableHeaderWrite, extracted *diskWidget) error {
	diskHeaders := asMap(nil)
	if extracted != nil {
		diskHeaders = asMap(extracted.raw.values["headers"])
	}

	headersOut := newOrderedMap(len(headers))
	for _, header := range headers {
		name := strings.TrimSpace(header.Name)
		if name == "" {
			continue
		}
		holder := newOrderedMap(1)
		if err := applySecretWrite(holder, name, &header.Value, diskHeaders[name]); err != nil {
			return err
		}
		if hasKey(holder, name) {
			headersOut.set(name, holder.values[name])
		}
	}

	if len(headersOut.keys) > 0 {
		out.set("headers", headersOut)
		return nil
	}
	removeKey(out, "headers")
	return nil
}

// 取值映射按契约字段序写出，未给出的键不落盘。
func encodeMappings(mappings []EditableMapping) []any {
	encoded := make([]any, 0, len(mappings))
	for _, mapping := range mappings {
		entry := newOrderedMap(5)
		for _, field := range []struct {
			key   string
			value *string
		}{
			{"field", mapping.Field},
			{"label", mapping.Label},
			{"format", mapping.Format},
			{"path", mapping.Path},
			{"id", mapping.ID},
		} {
			if field.value != nil {
				entry.set(field.key, *field.value)
			}
		}
		encoded = append(encoded, entry)
	}
	return encoded
}

// 密钥三态落盘：未提交保留磁盘原值，keep 保留、set 写入或清空、clear 删除。
// keep 遇到非字符串的磁盘值时拒绝写回，避免把无法安全保留的值静默丢掉。
func applySecretWrite(target *orderedMap, key string, write *SecretFieldWrite, diskRaw any) error {
	if write == nil {
		// 未提交该字段：磁盘有字符串值就保留，其余保持基底原样
		if text, ok := diskRaw.(string); ok {
			target.set(key, text)
		}
		return nil
	}

	switch write.Mode {
	case SecretModeKeep:
		if text, ok := diskRaw.(string); ok {
			target.set(key, text)
			return nil
		}
		if diskRaw == nil {
			removeKey(target, key)
			return nil
		}
		return &EditableConfigError{
			Message: "密钥字段 " + key + " 的磁盘值类型无法安全保留",
			Path:    key,
		}

	case SecretModeSet:
		if len(write.Value) == 0 {
			removeKey(target, key)
			return nil
		}
		target.set(key, write.Value)
		return nil

	case SecretModeClear:
		removeKey(target, key)
		return nil

	default:
		return nil
	}
}

// 磁盘组件里的密钥原值；组件未投影出密钥时返回 nil。
func diskSecret(extracted *diskWidget, key string) any {
	if extracted == nil {
		return nil
	}
	return extracted.raw.values[key]
}

// 分组投影中间态：名称与条目数组。
type mergedGroup struct {
	name  string
	items []any
}

// 顶层分组两种形态都接受：数组里每项是单键映射，或者本身就是「名字: 条目数组」映射。
func expandMergedGroups(raw any) []mergedGroup {
	groups := make([]mergedGroup, 0)

	appendGroup := func(entry *orderedMap) {
		for _, key := range entry.keys {
			name := strings.TrimSpace(key)
			if name == "" {
				continue
			}
			items, _ := entry.values[key].([]any)
			groups = append(groups, mergedGroup{name: name, items: items})
		}
	}

	if list, ok := raw.([]any); ok {
		for _, entry := range list {
			if entryMap, isMap := entry.(*orderedMap); isMap {
				appendGroup(entryMap)
			}
		}
		return groups
	}
	if entryMap, isMap := raw.(*orderedMap); isMap {
		appendGroup(entryMap)
	}
	return groups
}

// 同名分组按出现序号对应，避免全部挂到第一组。
func pickGroupOccurrence(groups []mergedGroup, name string, occurrence int) *mergedGroup {
	seen := 0
	for index := range groups {
		if groups[index].name != name {
			continue
		}
		if seen == occurrence {
			return &groups[index]
		}
		seen++
	}
	return nil
}

// 服务条目基底：优先「索引 + 同名」命中，其次同名唯一匹配。
func findDiskServiceItem(groups []mergedGroup, groupName string, occurrence int, itemName string, itemIndex int) *orderedMap {
	group := pickGroupOccurrence(groups, groupName, occurrence)
	if group == nil {
		return nil
	}
	if byIndex := mergedMapAt(group.items, itemIndex); byIndex != nil {
		if name, _ := byIndex.values["name"].(string); name == itemName {
			return byIndex
		}
	}
	var matched *orderedMap
	for _, item := range group.items {
		itemMap, ok := item.(*orderedMap)
		if !ok {
			continue
		}
		if name, _ := itemMap.values["name"].(string); name != itemName {
			continue
		}
		if matched != nil {
			return nil
		}
		matched = itemMap
	}
	return matched
}

// 分组内同名条目出现多次、且索引位不是同名条目时，无法安全对应磁盘基底。
func duplicateNameAmbiguous(items []any, itemName string, itemIndex int) bool {
	count := 0
	for _, item := range items {
		itemMap, ok := item.(*orderedMap)
		if !ok {
			continue
		}
		if name, _ := itemMap.values["name"].(string); name == itemName {
			count++
		}
	}
	if count <= 1 {
		return false
	}
	indexed := mergedMapAt(items, itemIndex)
	if indexed == nil {
		return true
	}
	name, _ := indexed.values["name"].(string)
	return name != itemName
}

// 取数组指定位置的有序映射；越界或类型不符返回 nil。
func mergedMapAt(items []any, index int) *orderedMap {
	if index < 0 || index >= len(items) {
		return nil
	}
	itemMap, _ := items[index].(*orderedMap)
	return itemMap
}

// 书签分组：与服务分组同样的数组形态与同名序号对应规则。
func mergeBookmarksSource(disk any, editable []EditableBookmarkGroupWrite) ([]any, error) {
	diskGroups := expandMergedGroups(disk)
	result := make([]any, 0, len(editable))
	occurrences := map[string]int{}

	for groupIndex, group := range editable {
		groupName := strings.TrimSpace(group.Name)
		if groupName == "" {
			// 空名书签分组同样判为载荷非法
			return nil, &EditableConfigError{
				Message: "书签分组名称不能为空",
				File:    FileBookmarks,
				Path:    fmt.Sprintf("bookmarks.%d.name", groupIndex),
			}
		}
		occurrence := occurrences[groupName]
		occurrences[groupName] = occurrence + 1
		diskGroup := pickGroupOccurrence(diskGroups, groupName, occurrence)

		items := make([]any, 0, len(group.Items))
		for itemIndex, item := range group.Items {
			var base *orderedMap
			if diskGroup != nil {
				if byIndex := mergedMapAt(diskGroup.items, itemIndex); byIndex != nil {
					if name, _ := byIndex.values["name"].(string); name == item.Name {
						base = byIndex
					}
				}
				if base == nil {
					if match := uniqueNameMatch(diskGroup.items, item.Name); match != nil {
						base = match
					}
				}
			}

			bookmark := cloneMapInOrder(base)
			bookmark.set("name", item.Name)
			bookmark.set("href", item.Href)
			if item.Target != nil {
				bookmark.set("target", *item.Target)
			}
			applyTrimmedOptional(bookmark, "icon", item.Icon)
			applyTrimmedOptional(bookmark, "abbr", item.Abbr)
			applyTrimmedOptional(bookmark, "description", item.Description)
			items = append(items, bookmark)
		}

		entry := newOrderedMap(1)
		entry.set(groupName, items)
		result = append(result, entry)
	}
	return result, nil
}

// 同名唯一匹配；零个或多个同名条目都返回 nil。
func uniqueNameMatch(items []any, name string) *orderedMap {
	var matched *orderedMap
	for _, item := range items {
		itemMap, ok := item.(*orderedMap)
		if !ok {
			continue
		}
		if current, _ := itemMap.values["name"].(string); current != name {
			continue
		}
		if matched != nil {
			return nil
		}
		matched = itemMap
	}
	return matched
}

// 可选文本：未提交保持原样，提交后去空白，空串删键。
func applyTrimmedOptional(target *orderedMap, key string, value *string) {
	if value == nil {
		return
	}
	if trimmed := strings.TrimSpace(*value); trimmed != "" {
		target.set(key, trimmed)
		return
	}
	removeKey(target, key)
}

// 磁盘里受支持的信息组件类型，其余类型原样保留。
var knownInfoWidgetTypes = map[string]struct{}{
	"datetime":  {},
	"openmeteo": {},
	"resources": {},
}

// 信息组件：已知类型按编辑器顺序重排，未知类型追加在原位置之后，避免保存后从磁盘消失。
func mergeInfoWidgetsSource(disk any, editable []EditableInfoWidgetWrite) []any {
	diskEntries := expandInfoWidgetEntries(disk)
	knownEntries := make([]*orderedMap, 0, len(diskEntries))
	for _, entry := range diskEntries {
		if _, known := knownInfoWidgetTypes[infoWidgetToken(entry)]; known {
			knownEntries = append(knownEntries, entry)
		}
	}

	used := make([]bool, len(knownEntries))
	result := make([]any, 0, len(editable)+len(diskEntries))
	for _, widget := range editable {
		wantType := normalizeTypeToken(widget.Type)
		var base *orderedMap
		for index, candidate := range knownEntries {
			if used[index] || infoWidgetToken(candidate) != wantType {
				continue
			}
			used[index] = true
			base = candidate
			break
		}
		result = append(result, mergeInfoWidget(base, widget))
	}

	for _, entry := range diskEntries {
		if _, known := knownInfoWidgetTypes[infoWidgetToken(entry)]; known {
			continue
		}
		result = append(result, deepCopyValue(entry))
	}
	return result
}

// 单个信息组件：以同类型磁盘条目为基底，按类型只写对应字段。
func mergeInfoWidget(base *orderedMap, widget EditableInfoWidgetWrite) *orderedMap {
	out := cloneMapInOrder(base)
	out.set("type", widget.Type)

	switch widget.Type {
	case "datetime":
		// 时间组件以编辑器为准：没给的键删除，不保留磁盘旧值
		applyDeletingOptional(out, "timezone", widget.Timezone)
		applyDeletingOptional(out, "label", widget.Label)
		if widget.Format != nil {
			out.set("format", encodeDatetimeFormat(widget.Format))
		} else {
			removeKey(out, "format")
		}

	case "openmeteo":
		if widget.CityID != nil {
			out.set("cityId", *widget.CityID)
		}
		if widget.Location != nil {
			out.set("location", *widget.Location)
		}
		// 经纬度与旧时区写法由 cityId/location 取代，写回后一律清除
		removeKey(out, "latitude")
		removeKey(out, "longitude")
		removeKey(out, "timezone")
		applyDeletingOptional(out, "label", widget.Label)

	case "resources":
		// 开关未提交时保留磁盘原值，标签同样以编辑器为准
		applyOptionalBool(out, "cpu", widget.CPU)
		applyOptionalBool(out, "memory", widget.Memory)
		applyDeletingOptional(out, "label", widget.Label)
		if widget.Disk != nil {
			out.set("disk", encodeDiskField(*widget.Disk))
			removeKey(out, "diskPath")
			removeKey(out, "diskPaths")
			removeKey(out, "disks")
		} else {
			removeKey(out, "disk")
			removeKey(out, "diskPath")
			removeKey(out, "diskPaths")
			removeKey(out, "disks")
		}
	}

	return out
}

// 组件类型标记：只做去空白与转小写，非字符串视为空。
func infoWidgetToken(entry *orderedMap) string {
	text, _ := entry.values["type"].(string)
	return normalizeTypeToken(text)
}

// 可选文本：未提交即删键，提交后原样写入。
func applyDeletingOptional(target *orderedMap, key string, value *string) {
	if value == nil {
		removeKey(target, key)
		return
	}
	target.set(key, *value)
}

// 时间格式只写契约里的三种键，空对象也要落成 {} 而不是 null。
func encodeDatetimeFormat(format *EditableDatetimeFormat) *orderedMap {
	out := newOrderedMap(3)
	if format.TimeStyle != nil {
		out.set("timeStyle", *format.TimeStyle)
	}
	if format.DateStyle != nil {
		out.set("dateStyle", *format.DateStyle)
	}
	if format.Hour12 != nil {
		out.set("hour12", *format.Hour12)
	}
	return out
}

// 磁盘声明序列化：单字符串写字符串，条目数组逐项写，带别名才写成 {path, label}。
func encodeDiskField(field EditableDiskField) any {
	if !field.IsList {
		return field.Text
	}
	items := make([]any, 0, len(field.Items))
	for _, entry := range field.Items {
		if entry.Label == nil {
			items = append(items, entry.Path)
			continue
		}
		item := newOrderedMap(2)
		item.set("path", entry.Path)
		item.set("label", *entry.Label)
		items = append(items, item)
	}
	return items
}

// 从磁盘文档取出信息组件条目；映射形态既接受带 type 的对象，也接受类型名简写。
func expandInfoWidgetEntries(disk any) []*orderedMap {
	entries := make([]*orderedMap, 0)
	if disk == nil {
		return entries
	}
	if list, ok := disk.([]any); ok {
		for _, item := range list {
			if itemMap, isMap := item.(*orderedMap); isMap {
				entries = append(entries, itemMap)
			}
		}
		return entries
	}
	diskMap, ok := disk.(*orderedMap)
	if !ok {
		return entries
	}
	for _, key := range diskMap.keys {
		value := diskMap.values[key]
		if value == nil {
			shorthand := newOrderedMap(1)
			shorthand.set("type", key)
			entries = append(entries, shorthand)
			continue
		}
		inner, isMap := value.(*orderedMap)
		if !isMap {
			continue
		}
		if _, hasType := inner.values["type"].(string); hasType {
			entries = append(entries, inner)
			continue
		}
		// 类型名简写：把键名补成 type，其余键按原顺序跟在后面
		shorthand := newOrderedMap(len(inner.keys) + 1)
		shorthand.set("type", key)
		for _, innerKey := range inner.keys {
			shorthand.set(innerKey, inner.values[innerKey])
		}
		entries = append(entries, shorthand)
	}
	return entries
}

// docker 端点：以原映射为基底，编辑器已删除的字符串端点移除，非字符串连接值原样保留。
func mergeDockerSource(disk any, editable []EditableDockerEndpoint) (*orderedMap, error) {
	base := cloneMapInOrder(disk)
	editorNames := make(map[string]struct{}, len(editable))
	for index, endpoint := range editable {
		name := strings.TrimSpace(endpoint.Name)
		if name == "" {
			return nil, &EditableConfigError{
				Message: "Docker 端点名称不能为空",
				File:    FileDocker,
				Path:    fmt.Sprintf("dockerEndpoints.%d.name", index),
			}
		}
		editorNames[name] = struct{}{}
	}

	for _, key := range append([]string(nil), base.keys...) {
		if _, listed := editorNames[key]; listed {
			continue
		}
		if _, isString := base.values[key].(string); !isString {
			// 非字符串连接值编辑器无法投影，必须保留
			continue
		}
		removeKey(base, key)
	}

	// 已有端点保持原插入位置，新端点追加到末尾
	for _, endpoint := range editable {
		base.set(strings.TrimSpace(endpoint.Name), endpoint.Connection)
	}
	return base, nil
}

// 磁盘组件的中间态：组件原值、声明来源与数组下标。
type diskWidget struct {
	raw    *orderedMap
	source string
	// widgets 数组中的下标；单数 widget 为 -1
	index int
}

// 与投影侧一致：优先第一个受支持类型，退而取第一个带 type 的声明。
// 声明源优先级同样是 widgets 数组高于单数 widget。
func extractDiskWidget(diskItem *orderedMap) *diskWidget {
	if diskItem == nil {
		return nil
	}

	if list, ok := diskItem.values["widgets"].([]any); ok {
		for index, item := range list {
			itemMap, isMap := item.(*orderedMap)
			if !isMap {
				continue
			}
			if _, supported := supportedWidgetTypes[normalizeTypeToken(nonEmptyString(itemMap.values["type"]))]; supported {
				return &diskWidget{raw: itemMap, source: "widgets", index: index}
			}
		}
		for index, item := range list {
			itemMap, isMap := item.(*orderedMap)
			if !isMap {
				continue
			}
			if text, isString := itemMap.values["type"].(string); isString && strings.TrimSpace(text) != "" {
				return &diskWidget{raw: itemMap, source: "widgets", index: index}
			}
		}
		return nil
	}

	if single, ok := diskItem.values["widget"].(*orderedMap); ok {
		return &diskWidget{raw: single, source: "widget", index: -1}
	}
	return nil
}
