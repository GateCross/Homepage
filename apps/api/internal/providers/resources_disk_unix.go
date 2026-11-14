//go:build unix

package providers

import (
	"errors"
	"syscall"
)

// 用 statfs 统计挂载点；失败按 errno 归类成可外传的降级文案。
func readDiskSample(path string) diskSample {
	var stats syscall.Statfs_t
	if err := syscall.Statfs(path, &stats); err != nil {
		return diskSample{message: diskErrorMessage(err)}
	}
	return computeDiskSample(int64(stats.Bsize), int64(stats.Blocks), int64(stats.Bavail))
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
