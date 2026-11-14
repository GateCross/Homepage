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
