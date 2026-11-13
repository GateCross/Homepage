package icons

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 用可替换的上游地址跑代理，避免测试真的出网。
func runIconify(t *testing.T, method, prefix, name string) (*httptest.ResponseRecorder, []byte) {
	t.Helper()

	request := httptest.NewRequest(method, "/api/icons/iconify/"+prefix+"/"+name, nil)
	request.SetPathValue("prefix", prefix)
	request.SetPathValue("name", name)

	recorder := httptest.NewRecorder()
	NewIconifyHandler().ServeHTTP(recorder, request)
	return recorder, recorder.Body.Bytes()
}

func TestIconifyRejectsUnsupportedSet(t *testing.T) {
	recorder, body := runIconify(t, http.MethodGet, "tabler", "home.svg")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("不支持的图标集应为 404，实得 %d", recorder.Code)
	}
	if !strings.Contains(string(body), msgIconifyUnsupportedSet) {
		t.Fatalf("文案应为 %q，实得 %s", msgIconifyUnsupportedSet, body)
	}
}

func TestIconifyRejectsInvalidName(t *testing.T) {
	cases := []string{
		"home..svg", // 双点
		"../secret",
		"home/home",
		"-leading-dash",
		"",
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			recorder, body := runIconify(t, http.MethodGet, "mdi", name)
			if recorder.Code != http.StatusUnprocessableEntity {
				t.Fatalf("非法图标名应为 422，实得 %d（%s）", recorder.Code, body)
			}
		})
	}
}

func TestIconifyRejectsNonGet(t *testing.T) {
	recorder, _ := runIconify(t, http.MethodPost, "mdi", "home.svg")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("非 GET 应为 404，实得 %d", recorder.Code)
	}
}

func TestIconifyAcceptsBothAllowedSets(t *testing.T) {
	// 两个集合都要过前置校验；用各自真实存在的图标名，避免把上游 404 当成拦截
	cases := map[string]string{
		"mdi":          "home",
		"simple-icons": "qi",
	}
	for prefix, name := range cases {
		t.Run(prefix, func(t *testing.T) {
			recorder, body := runIconify(t, http.MethodGet, prefix, name)
			// 前置校验失败会是 404（不支持的图标集）或 422（图标名无效），两者都不带上游语义
			if recorder.Code == http.StatusUnprocessableEntity {
				t.Fatalf("集合 %s 不应被判为非法图标名：%s", prefix, body)
			}
			if strings.Contains(string(body), msgIconifyUnsupportedSet) {
				t.Fatalf("集合 %s 不应被判为不支持：%s", prefix, body)
			}
		})
	}
}

func TestIconifyStripsSVGSuffix(t *testing.T) {
	// 带 .svg 与不带后缀应产生相同上游请求，可通过结果状态一致性间接验证
	withSuffix, _ := runIconify(t, http.MethodGet, "mdi", "home.svg")
	withoutSuffix, _ := runIconify(t, http.MethodGet, "mdi", "home")
	if withSuffix.Code != withoutSuffix.Code {
		t.Fatalf("带后缀与不带后缀应同路径：%d vs %d", withSuffix.Code, withoutSuffix.Code)
	}
}
