package adapters

import (
	"math"
	"testing"
)

func TestScaleByteRateUnits(t *testing.T) {
	cases := []struct {
		input      float64
		wantValue  float64
		wantUnit   string
		descriptor string
	}{
		{0, 0, "B/s", "零值保持字节"},
		{512, 512, "B/s", "不足 1000 保持字节"},
		{1000, 1, "KB/s", "1000 进位到 KB"},
		{1500, 1.5, "KB/s", "保留 1 位小数"},
		{1024, 1, "KB/s", "按 1000 进位而非 1024"},
		{1_000_000, 1, "MB/s", "进位到 MB"},
		{1_234_567, 1.2, "MB/s", "四舍五入到 1 位"},
		{999_999_999, 1000, "MB/s", "未到 1000 不进位"},
		{1_000_000_000, 1, "GB/s", "进位到 GB"},
		{1e15, 1, "PB/s", "最大单位不再放大"},
		{1e18, 1000, "PB/s", "超出最大单位时封顶"},
	}

	for _, testCase := range cases {
		got := ScaleByteRate(testCase.input)
		if got.Unit != testCase.wantUnit {
			t.Fatalf("%s：单位应为 %q，实得 %q", testCase.descriptor, testCase.wantUnit, got.Unit)
		}
		if math.Abs(got.Value-testCase.wantValue) > 1e-9 {
			t.Fatalf("%s：数值应为 %v，实得 %v", testCase.descriptor, testCase.wantValue, got.Value)
		}
	}
}

func TestScaleByteRateNormalizesBadInput(t *testing.T) {
	for _, input := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		got := ScaleByteRate(input)
		if got.Value != 0 || got.Unit != "B/s" {
			t.Fatalf("非法输入 %v 应回零值，实得 %+v", input, got)
		}
	}
}

func TestScaleByteRateKeepsOneDecimal(t *testing.T) {
	// 前端直接展示数值与单位，小数位不能串到 2 位
	got := ScaleByteRate(12_345_678)
	if got.Unit != "MB/s" {
		t.Fatalf("单位应为 MB/s，实得 %q", got.Unit)
	}
	if got.Value != 12.3 {
		t.Fatalf("应保留 1 位小数，实得 %v", got.Value)
	}
}

func TestScaleBytesUnits(t *testing.T) {
	cases := []struct {
		input     float64
		wantValue float64
		wantUnit  string
	}{
		{0, 0, "B"},
		{999, 999, "B"},
		{1000, 1, "KB"},
		{2_500_000, 2.5, "MB"},
		{1_099_511_627_776, 1.1, "TB"},
		{1e18, 1000, "PB"},
	}

	for _, testCase := range cases {
		got := ScaleBytes(testCase.input)
		if got.Unit != testCase.wantUnit {
			t.Fatalf("%v 单位应为 %q，实得 %q", testCase.input, testCase.wantUnit, got.Unit)
		}
		if math.Abs(got.Value-testCase.wantValue) > 1e-9 {
			t.Fatalf("%v 数值应为 %v，实得 %v", testCase.input, testCase.wantValue, got.Value)
		}
	}
}

func TestScaleBytesKeepsTwoDecimals(t *testing.T) {
	got := ScaleBytes(1_234_567)
	if got.Value != 1.23 {
		t.Fatalf("字节缩放应保留 2 位小数，实得 %v", got.Value)
	}
}

func TestRoundTo(t *testing.T) {
	cases := []struct {
		value  float64
		digits int
		want   float64
	}{
		{1.2345, 2, 1.23},
		{1.2355, 2, 1.24},
		{1.5, 0, 2},
		{1.4, 0, 1},
		{-1.2345, 2, -1.23},
		{math.NaN(), 2, 0},
		{math.Inf(1), 2, 0},
	}

	for _, testCase := range cases {
		if got := RoundTo(testCase.value, testCase.digits); math.Abs(got-testCase.want) > 1e-9 {
			t.Fatalf("RoundTo(%v, %d) 应为 %v，实得 %v", testCase.value, testCase.digits, testCase.want, got)
		}
	}
}

func TestFormatDurationSeconds(t *testing.T) {
	cases := []struct {
		input float64
		want  string
	}{
		{0, "0秒"},
		{5, "5秒"},
		{59, "59秒"},
		{60, "1分0秒"},
		{125, "2分5秒"},
		{3600, "1小时0分0秒"},
		{3725, "1小时2分5秒"},
		{-10, "0秒"},
		{math.NaN(), "0秒"},
	}

	for _, testCase := range cases {
		if got := FormatDurationSeconds(testCase.input); got != testCase.want {
			t.Fatalf("FormatDurationSeconds(%v) 应为 %q，实得 %q", testCase.input, testCase.want, got)
		}
	}
}

func TestCoerceFiniteNumber(t *testing.T) {
	successes := map[string]struct {
		input any
		want  float64
	}{
		"浮点":   {1.5, 1.5},
		"整数":   {3, 3},
		"长整数":  {int64(7), 7},
		"布尔真":  {true, 1},
		"布尔假":  {false, 0},
		"数字串":  {"12.5", 12.5},
		"带空白串": {"  42  ", 42},
	}

	for name, testCase := range successes {
		got, ok := CoerceFiniteNumber(testCase.input)
		if !ok {
			t.Fatalf("%s：应解析成功", name)
		}
		if math.Abs(got-testCase.want) > 1e-9 {
			t.Fatalf("%s：应为 %v，实得 %v", name, testCase.want, got)
		}
	}

	failures := map[string]any{
		"空串":  "",
		"空白串": "   ",
		"非数字": "abc",
		"对象":  map[string]any{"a": 1},
		"数组":  []any{1},
		"nil": nil,
		"NaN": math.NaN(),
	}

	for name, input := range failures {
		if _, ok := CoerceFiniteNumber(input); ok {
			t.Fatalf("%s：应解析失败", name)
		}
	}
}

func TestFormatPercentValue(t *testing.T) {
	if got, ok := FormatPercentValue(150); !ok || got != 100 {
		t.Fatalf("超百应夹到 100，实得 %v（ok=%v）", got, ok)
	}
	if got, ok := FormatPercentValue(-5); !ok || got != 0 {
		t.Fatalf("负数应夹到 0，实得 %v（ok=%v）", got, ok)
	}
	if got, ok := FormatPercentValue("42.5"); !ok || got != 42.5 {
		t.Fatalf("数字串应解析，实得 %v（ok=%v）", got, ok)
	}
	if _, ok := FormatPercentValue("abc"); ok {
		t.Fatal("非数字应解析失败")
	}
}

func TestClampPercent(t *testing.T) {
	if got := ClampPercent(50); got != 50 {
		t.Fatalf("区间内应原样返回，实得 %v", got)
	}
	if got := ClampPercent(-1); got != 0 {
		t.Fatalf("负值应夹到 0，实得 %v", got)
	}
	if got := ClampPercent(101); got != 100 {
		t.Fatalf("超百应夹到 100，实得 %v", got)
	}
	if got := ClampPercent(math.NaN()); got != 0 {
		t.Fatalf("NaN 应按 0 处理，实得 %v", got)
	}
}
