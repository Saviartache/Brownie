// Command handlers finds packet-related managed functions, native RVAs, and
// code changes between IL2CPP builds.
package main

import (
	"os"

	"rotmg-extractor/internal/toolcli"
)

func main() {
	os.Exit(toolcli.RunHandlers("handlers", os.Args[1:], os.Stdout, os.Stderr))
}
