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
		return diskSample{message: diskGeneralMessage}
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
