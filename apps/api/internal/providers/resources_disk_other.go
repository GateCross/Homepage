//go:build !unix

package providers

// 非 unix 平台没有 statfs 的统一等价口径，磁盘采集降级；
// CPU 与内存仍由 gopsutil 提供，见 resources_sample.go。

// 磁盘采样不可用。
func readDiskSample(string) diskSample {
	return diskSample{message: diskUnsupportedMessage}
}
