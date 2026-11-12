// Package webdist 是前端产物的嵌入目录。
// 真实产物由 go generate 从 apps/web/dist 同步而来；未同步时本包只保留占位文件，
// 服务运行期对静态请求一律返回 404。
package webdist
