//go:build !linux

package providers

// 非 Linux 平台没有 /proc 与 statfs 的等价口径，CPU 与内存一律降级，
// 磁盘仍可尝试读取，失败同样降级为 unavailable。

// 读不到 CPU 时间片即降级为不可用。
func readCPUTimes() (cpuTimes, bool) { return cpuTimes{}, false }

// 读不到内存总量即降级为不可用。
func readMemorySample() (memorySample, bool) { return memorySample{}, false }

// 非 Linux 平台不支持磁盘容量采集。
func readDiskSample(string) diskSample {
	return diskSample{message: diskUnsupportedMessage}
}
