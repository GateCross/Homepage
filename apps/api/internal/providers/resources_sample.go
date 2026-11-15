package providers

import (
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
)

// CPU 与内存采集交给 gopsutil：Linux 读 /proc/stat 与 /proc/meminfo，
// 其它平台读各自等价接口，解析口径由库统一维护，不再分平台手写。

// 读一次 CPU 时间片：idle 含 iowait，其余各列计入总量。
// 口径与 /proc/stat 的 cpu 汇总行一致；拿不到汇总样本即降级。
func readCPUTimes() (cpuTimes, bool) {
	stats, err := cpu.Times(false)
	if err != nil || len(stats) == 0 {
		return cpuTimes{}, false
	}
	aggregate := stats[0]
	idle := uint64(aggregate.Idle + aggregate.Iowait)
	total := uint64(aggregate.Total())
	if total == 0 {
		return cpuTimes{}, false
	}
	return cpuTimes{idle: idle, total: total}, true
}

// 读内存采样：占用按总量与可用量之差计算。
// Linux 上可用量即 MemAvailable，缺失时由 gopsutil 按内核能力回退，不再自行解析 meminfo。
func readMemorySample() (memorySample, bool) {
	memory, err := mem.VirtualMemory()
	if err != nil || memory.Total == 0 {
		return memorySample{}, false
	}
	available := memory.Available
	if available > memory.Total {
		available = memory.Total
	}
	return memorySample{
		usedBytes:  int64(memory.Total - available),
		totalBytes: int64(memory.Total),
	}, true
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

