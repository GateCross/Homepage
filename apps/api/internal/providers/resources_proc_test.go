package providers

import "testing"

// 由 statfs 的块计数算占用：比例按可用块算，字节数按块大小换算。
func TestComputeDiskSample(t *testing.T) {
	sample := computeDiskSample(1024, 1000, 400)
	if !sample.ok {
		t.Fatalf("样本被判定失败：%q", sample.message)
	}
	if sample.totalBytes != 1024*1000 {
		t.Errorf("总量为 %d，期望 %d", sample.totalBytes, 1024*1000)
	}
	if sample.usedBytes != 1024*600 {
		t.Errorf("已用为 %d，期望 %d", sample.usedBytes, 1024*600)
	}
	if sample.percent != 60 {
		t.Errorf("比例为 %v，期望 60", sample.percent)
	}
}

// 块大小或总块数为 0 时降级，不参与除法。
func TestComputeDiskSampleRejectsZeroCounts(t *testing.T) {
	for _, testCase := range []struct{ blockSize, total int64 }{
		{0, 1000},
		{-1, 1000},
		{1024, 0},
		{1024, -5},
	} {
		sample := computeDiskSample(testCase.blockSize, testCase.total, 0)
		if sample.ok {
			t.Errorf("块大小 %d 总块数 %d 未降级", testCase.blockSize, testCase.total)
		}
		if sample.message != diskGeneralMessage {
			t.Errorf("文案为 %q，期望 %q", sample.message, diskGeneralMessage)
		}
	}
}

// 可用块越界时夹到 0 与总块数之间，不产生负的已用量。
func TestComputeDiskSampleClampsAvailable(t *testing.T) {
	sample := computeDiskSample(512, 100, -20)
	if !sample.ok || sample.usedBytes != 100*512 {
		t.Errorf("负可用块下结果异常：%+v", sample)
	}
	sample = computeDiskSample(512, 100, 500)
	if !sample.ok || sample.usedBytes != 0 {
		t.Errorf("超量可用块下结果异常：%+v", sample)
	}
}

// /proc/stat 的 cpu 行：idle 与 iowait 都算空闲，其余列计入总量。
func TestParseProcStatCPU(t *testing.T) {
	// user nice system idle iowait irq softirq steal
	sample, ok := parseProcStatCPU("cpu  100 20 30 400 50 5 5 10 0 0")
	if !ok {
		t.Fatal("合法 cpu 行被拒绝")
	}
	if sample.idle != 450 {
		t.Errorf("空闲为 %d，期望 450", sample.idle)
	}
	if sample.total != 620 {
		t.Errorf("总量为 %d，期望 620", sample.total)
	}
}

// 非 cpu 行、列数不足、非数字与全零都要能识别出来。
func TestParseProcStatCPURejectsBadLine(t *testing.T) {
	for _, line := range []string{
		"",
		"cpu0 1 2 3 4",
		"intr 1 2 3 4 5",
		"cpu 1 2 3 x 5",
		"cpu 0 0 0 0 0",
	} {
		if _, ok := parseProcStatCPU(line); ok {
			t.Errorf("行 %q 未被拒绝", line)
		}
	}
}

// meminfo 解析：键名归一，单位统一为 kB。
func TestParseMeminfoLine(t *testing.T) {
	key, value, ok := parseMeminfoLine("MemTotal:       16318412 kB")
	if !ok || key != "MemTotal:" || value != 16318412 {
		t.Fatalf("解析为 %q %d（ok=%v）", key, value, ok)
	}
	for _, line := range []string{"", "MemTotal", "MemTotal:", "MemTotal: abc kB", "MemTotal: -1 kB"} {
		if _, _, ok := parseMeminfoLine(line); ok {
			t.Errorf("行 %q 未被拒绝", line)
		}
	}
}

// 内存占用优先用 MemAvailable，缺失时退回 MemFree。
func TestMemoryFromMeminfo(t *testing.T) {
	withAvailable := []string{
		"MemTotal:       8000000 kB",
		"MemFree:        1000000 kB",
		"MemAvailable:   3000000 kB",
	}
	sample, ok := memoryFromMeminfo(withAvailable)
	if !ok {
		t.Fatal("合法 meminfo 被拒绝")
	}
	if sample.totalBytes != 8000000*1024 {
		t.Errorf("总量为 %d", sample.totalBytes)
	}
	if sample.usedBytes != 5000000*1024 {
		t.Errorf("已用为 %d，期望 %d", sample.usedBytes, 5000000*1024)
	}

	withoutAvailable := []string{
		"MemTotal:       8000000 kB",
		"MemFree:        1000000 kB",
	}
	sample, ok = memoryFromMeminfo(withoutAvailable)
	if !ok {
		t.Fatal("缺 MemAvailable 时被拒绝")
	}
	if sample.usedBytes != 7000000*1024 {
		t.Errorf("已用为 %d，期望 %d", sample.usedBytes, 7000000*1024)
	}
}

// 缺 MemTotal 或可用量大于总量时分别降级与夹取。
func TestMemoryFromMeminfoEdgeCases(t *testing.T) {
	if _, ok := memoryFromMeminfo([]string{"MemFree: 1024 kB"}); ok {
		t.Error("缺 MemTotal 未降级")
	}
	sample, ok := memoryFromMeminfo([]string{
		"MemTotal:       1000 kB",
		"MemAvailable:   5000 kB",
	})
	if !ok || sample.usedBytes != 0 {
		t.Errorf("可用量超出总量时结果为 %+v", sample)
	}
}
