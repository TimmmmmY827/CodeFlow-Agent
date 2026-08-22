package uniquestable

import (
	"reflect"
	"testing"
)

func TestUniqueStablePreservesFirstSeenOrder(t *testing.T) {
	got := UniqueStable([]string{"beta", "alpha", "beta"})
	want := []string{"beta", "alpha"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("UniqueStable() = %v, want %v", got, want)
	}
}
