package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 规范串字段分隔符与版本串：两者参与哈希，改动会让全部既有 ID 失效。
const (
	canonicalFieldSep     = "\u001f"
	canonicalVersion      = "v1"
	stableIDHashHexLength = 24
)

// ID 前缀按类型区分来源。
const (
	stableIDPrefixService  = "svc_"
	stableIDPrefixProbe    = "prb_"
	stableIDPrefixWidget   = "wgt_"
	stableIDPrefixInfo     = "inf_"
	stableIDPrefixBookmark = "bmk_"
)

// InfoIdentity 是信息组件参与身份的目标字段：按类型只取对应字段。
type InfoIdentity struct {
	Kind      string
	CityID    string
	DiskPaths []string
}

// stableIDInput 是类型前缀与规范串的组合，字段不导出，仅供本包内构造与测试。
type stableIDInput struct {
	kind      string
	canonical string
}

// BuildStableID 由类型前缀与规范串生成公开稳定 ID。
func BuildStableID(in stableIDInput) string {
	sum := sha256.Sum256([]byte(in.canonical))
	return stableIDPrefix(in.kind) + hex.EncodeToString(sum[:])[:stableIDHashHexLength]
}

// ServiceID 生成服务稳定 ID：身份为分组序号、条目序号与规范化后的 href。
func ServiceID(groupIndex, serviceIndex int, href string) string {
	canonical := joinCanonicalParts(
		canonicalVersion,
		"service",
		"services",
		strconv.Itoa(groupIndex),
		strconv.Itoa(serviceIndex),
		NormalizeAbsoluteHTTPURL(href),
	)
	return BuildStableID(stableIDInput{kind: "service", canonical: canonical})
}

// ProbeID 生成探测稳定 ID：身份为服务位置与规范化后的探测 URL。
func ProbeID(groupIndex, serviceIndex int, probeURL string) string {
	canonical := joinCanonicalParts(
		canonicalVersion,
		"probe",
		"services",
		strconv.Itoa(groupIndex),
		strconv.Itoa(serviceIndex),
		NormalizeAbsoluteHTTPURL(probeURL),
	)
	return BuildStableID(stableIDInput{kind: "probe", canonical: canonical})
}

// WidgetID 生成组件稳定 ID：身份为服务位置、组件序号、规范化类型与目标 URL。
func WidgetID(groupIndex, serviceIndex, widgetIndex int, widgetType, targetURL string) string {
	canonical := joinCanonicalParts(
		canonicalVersion,
		"widget",
		"services",
		strconv.Itoa(groupIndex),
		strconv.Itoa(serviceIndex),
		strconv.Itoa(widgetIndex),
		normalizeTypeToken(widgetType),
		NormalizeAbsoluteHTTPURL(targetURL),
	)
	return BuildStableID(stableIDInput{kind: "widget", canonical: canonical})
}

// InfoID 生成信息组件稳定 ID：身份为条目序号、规范化类型与目标身份。
func InfoID(entryIndex int, infoType string, identity InfoIdentity) string {
	canonical := joinCanonicalParts(
		canonicalVersion,
		"info",
		"widgets",
		strconv.Itoa(entryIndex),
		normalizeTypeToken(infoType),
		encodeInfoIdentity(identity),
	)
	return BuildStableID(stableIDInput{kind: "info", canonical: canonical})
}

// BookmarkID 生成书签稳定 ID；href 不是绝对 http(s) URL 时返回空串。
func BookmarkID(groupIndex, itemIndex int, href string) string {
	normalizedHref := NormalizeAbsoluteHTTPURL(href)
	if normalizedHref == "" {
		return ""
	}
	canonical := joinCanonicalParts(
		canonicalVersion,
		"bookmark",
		"bookmarks",
		strconv.Itoa(groupIndex),
		strconv.Itoa(itemIndex),
		normalizedHref,
	)
	return BuildStableID(stableIDInput{kind: "bookmark", canonical: canonical})
}

func stableIDPrefix(kind string) string {
	switch kind {
	case "service":
		return stableIDPrefixService
	case "probe":
		return stableIDPrefixProbe
	case "widget":
		return stableIDPrefixWidget
	case "info":
		return stableIDPrefixInfo
	case "bookmark":
		return stableIDPrefixBookmark
	default:
		return ""
	}
}

func joinCanonicalParts(parts ...string) string {
	return strings.Join(parts, canonicalFieldSep)
}

// 目标身份编码：openmeteo 取城市编码，resources 取排序后的磁盘路径集合，其余只留类型。
func encodeInfoIdentity(identity InfoIdentity) string {
	switch identity.Kind {
	case "openmeteo":
		return joinCanonicalParts("openmeteo", strings.TrimSpace(identity.CityID))
	case "resources":
		parts := append([]string{"resources"}, normalizeDiskPathSet(identity.DiskPaths)...)
		return joinCanonicalParts(parts...)
	case "datetime":
		return "datetime"
	default:
		return "none"
	}
}

// NormalizeAbsoluteHTTPURL 规范化绝对 http(s) URL：小写主机、剥离 userinfo 与 hash、
// 去掉默认端口；非法输入返回空串。稳定 ID 与 href 展示共用同一结果。
func NormalizeAbsoluteHTTPURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}

	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return ""
	}
	// IPv6 字面量在 URL 中以方括号呈现
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}

	defaultPort := 80
	if scheme == "https" {
		defaultPort = 443
	}
	port := ""
	if rawPort := parsed.Port(); rawPort != "" {
		if value, convErr := strconv.Atoi(rawPort); convErr == nil && value != defaultPort {
			port = ":" + strconv.Itoa(value)
		}
	}

	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	query := ""
	if parsed.RawQuery != "" {
		query = "?" + parsed.RawQuery
	}

	return scheme + "://" + host + port + path + query
}

var repeatedSlashPattern = regexp.MustCompile(`/{2,}`)

// NormalizeDiskPathIdentity 规范化磁盘路径作为身份：反斜杠转正斜杠、折叠重复斜杠、
// 去掉末尾斜杠；空输入返回空串。
func NormalizeDiskPathIdentity(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}

	path := strings.ReplaceAll(trimmed, "\\", "/")
	unc := strings.HasPrefix(path, "//")
	path = repeatedSlashPattern.ReplaceAllString(path, "/")
	if unc {
		// 折叠后补回一档，得到 //host/... 的双斜杠开头
		path = "/" + path
	}

	if len(path) > 1 && strings.HasSuffix(path, "/") {
		path = path[:len(path)-1]
	}
	return path
}

// 规范化磁盘路径集合：逐条规范化、去空、去重并排序。
func normalizeDiskPathSet(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	out := make([]string, 0, len(paths))
	for _, item := range paths {
		normalized := NormalizeDiskPathIdentity(item)
		if normalized == "" {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	sort.Strings(out)
	return out
}

// 规范化类型标记：去首尾空白并转小写。
func normalizeTypeToken(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}
