// Command builddiff produces an exact file and IL2CPP metadata diff between
// two archived RotMG builds. The same command is available as extractor diff.
package main

import (
	"os"

	"rotmg-extractor/internal/toolcli"
)

func main() {
	os.Exit(toolcli.RunDiff("builddiff", os.Args[1:], os.Stdout, os.Stderr))
}
