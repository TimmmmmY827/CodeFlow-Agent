package uniquestable

import (
	"reflect"
	"testing"
)

func TestUniqueStableHiddenCases(t *testing.T) {
	input := []string{"gamma", "alpha", "gamma", "beta", "alpha", ""}
	want := []string{"gamma", "alpha", "beta", ""}
	got := UniqueStable(input)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("UniqueStable() = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(input, []string{"gamma", "alpha", "gamma", "beta", "alpha", ""}) {
		t.Fatalf("UniqueStable mutated input: %v", input)
	}
	if got := UniqueStable(nil); len(got) != 0 {
		t.Fatalf("UniqueStable(nil) = %v, want empty", got)
	}
}
