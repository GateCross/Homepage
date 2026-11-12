package providers

import (
	"strconv"
	"strings"
)

// /proc/stat 与 /proc/meminfo 的文本解析放在平台无关文件里，
// 非 Linux 平台也能覆盖解析口径，采样本身仍由各平台文件提供。

// 解析 cpu 汇总行，idle 含 iowait，其余各列都计入总量。
// 各列顺序固定为 user nice system idle iowait irq softirq steal 等。
func parseProcStatCPU(line string) (cpuTimes, bool) {
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuTimes{}, false
	}
	var idle, total uint64
	for index, text := range fields[1:] {
		value, err := strconv.ParseUint(text, 10, 64)
		if err != nil {
			return cpuTimes{}, false
		}
		total += value
		// 第 4、5 列分别是 idle 与 iowait
		if index == 3 || index == 4 {
			idle += value
		}
	}
	if total == 0 {
		return cpuTimes{}, false
	}
	return cpuTimes{idle: idle, total: total}, true
}

// 解析 meminfo 的一行「键: 值 kB」，键名归一成带冒号的形式，值统一为 kB。
func parseMeminfoLine(line string) (string, int64, bool) {
	key, rest, found := strings.Cut(line, ":")
	if !found {
		return "", 0, false
	}
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return "", 0, false
	}
	value, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || value < 0 {
		return "", 0, false
	}
	return strings.TrimSpace(key) + ":", value, true
}

// 从 meminfo 各行算内存占用：总量取 MemTotal，可用量优先 MemAvailable，
// 缺 MemAvailable 时退回 MemFree，口径偏大但仍可用。
func memoryFromMeminfo(lines []string) (memorySample, bool) {
	var totalKB, availableKB, freeKB int64
	haveAvailable := false
	for _, line := range lines {
		key, valueKB, ok := parseMeminfoLine(line)
		if !ok {
			continue
		}
		switch key {
		case "MemTotal:":
			totalKB = valueKB
		case "MemAvailable:":
			availableKB = valueKB
			haveAvailable = true
		case "MemFree:":
			freeKB = valueKB
		}
	}
	if totalKB <= 0 {
		return memorySample{}, false
	}
	if !haveAvailable {
		availableKB = freeKB
	}
	usedKB := totalKB - availableKB
	if usedKB < 0 {
		usedKB = 0
	}
	return memorySample{usedBytes: usedKB * 1024, totalBytes: totalKB * 1024}, true
}

// 由 statfs 的块大小、总块数与可用块数算占用：比例按可用块算，字节数按块大小换算。
// 计数非法时返回带通用文案的降级结果。
func computeDiskSample(blockSize, totalBlocks, availableBlocks int64) diskSample {
	if blockSize <= 0 || totalBlocks <= 0 {
		return diskSample{message: diskGeneralMessage}
	}
	if availableBlocks < 0 {
		availableBlocks = 0
	}
	if availableBlocks > totalBlocks {
		availableBlocks = totalBlocks
	}
	totalBytes := totalBlocks * blockSize
	freeBytes := availableBlocks * blockSize
	return diskSample{
		ok:         true,
		percent:    (1 - float64(availableBlocks)/float64(totalBlocks)) * 100,
		usedBytes:  totalBytes - freeBytes,
		totalBytes: totalBytes,
	}
}
