// A slow-but-stable test (~120 ms, comfortably over the fixture's 50 ms
// slowThresholdMs) so the `slow` tag has something to tag.
package gofixture

import (
	"testing"
	"time"
)

func TestSlowPass(t *testing.T) {
	time.Sleep(120 * time.Millisecond)
}
