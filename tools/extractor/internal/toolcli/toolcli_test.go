package toolcli

import (
	"bytes"
	"strings"
	"testing"
)

func TestDiffUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := RunDiff("extractor diff", nil, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "OLD_BUILD NEW_BUILD") {
		t.Fatalf("usage missing operands: %s", stderr.String())
	}
}

func TestPacketsUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := RunPackets("extractor packets", nil, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "BUILD_OR_METADATA") {
		t.Fatalf("usage missing operand: %s", stderr.String())
	}
}

func TestHandlersUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := RunHandlers("extractor handlers", nil, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "BUILD [NEW_BUILD]") {
		t.Fatalf("usage missing operands: %s", stderr.String())
	}
}
