package providers

import (
	"context"
	"math"
	"strings"
	"sync"
	"time"
)

// 资源项的固定标签与降级文案。
const (
	cpuLabel         = "CPU"
	memoryLabel      = "内存"
	rootDiskFallback = "磁盘"
	// StatusUnavailable 是资源项无法采集时 status 的取值，与前端判别联合一致。
	StatusUnavailable = "unavailable"
)

// 资源采集的默认参数。
const (
	// DefaultResourcesTimeout 是单次资源采集的超时。
	DefaultResourcesTimeout = 10 * time.Second
	// DefaultCPUSeedGap 是冷启动时第二拍 CPU 采样的间隔，避免空等。
	DefaultCPUSeedGap = 80 * time.Millisecond
)

// 资源降级文案；平台不支持与读取失败分开表述。
const (
	cpuUnsupportedMessage    = "当前平台不支持采集 CPU 占用"
	cpuReadFailedMessage     = "无法读取 CPU 占用"
	memoryUnsupportedMessage = "当前平台不支持采集内存占用"
	diskUnsupportedMessage   = "当前平台不支持采集磁盘使用率"
	diskMissingMessage       = "磁盘路径不存在或不可访问"
	diskAccessMessage        = "没有权限读取该磁盘路径"
	diskGeneralMessage       = "无法读取该磁盘使用率"
)

// ResourceItem 是一个资源项，按是否带 percent 区分可用与降级两种形态：
// 可用项给 percent 与可选字节数，降级项给 status 与 message，两者字段互不重叠。
type ResourceItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`

	Percent    *float64 `json:"percent,omitempty"`
	UsedBytes  *int64   `json:"usedBytes,omitempty"`
	TotalBytes *int64   `json:"totalBytes,omitempty"`

	Status  *string `json:"status,omitempty"`
	Message *string `json:"message,omitempty"`
}

// ResourcesInfoResponse 是资源组件的响应体。
type ResourcesInfoResponse struct {
	Items []ResourceItem `json:"items"`
}

// DiskTarget 是一个待统计的挂载点，别名只影响展示标签，不参与身份。
type DiskTarget struct {
	Path  string
	Label string
}

// ResourcesTarget 是本次采集要输出的项：CPU、内存开关与磁盘挂载点列表。
type ResourcesTarget struct {
	CPU    bool
	Memory bool
	Disks  []DiskTarget
}

// cpuTimes 是 /proc/stat 的累计时间片，用两次采样的差值算真实占用。
type cpuTimes struct {
	idle  uint64
	total uint64
}

// memorySample 是内存采样的字节数。
type memorySample struct {
	usedBytes  int64
	totalBytes int64
}

// diskSample 是单个挂载点的统计结果；ok 为假时只带降级文案。
type diskSample struct {
	ok         bool
	percent    float64
	usedBytes  int64
	totalBytes int64
	message    string
}

// ResourcesClient 采集系统资源并保留上一拍 CPU 时间片，可并发复用。
type ResourcesClient struct {
	mu       sync.Mutex
	previous *cpuTimes
	timeout  time.Duration
	seedGap  time.Duration
}

// ResourcesClientOptions 覆盖默认超时与冷启动补拍间隔。
type ResourcesClientOptions struct {
	Timeout time.Duration
	SeedGap time.Duration
}

// NewResourcesClient 构造资源采集器；超时与补拍间隔缺省时取包内常量。
func NewResourcesClient(options ResourcesClientOptions) *ResourcesClient {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultResourcesTimeout
	}
	seedGap := options.SeedGap
	if seedGap <= 0 {
		seedGap = DefaultCPUSeedGap
	}
	return &ResourcesClient{timeout: timeout, seedGap: seedGap}
}

// Collect 按目标顺序输出 CPU、内存与各磁盘项，单项失败只降级该项。
func (c *ResourcesClient) Collect(ctx context.Context, target ResourcesTarget) ResourcesInfoResponse {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	items := make([]ResourceItem, 0, 2+len(target.Disks))
	if target.CPU {
		items = append(items, c.collectCPU(ctx))
	}
	if target.Memory {
		items = append(items, collectMemory())
	}
	for _, disk := range target.Disks {
		items = append(items, collectDisk(disk))
	}
	return ResourcesInfoResponse{Items: items}
}

// 采两拍 CPU 时间片算占用；没有上一拍时先补拍一次，保证首包也有真实值。
func (c *ResourcesClient) collectCPU(ctx context.Context) ResourceItem {
	first, ok := readCPUTimes()
	if !ok {
		return unavailableItem("cpu", cpuLabel, cpuUnsupportedMessage)
	}

	c.mu.Lock()
	previous := c.previous
	c.previous = &first
	c.mu.Unlock()

	if previous != nil {
		return cpuItem(*previous, first)
	}

	if err := sleepWithContext(ctx, c.seedGap); err != nil {
		return unavailableItem("cpu", cpuLabel, cpuReadFailedMessage)
	}
	second, ok := readCPUTimes()
	if !ok {
		return unavailableItem("cpu", cpuLabel, cpuReadFailedMessage)
	}
	c.mu.Lock()
	c.previous = &second
	c.mu.Unlock()
	return cpuItem(first, second)
}

// 内存项；读不到总量即降级。
func collectMemory() ResourceItem {
	sample, ok := readMemorySample()
	if !ok || sample.totalBytes <= 0 {
		return unavailableItem("memory", memoryLabel, memoryUnsupportedMessage)
	}
	used := sample.usedBytes
	if used < 0 {
		used = 0
	}
	if used > sample.totalBytes {
		used = sample.totalBytes
	}
	return memoryItem(used, sample.totalBytes)
}

// 磁盘项；挂载点读取失败只降级该项，保留其展示别名。
func collectDisk(target DiskTarget) ResourceItem {
	sample := readDiskSample(target.Path)
	if !sample.ok {
		return unavailableItem("disk:"+target.Path, diskLabel(target), sample.message)
	}
	return diskItem(target, sample)
}

// 磁盘项的展示标签：有别名用别名，根路径固定「磁盘」，其余用路径原样输出。
func diskLabel(target DiskTarget) string {
	if label := strings.TrimSpace(target.Label); label != "" {
		return label
	}
	if target.Path == "/" {
		return rootDiskFallback
	}
	return target.Path
}

// 两拍时间片的差值算占用；计数器未前进或回绕时按 0 处理，不输出负值。
func cpuItem(previous, current cpuTimes) ResourceItem {
	idleDelta := int64(current.idle) - int64(previous.idle)
	totalDelta := int64(current.total) - int64(previous.total)
	percent := 0.0
	if totalDelta > 0 && idleDelta >= 0 {
		percent = clampPercent((1 - float64(idleDelta)/float64(totalDelta)) * 100)
	}
	return ResourceItem{ID: "cpu", Label: cpuLabel, Percent: &percent}
}

// 内存项同时给出占用比例与字节数，比例保留一位小数。
func memoryItem(usedBytes, totalBytes int64) ResourceItem {
	percent := clampPercent(float64(usedBytes) / float64(totalBytes) * 100)
	return ResourceItem{
		ID:         "memory",
		Label:      memoryLabel,
		Percent:    &percent,
		UsedBytes:  &usedBytes,
		TotalBytes: &totalBytes,
	}
}

// 磁盘项；比例按可用块与总块数算，与字节数口径一致。
func diskItem(target DiskTarget, sample diskSample) ResourceItem {
	percent := clampPercent(sample.percent)
	used := sample.usedBytes
	total := sample.totalBytes
	return ResourceItem{
		ID:         "disk:" + target.Path,
		Label:      diskLabel(target),
		Percent:    &percent,
		UsedBytes:  &used,
		TotalBytes: &total,
	}
}

// 降级项：不带 percent，只带 status 与原因。
func unavailableItem(id, label, message string) ResourceItem {
	status := StatusUnavailable
	return ResourceItem{ID: id, Label: label, Status: &status, Message: &message}
}

// 比例夹到 0–100；非有限值按 0 处理。
func clampPercent(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

// 可被取消的等待，用于冷启动补拍之间让出执行权。
func sleepWithContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// ParseResourcesTarget 解析资源组件选项，兼容磁盘字段的字符串、数组与对象三种写法。
// 结构不是映射时返回 false，调用方按配置无效处理。
func ParseResourcesTarget(options any) (ResourcesTarget, bool) {
	doc, ok := asObject(options)
	if !ok {
		return ResourcesTarget{}, false
	}
	target := ResourcesTarget{
		CPU:    boolFlag(doc["cpu"], true),
		Memory: boolFlag(doc["memory"], true),
	}
	// 与配置加载一致：disks 优先，其次 diskPaths、diskPath、disk
	for _, key := range []string{"disks", "diskPaths", "diskPath", "disk"} {
		target.Disks = mergeDisks(target.Disks, parseDiskEntries(doc[key]))
	}
	return target, true
}

// 布尔开关：缺省取默认值，字符串与数字按常见真值写法识别。
func boolFlag(raw any, fallback bool) bool {
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
	case float64:
		if value == 1 {
			return true
		}
		if value == 0 {
			return false
		}
	}
	return fallback
}

// 把一个磁盘字段展开成条目列表；未知类型返回空。
func parseDiskEntries(raw any) []DiskTarget {
	switch value := raw.(type) {
	case nil:
		return nil
	case string:
		return parseDiskString(value)
	case []any:
		entries := make([]DiskTarget, 0, len(value))
		for _, item := range value {
			entries = append(entries, parseDiskEntries(item)...)
		}
		return entries
	}
	if doc, ok := asObject(raw); ok {
		if entry, ok := parseDiskObject(doc); ok {
			return []DiskTarget{entry}
		}
	}
	return nil
}

// 单个字符串可含逗号分隔的多条「路径|别名」。
func parseDiskString(raw string) []DiskTarget {
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '，' })
	if len(parts) == 0 {
		parts = []string{raw}
	}
	entries := make([]DiskTarget, 0, len(parts))
	for _, part := range parts {
		if entry, ok := parseDiskEntry(part); ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

// 解析「路径」「路径|别名」「路径:别名」；Windows 盘符的单字母左侧不当作别名分隔。
func parseDiskEntry(raw string) (DiskTarget, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return DiskTarget{}, false
	}
	if pipe := strings.Index(trimmed, "|"); pipe > 0 {
		path := strings.TrimSpace(trimmed[:pipe])
		if path == "" {
			return DiskTarget{}, false
		}
		return DiskTarget{Path: path, Label: strings.TrimSpace(trimmed[pipe+1:])}, true
	}
	if colon := strings.IndexAny(trimmed, ":："); colon > 0 {
		left := strings.TrimSpace(trimmed[:colon])
		right := strings.TrimSpace(trimmed[colon+1:])
		// 单字母左侧按盘符处理，保留完整路径不加别名
		if !(len(left) == 1 && isASCIILetter(left[0])) {
			if left == "" {
				return DiskTarget{}, false
			}
			return DiskTarget{Path: left, Label: right}, true
		}
	}
	return DiskTarget{Path: trimmed}, true
}

// 对象形态：path 兼容 disk/mount，别名兼容 label/name/alias。
func parseDiskObject(doc map[string]any) (DiskTarget, bool) {
	path := strings.TrimSpace(firstText(doc, "path", "disk", "mount"))
	if path == "" {
		return DiskTarget{}, false
	}
	return DiskTarget{Path: path, Label: strings.TrimSpace(firstText(doc, "label", "name", "alias"))}, true
}

// 按顺序取第一个非空字符串字段。
func firstText(doc map[string]any, keys ...string) string {
	for _, key := range keys {
		if text, ok := doc[key].(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}

// 合并磁盘条目：同一路径只保留一条，后出现的别名覆盖先前的。
func mergeDisks(existing, addition []DiskTarget) []DiskTarget {
	for _, entry := range addition {
		replaced := false
		for index := range existing {
			if existing[index].Path != entry.Path {
				continue
			}
			if strings.TrimSpace(entry.Label) != "" {
				existing[index].Label = entry.Label
			}
			replaced = true
			break
		}
		if !replaced {
			existing = append(existing, entry)
		}
	}
	return existing
}

// ASCII 字母判定，用于识别 Windows 盘符。
func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}
