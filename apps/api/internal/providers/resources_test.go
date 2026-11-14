package providers

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// 资源项可用时给出 percent 与字节数，降级时给出 status 与 message，两组字段不混用。
func TestResourceItemShape(t *testing.T) {
	available := memoryItem(512, 2048)
	encoded, err := json.Marshal(available)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if !strings.Contains(string(encoded), `"percent":25`) {
		t.Errorf("可用项缺少 percent：%s", encoded)
	}
	if strings.Contains(string(encoded), `"status"`) || strings.Contains(string(encoded), `"message"`) {
		t.Errorf("可用项不该带降级字段：%s", encoded)
	}

	degraded := unavailableItem("cpu", cpuLabel, cpuUnsupportedMessage)
	encoded, err = json.Marshal(degraded)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if !strings.Contains(string(encoded), `"status":"unavailable"`) {
		t.Errorf("降级项缺少 status：%s", encoded)
	}
	if strings.Contains(string(encoded), `"percent"`) {
		t.Errorf("降级项不该带 percent：%s", encoded)
	}
}

// 降级项的文案不得为空，否则前端契约校验不过。
func TestUnavailableItemMessage(t *testing.T) {
	item := unavailableItem("disk:/nope", "/nope", diskMissingMessage)
	if item.Message == nil || *item.Message == "" {
		t.Fatal("降级文案为空")
	}
	if item.Status == nil || *item.Status != StatusUnavailable {
		t.Fatalf("status 为 %v，期望 %q", item.Status, StatusUnavailable)
	}
	if item.Percent != nil || item.UsedBytes != nil || item.TotalBytes != nil {
		t.Fatalf("降级项带了可用字段：%+v", item)
	}
}

// 比例夹在 0–100，非有限值按 0 处理。
func TestClampPercent(t *testing.T) {
	cases := []struct {
		in   float64
		want float64
	}{
		{-5, 0},
		{0, 0},
		{42.5, 42.5},
		{100, 100},
		{140, 100},
	}
	for _, testCase := range cases {
		if got := clampPercent(testCase.in); got != testCase.want {
			t.Errorf("%v 夹取为 %v，期望 %v", testCase.in, got, testCase.want)
		}
	}
}

// CPU 差值：上一拍与当前拍相同视为 0 占用，计数器回绕也不产生负值。
func TestCPUItem(t *testing.T) {
	item := cpuItem(cpuTimes{idle: 100, total: 200}, cpuTimes{idle: 150, total: 400})
	if item.Percent == nil {
		t.Fatal("CPU 项缺少 percent")
	}
	if got := *item.Percent; got != 75 {
		t.Errorf("占用为 %v，期望 75", got)
	}
	if item.ID != "cpu" || item.Label != cpuLabel {
		t.Errorf("CPU 项标识异常：%+v", item)
	}

	// 计数器回绕时按 0 处理，不输出负值
	item = cpuItem(cpuTimes{idle: 400, total: 800}, cpuTimes{idle: 100, total: 200})
	if item.Percent == nil || *item.Percent != 0 {
		t.Errorf("回绕占用为 %v，期望 0", item.Percent)
	}
}

// 采集结果顺序固定为 CPU、内存、磁盘，且磁盘标签遵循别名与根路径规则。
func TestCollectOrderAndLabels(t *testing.T) {
	client := NewResourcesClient(ResourcesClientOptions{
		Timeout: time.Second,
		SeedGap: time.Millisecond,
	})
	result := client.Collect(context.Background(), ResourcesTarget{
		CPU:    true,
		Memory: true,
		Disks: []DiskTarget{
			{Path: "/", Label: ""},
			{Path: "/data", Label: "数据盘"},
		},
	})
	if len(result.Items) != 4 {
		t.Fatalf("项数为 %d，期望 4：%+v", len(result.Items), result.Items)
	}
	wantIDs := []string{"cpu", "memory", "disk:/", "disk:/data"}
	for index, want := range wantIDs {
		if result.Items[index].ID != want {
			t.Errorf("第 %d 项 id 为 %q，期望 %q", index, result.Items[index].ID, want)
		}
	}
	if result.Items[2].Label != rootDiskFallback {
		t.Errorf("根路径标签为 %q，期望 %q", result.Items[2].Label, rootDiskFallback)
	}
	if result.Items[3].Label != "数据盘" {
		t.Errorf("别名标签为 %q，期望数据盘", result.Items[3].Label)
	}
}

// 资源采集在任何平台都产出合法形态：可用项带 percent，降级项带非空文案，两组字段不混用。
func TestCollectOnEveryPlatform(t *testing.T) {
	client := NewResourcesClient(ResourcesClientOptions{
		Timeout: time.Second,
		SeedGap: time.Millisecond,
	})
	result := client.Collect(context.Background(), ResourcesTarget{
		CPU:    true,
		Memory: true,
		Disks:  []DiskTarget{{Path: "/", Label: ""}},
	})
	if len(result.Items) != 3 {
		t.Fatalf("项数为 %d，期望 3", len(result.Items))
	}
	for _, item := range result.Items {
		hasPercent := item.Percent != nil
		hasMessage := item.Status != nil && item.Message != nil && *item.Message != ""
		if hasPercent == hasMessage {
			t.Errorf("%s 应当二选一：可用项带 percent，降级项带文案：%+v", item.ID, item)
		}
		if hasMessage && *item.Status != StatusUnavailable {
			t.Errorf("%s 降级项 status 为 %q", item.ID, *item.Status)
		}
	}
}

// 关闭 CPU 与内存时不产生对应项。
func TestCollectRespectsFlags(t *testing.T) {
	client := NewResourcesClient(ResourcesClientOptions{Timeout: time.Second, SeedGap: time.Millisecond})
	result := client.Collect(context.Background(), ResourcesTarget{CPU: false, Memory: false})
	if len(result.Items) != 0 {
		t.Fatalf("项数为 %d，期望 0：%+v", len(result.Items), result.Items)
	}
}

// 磁盘采样失败时只降级该项，别名与 id 都保留。
func TestCollectDiskFailureIsUnavailable(t *testing.T) {
	client := NewResourcesClient(ResourcesClientOptions{Timeout: time.Second, SeedGap: time.Millisecond})
	missing := "/definitely-not-exists-homepage"
	result := client.Collect(context.Background(), ResourcesTarget{
		Disks: []DiskTarget{{Path: missing, Label: "缺失盘"}},
	})
	if len(result.Items) != 1 {
		t.Fatalf("项数为 %d，期望 1", len(result.Items))
	}
	item := result.Items[0]
	if item.Status == nil || *item.Status != StatusUnavailable {
		t.Fatalf("缺失磁盘未降级：%+v", item)
	}
	if item.ID != "disk:"+missing {
		t.Errorf("id 为 %q，期望 %q", item.ID, "disk:"+missing)
	}
	if item.Label != "缺失盘" {
		t.Errorf("标签为 %q，期望缺失盘", item.Label)
	}
	if item.Message == nil || *item.Message == "" {
		t.Error("缺失磁盘缺少文案")
	}
}

// 资源选项解析：缺省开关为真，磁盘字段兼容字符串、数组与对象三种写法。
func TestParseResourcesTarget(t *testing.T) {
	target, ok := ParseResourcesTarget(map[string]any{
		"cpu":    false,
		"disks":  []any{"/a|别名甲", map[string]any{"path": "/b", "label": "乙"}},
		"memory": "no",
	})
	if !ok {
		t.Fatal("合法选项被拒绝")
	}
	if target.CPU || target.Memory {
		t.Errorf("开关为 cpu=%v memory=%v，期望均为假", target.CPU, target.Memory)
	}
	if len(target.Disks) != 2 {
		t.Fatalf("磁盘条数为 %d，期望 2：%+v", len(target.Disks), target.Disks)
	}
	if target.Disks[0].Path != "/a" || target.Disks[0].Label != "别名甲" {
		t.Errorf("首条磁盘解析异常：%+v", target.Disks[0])
	}
	if target.Disks[1].Path != "/b" || target.Disks[1].Label != "乙" {
		t.Errorf("次条磁盘解析异常：%+v", target.Disks[1])
	}
}

// 磁盘字段的字符串写法：逗号分隔多个挂载点，重复路径只保留一条。
func TestParseResourcesTargetDiskString(t *testing.T) {
	target, ok := ParseResourcesTarget(map[string]any{
		"disk": "/，/data:数据盘，/",
	})
	if !ok {
		t.Fatal("合法选项被拒绝")
	}
	if len(target.Disks) != 2 {
		t.Fatalf("磁盘条数为 %d，期望 2：%+v", len(target.Disks), target.Disks)
	}
	if target.Disks[0].Path != "/" || target.Disks[1].Label != "数据盘" {
		t.Errorf("磁盘解析异常：%+v", target.Disks)
	}
}

// Windows 盘符里的单个字母不当作别名分隔符。
func TestParseDiskEntryKeepsWindowsDrive(t *testing.T) {
	entry, ok := parseDiskEntry(`C:\data`)
	if !ok {
		t.Fatal("盘符路径被拒绝")
	}
	if entry.Path != `C:\data` || entry.Label != "" {
		t.Errorf("解析为 %+v，期望原样保留", entry)
	}
}

// 选项不是映射时报错，由调用方按配置无效处理。
func TestParseResourcesTargetRejectsNonObject(t *testing.T) {
	for _, raw := range []any{nil, "x", []any{}, 3} {
		if _, ok := ParseResourcesTarget(raw); ok {
			t.Errorf("输入 %v 未被拒绝", raw)
		}
	}
}
