// Two deterministic always-passing tests.
package gofixture

import "testing"

func TestStableOne(t *testing.T) {
	if 1+1 != 2 {
		t.Fatal("math broke")
	}
}

func TestStableTwo(t *testing.T) {
	if got := upper("flake"); got != "FLAKE" {
		t.Fatalf("upper(flake) = %q", got)
	}
}

func upper(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'a' && b[i] <= 'z' {
			b[i] -= 'a' - 'A'
		}
	}
	return string(b)
}
