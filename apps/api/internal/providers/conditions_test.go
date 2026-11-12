package providers

import "testing"

// 状况码覆盖表必须与前端逐字一致，含未收录码与零值。
func TestConditionTextMapping(t *testing.T) {
	cases := []struct {
		code int
		want string
	}{
		{0, "晴"},
		{1, "多云"},
		{2, "阴"},
		{3, "阵雨"},
		{4, "雷阵雨"},
		{18, "雾"},
		{21, "小雨-中雨"},
		{28, "大雪-暴雪"},
		{35, "轻雾"},
		{53, "霾"},
		{99, "未知"},
	}
	for _, testCase := range cases {
		if got := ConditionText(testCase.code); got != testCase.want {
			t.Errorf("码值 %d 描述为 %q，期望 %q", testCase.code, got, testCase.want)
		}
	}
}

// 未收录码值统一回落为未知，不返回空串。
func TestConditionTextUnknownCode(t *testing.T) {
	for _, code := range []int{-1, 36, 52, 100, 1_000} {
		if got := ConditionText(code); got != unknownConditionText {
			t.Errorf("码值 %d 描述为 %q，期望 %q", code, got, unknownConditionText)
		}
	}
}

// 映射表内不得有空文案，避免前端渲染空天气。
func TestConditionTextTableHasNoEmptyValue(t *testing.T) {
	if len(conditionTextByCode) == 0 {
		t.Fatal("状况码映射表为空")
	}
	for code, text := range conditionTextByCode {
		if text == "" {
			t.Errorf("码值 %d 的描述为空", code)
		}
	}
}
