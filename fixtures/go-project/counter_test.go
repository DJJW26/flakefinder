// Deterministic flake: a counter FILE drives the parity protocol, so e2e
// results never depend on timing or randomness.
//
//	run 1 -> counter 1 (odd)  -> FAIL
//	run 2 -> counter 2 (even) -> PASS
//	run 3 -> counter 3 (odd)  -> FAIL   ... and so on
//
// The test binary runs with the package directory as its working directory,
// so the bare relative path lands next to this file.
package gofixture

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestFlakyCounter(t *testing.T) {
	raw, err := os.ReadFile("counter.txt")
	n := 0
	if err == nil {
		if parsed, perr := strconv.Atoi(strings.TrimSpace(string(raw))); perr == nil {
			n = parsed
		}
	}
	n++
	if werr := os.WriteFile("counter.txt", []byte(strconv.Itoa(n)), 0o644); werr != nil {
		t.Fatalf("cannot write counter.txt: %v", werr)
	}
	if n%2 != 0 {
		t.Errorf("flaky_counter saw odd count %d", n)
	}
}
