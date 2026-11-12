package domain

import "testing"

// 期望值由 TS 参考实现（packages/domain）逐字节生成，任何偏差都会让前端引用失效。
func TestStableIDsMatchTypeScript(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"service 带路径与查询", ServiceID(0, 0, "https://Example.COM:443/a b/?x=1#frag"), "svc_668ba52db4a0f19924cfcb84"},
		{"service 无 href", ServiceID(0, 1, ""), "svc_eba68b21ed6b6a8a9db1e72b"},
		{"service 默认端口剥离", ServiceID(1, 2, "http://h:80/p"), "svc_3599c7c6046916a449f301dd"},
		{"probe", ProbeID(0, 0, "http://192.168.50.1/cgi-bin/luci/"), "prb_9fdb91963d755c607a4e6ded"},
		{"widget 类型小写", WidgetID(1, 0, 0, "QBitTorrent", "http://192.168.50.10:8080"), "wgt_dc3cc58aad324fcaec99cf02"},
		{"info datetime", InfoID(0, "Datetime", InfoIdentity{Kind: "datetime"}), "inf_7cd6ca3912923ebad51738f8"},
		{"info openmeteo 去空白", InfoID(1, "openmeteo", InfoIdentity{Kind: "openmeteo", CityID: " 101270401 "}), "inf_47a96b366b76f41228c84f95"},
		{"info resources 排序去重", InfoID(2, "resources", InfoIdentity{Kind: "resources", DiskPaths: []string{"/b/", "/a", "/b", "", "C:\\盘\\"}}), "inf_74f2fb1dfb7529aa41167bdf"},
		{"info 未支持类型", InfoID(3, "unknown", InfoIdentity{Kind: "none"}), "inf_39cb9f4de54467758a3cf405"},
		{"bookmark", BookmarkID(0, 0, "https://hdsky.me/"), "bmk_ad2f7162189daeb0f5f0a49d"},
	}

	for _, testCase := range cases {
		if testCase.got != testCase.want {
			t.Errorf("%s：得到 %s，期望 %s", testCase.name, testCase.got, testCase.want)
		}
	}
}

func TestBookmarkIDRejectsNonHTTPHref(t *testing.T) {
	if id := BookmarkID(0, 0, "ftp://example.com/x"); id != "" {
		t.Errorf("非 http(s) 链接不应生成 ID，得到 %s", id)
	}
}
