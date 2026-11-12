package docker

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/gatecross/homepage/api/internal/domain"
)

// 容器列表的固定参数。
const (
	// listAllPath 取全部容器（含已停止）；只读白名单里唯一带查询的列表路径。
	listAllPath = "/containers/json?all=true"
	// listNameIDLength 是容器没有名称时取自 ID 前缀的长度。
	listNameIDLength = 12
	// listStatusMaxRunes 是状态文案的展示上限，超出追加省略号。
	listStatusMaxRunes = 80
	// listPortsLimit 是单容器最多展示的端口条数。
	listPortsLimit = 8
)

// 查询端点上的全部容器摘要。
// 未登记端点不会走到这里；失败按 Docker 侧错误原样返回，由调用方映射成错误码。
func (c *Client) List(ctx context.Context) ([]domain.DockerContainerSummary, error) {
	resp, err := c.request(ctx, listAllPath)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &Error{Kind: KindOther, Message: "Docker 接口返回错误"}
	}

	var payload any
	if err := json.Unmarshal(resp.Body, &payload); err != nil {
		return nil, &Error{Kind: KindInvalid, Message: "Docker 返回了无效 JSON"}
	}
	return mapListPayload(payload), nil
}

// 把列表报文映射为摘要；同名容器只保留第一条，结果按名称排序。
func mapListPayload(payload any) []domain.DockerContainerSummary {
	rows, ok := payload.([]any)
	if !ok {
		return []domain.DockerContainerSummary{}
	}

	summaries := make([]domain.DockerContainerSummary, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		summary, ok := mapListRow(row)
		if !ok {
			continue
		}
		if _, duplicated := seen[summary.Name]; duplicated {
			continue
		}
		seen[summary.Name] = struct{}{}
		summaries = append(summaries, summary)
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].Name < summaries[j].Name })
	return summaries
}

// 单行映射：名称取不到即丢弃该行，其余字段缺失只让对应字段消失。
func mapListRow(raw any) (domain.DockerContainerSummary, bool) {
	row, ok := raw.(map[string]any)
	if !ok {
		return domain.DockerContainerSummary{}, false
	}

	name, ok := pickContainerName(row["Names"], row["Id"])
	if !ok {
		return domain.DockerContainerSummary{}, false
	}
	summary := domain.DockerContainerSummary{Name: name, State: mapListState(row["State"])}

	if image, ok := stringValue(row, "Image"); ok && image != "" {
		summary.Image = strPtr(image)
	}
	if statusText, ok := stringValue(row, "Status"); ok && statusText != "" {
		text := truncateRunes(statusText, listStatusMaxRunes)
		summary.StatusText = &text
		if health, ok := listHealth(text); ok {
			summary.Health = &health
		}
	}
	if ports := mapListPorts(row["Ports"]); len(ports) > 0 {
		summary.Ports = ports
	}
	return summary, true
}

// 名称优先取 Names 首项并去掉开头的斜杠；数组缺失时退回容器 ID 的前 12 位。
func pickContainerName(names any, id any) (string, bool) {
	if list, ok := names.([]any); ok {
		for _, entry := range list {
			text, isString := entry.(string)
			if !isString {
				continue
			}
			trimmed := strings.TrimLeft(strings.TrimSpace(text), "/")
			if trimmed != "" {
				return trimmed, true
			}
		}
	}
	if text, ok := id.(string); ok {
		trimmed := strings.TrimSpace(text)
		if len(trimmed) > listNameIDLength {
			trimmed = trimmed[:listNameIDLength]
		}
		if trimmed != "" {
			return trimmed, true
		}
	}
	return "", false
}

// 列表状态只认契约里的取值，其余归入 other。
func mapListState(raw any) string {
	text, ok := raw.(string)
	if !ok {
		return domain.DockerListStateOther
	}
	switch strings.ToLower(strings.TrimSpace(text)) {
	case domain.DockerStatusRunning:
		return domain.DockerStatusRunning
	case domain.DockerStatusRestarting:
		return domain.DockerStatusRestarting
	case domain.DockerStatusPaused:
		return domain.DockerStatusPaused
	case "created", "removing":
		return domain.DockerStatusStarting
	case "exited", "dead", "stopped":
		return domain.DockerStatusStopped
	}
	return domain.DockerListStateOther
}

// 健康状态只从列表状态文案里的括号标注推断。
func listHealth(statusText string) (string, bool) {
	lower := strings.ToLower(statusText)
	switch {
	case strings.Contains(lower, "(healthy)"):
		return domain.DockerHealthHealthy, true
	case strings.Contains(lower, "(unhealthy)"):
		return domain.DockerHealthUnhealthy, true
	case strings.Contains(lower, "(health: starting)"), strings.Contains(lower, "(starting)"):
		return domain.DockerHealthStarting, true
	}
	return "", false
}

// 端口展示为「公网:私网/协议」或「私网/协议」；缺私网端口的条目跳过，最多 8 条。
func mapListPorts(raw any) []string {
	rows, ok := raw.([]any)
	if !ok {
		return nil
	}

	ports := make([]string, 0, listPortsLimit)
	for _, entry := range rows {
		row, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		privatePort, ok := row["PrivatePort"].(float64)
		if !ok {
			continue
		}
		protocol, ok := row["Type"].(string)
		if !ok || strings.TrimSpace(protocol) == "" {
			protocol = "tcp"
		}

		privateText := strconv.FormatInt(int64(privatePort), 10)
		if publicPort, ok := row["PublicPort"].(float64); ok {
			ports = append(ports, strconv.FormatInt(int64(publicPort), 10)+":"+privateText+"/"+protocol)
		} else {
			ports = append(ports, privateText+"/"+protocol)
		}
		if len(ports) >= listPortsLimit {
			break
		}
	}
	return ports
}

// 按字符数截断，超出时追加省略号。
func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}
