//go:build linux

package providers

import (
	"bufio"
	"errors"
	"os"
	"syscall"
)

// 采样源固定为内核导出的 proc 文件。
const (
	procStatPath    = "/proc/stat"
	procMeminfoPath = "/proc/meminfo"
)

// 读 /proc/stat 首行 cpu 汇总，idle 含 iowait，用户、系统、中断等都计入总量。
// CPU 时间片单位是 USER_HZ，差分只用比值，故不必换算成秒。
func readCPUTimes() (cpuTimes, bool) {
	file, err := os.Open(procStatPath)
	if err != nil {
		return cpuTimes{}, false
	}
	defer func() { _ = file.Close() }()

	scanner := bufio.NewScanner(file)
	var firstLine string
	for scanner.Scan() {
		firstLine = scanner.Text()
		break
	}
	if err := scanner.Err(); err != nil {
		return cpuTimes{}, false
	}
	return parseProcStatCPU(firstLine)
}

// 读 /proc/meminfo，占用按 MemTotal 与 MemAvailable 之差计算。
func readMemorySample() (memorySample, bool) {
	file, err := os.Open(procMeminfoPath)
	if err != nil {
		return memorySample{}, false
	}
	defer func() { _ = file.Close() }()

	var lines []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return memorySample{}, false
	}
	return memoryFromMeminfo(lines)
}

// 用 statfs 统计挂载点；失败按 errno 归类成可外传的降级文案。
func readDiskSample(path string) diskSample {
	var stats syscall.Statfs_t
	if err := syscall.Statfs(path, &stats); err != nil {
		return diskSample{message: diskErrorMessage(err)}
	}
	return computeDiskSample(int64(stats.Bsize), int64(stats.Blocks), int64(stats.Bavail))
}

// errno 到文案：路径不存在与权限不足单独区分，其余统一为读取失败。
func diskErrorMessage(err error) string {
	switch {
	case errors.Is(err, syscall.ENOENT):
		return diskMissingMessage
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return diskAccessMessage
	}
	return diskGeneralMessage
}
