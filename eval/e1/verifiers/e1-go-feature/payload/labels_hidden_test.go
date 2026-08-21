package labels

import (
	"reflect"
	"testing"
)

func TestParseHiddenCases(t *testing.T) {
	got, err := Parse([]string{" env = prod ", "owner=team=a", "env=stage"})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	want := map[string]string{"env": "stage", "owner": "team=a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %v, want %v", got, want)
	}

	for _, input := range [][]string{{"missing"}, {"=value"}, {"   =value"}} {
		got, err := Parse(input)
		if err == nil || got != nil {
			t.Fatalf("Parse(%v) = (%v, %v), want (nil, error)", input, got, err)
		}
	}
}
