package adapters

import (
	"math"
	"strconv"
	"strings"
)

// 字节与速率的单位表，按 1000 进位，与前端展示口径一致。
var (
	byteUnits = []string{"B", "KB", "MB", "GB", "TB", "PB"}
	rateUnits = []string{"B/s", "KB/s", "MB/s", "GB/s", "TB/s", "PB/s"}
)

// ScaledUnitValue 是缩放后的数值与单位，直接落到指标的 value 与 unit 上。
type ScaledUnitValue struct {
	Value float64
	Unit  string
}

// RoundTo 四舍五入到指定小数位；非有限值按 0 处理，digits 小于等于 0 时取整。
func RoundTo(value float64, digits int) float64 {
	if !isFiniteNumber(value) {
		return 0
	}
	if digits <= 0 {
		return math.Round(value)
	}
	factor := math.Pow(10, float64(digits))
	return math.Round(value*factor) / factor
}

// ScaleBytes 把字节数缩放到合适单位并保留 2 位小数；负数与非有限值按 0 处理。
func ScaleBytes(bytes float64) ScaledUnitValue {
	return scaleByUnits(bytes, byteUnits, 2)
}

// ScaleByteRate 把每秒字节数缩放到合适单位并保留 1 位小数；负数与非有限值按 0 处理。
func ScaleByteRate(bytesPerSecond float64) ScaledUnitValue {
	return scaleByUnits(bytesPerSecond, rateUnits, 1)
}

// 按单位表逐级缩放，到最大单位即停。
func scaleByUnits(value float64, units []string, digits int) ScaledUnitValue {
	scaled := value
	if !isFiniteNumber(scaled) || scaled < 0 {
		scaled = 0
	}
	index := 0
	for scaled >= 1000 && index < len(units)-1 {
		scaled /= 1000
		index++
	}
	return ScaledUnitValue{Value: RoundTo(scaled, digits), Unit: units[index]}
}

// FormatDurationSeconds 把秒数格式化成中文时长，只到秒；负数与非有限值按 0 秒。
func FormatDurationSeconds(seconds float64) string {
	value := seconds
	if !isFiniteNumber(value) || value < 0 {
		value = 0
	}
	total := int64(math.Floor(value))
	hours := total / 3600
	minutes := (total % 3600) / 60
	remain := total % 60

	if hours > 0 {
		return strconv.FormatInt(hours, 10) + "小时" +
			strconv.FormatInt(minutes, 10) + "分" +
			strconv.FormatInt(remain, 10) + "秒"
	}
	if minutes > 0 {
		return strconv.FormatInt(minutes, 10) + "分" +
			strconv.FormatInt(remain, 10) + "秒"
	}
	return strconv.FormatInt(remain, 10) + "秒"
}

// CoerceFiniteNumber 把取值转成有限数值：数值原样、布尔转 1/0、数字字符串按十进制解析。
// 空串、空白串、非数字字符串、对象与数组都返回 false。
func CoerceFiniteNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if isFiniteNumber(typed) {
			return typed, true
		}
	case float32:
		converted := float64(typed)
		if isFiniteNumber(converted) {
			return converted, true
		}
	case int:
		return float64(typed), true
	case int8:
		return float64(typed), true
	case int16:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case uint:
		return float64(typed), true
	case uint8:
		return float64(typed), true
	case uint16:
		return float64(typed), true
	case uint32:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	case string:
		return parseFiniteNumber(typed)
	}
	return 0, false
}

// FormatPercentValue 把取值转成 0–100 的百分比；无法解析时返回 false，不伪造 0。
func FormatPercentValue(value any) (float64, bool) {
	number, ok := CoerceFiniteNumber(value)
	if !ok {
		return 0, false
	}
	return ClampPercent(number), true
}

// ClampPercent 把数值夹到 0–100；非有限值按 0 处理。
func ClampPercent(value float64) float64 {
	if !isFiniteNumber(value) {
		return 0
	}
	return math.Min(100, math.Max(0, value))
}

// isFiniteNumber 判断是否为有限浮点，供契约校验与格式化共用。
func isFiniteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// HasCJK 判断文本是否含至少一个中日韩统一表意文字（含扩展 A），用于校验中文标签。
func HasCJK(text string) bool {
	for _, char := range text {
		if char >= 0x3400 && char <= 0x9FFF {
			return true
		}
	}
	return false
}

// parseFiniteNumber 解析数字字符串；允许首尾空白，空串与非数字返回 false。
func parseFiniteNumber(text string) (float64, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || !isFiniteNumber(parsed) {
		return 0, false
	}
	return parsed, true
}
