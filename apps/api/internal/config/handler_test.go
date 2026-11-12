package config

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 可编辑端点遇到含凭据的连接串：返回 422 与专用错误码，响应体不得回显连接串。
func TestServeEditableRejectsDockerCredentials(t *testing.T) {
	store := NewStore()
	if err := store.Load(writeConfigDir(t, map[string]string{
		FileDocker: "remote: tcp://user:pa55word@10.0.0.2:2375\n",
	})); err != nil {
		t.Fatalf("加载失败：%v", err)
	}

	recorder := httptest.NewRecorder()
	NewHandler(store).ServeEditable(recorder, httptest.NewRequest(http.MethodGet, ConfigEditablePath, nil))

	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("状态码应为 422，实得 %d", recorder.Code)
	}
	body := recorder.Body.String()
	if strings.Contains(body, "pa55word") || strings.Contains(body, "10.0.0.2") {
		t.Fatalf("错误响应不得回显连接串：%s", body)
	}

	envelope := childMap(t, decodeJSONMap(t, recorder.Body.Bytes()), "error")
	if envelope["code"] != codeDockerConnectionSensitive {
		t.Errorf("错误码应为 %q，得到 %v", codeDockerConnectionSensitive, envelope["code"])
	}
	if envelope["file"] != FileDocker {
		t.Errorf("错误应定位到 docker.yaml，得到 %v", envelope["file"])
	}
	if path, _ := envelope["path"].(string); path != "dockerEndpoints.remote" {
		t.Errorf("错误路径不符：%v", envelope["path"])
	}
}
