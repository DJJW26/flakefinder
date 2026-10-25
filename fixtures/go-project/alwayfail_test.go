// One deterministic always-failing test.
package gofixture

import "testing"

func TestAlwaysFail(t *testing.T) {
	t.Error("deterministic failure (fixture)")
}
