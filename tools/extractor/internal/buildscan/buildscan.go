// Package buildscan locates and loads native metadata artifacts from either a
// published build directory or direct file paths.
package buildscan

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"rotmg-extractor/internal/metadata"
)

// Artifacts are the native files needed to inspect an IL2CPP build.
type Artifacts struct {
	Root         string
	Metadata     string
	GameAssembly string
}

// Resolve accepts a published build directory, its game_files directory, or a
// direct global-metadata.dat path. assemblyOverride may be empty.
func Resolve(input, assemblyOverride string) (Artifacts, error) {
	abs, err := filepath.Abs(input)
	if err != nil {
		return Artifacts{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Artifacts{}, err
	}
	a := Artifacts{Root: abs, GameAssembly: assemblyOverride}
	if !info.IsDir() {
		a.Metadata = abs
		a.Root = filepath.Dir(abs)
	} else {
		roots := []string{abs, filepath.Join(abs, "game_files")}
		for _, root := range roots {
			candidate := filepath.Join(root, "global-metadata.dat")
			if _, err := os.Stat(candidate); err == nil {
				a.Metadata = candidate
				a.Root = abs
				break
			}
		}
	}
	if a.Metadata == "" {
		return Artifacts{}, fmt.Errorf("could not find global-metadata.dat under %s", abs)
	}
	if a.GameAssembly == "" {
		for _, root := range []string{filepath.Dir(a.Metadata), abs, filepath.Join(abs, "game_files")} {
			for _, name := range []string{"GameAssembly.dll", "GameAssembly.dylib", "GameAssembly.so"} {
				candidate := filepath.Join(root, name)
				if _, err := os.Stat(candidate); err == nil {
					a.GameAssembly = candidate
					break
				}
			}
			if a.GameAssembly != "" {
				break
			}
		}
	}
	return a, nil
}

// Load reads and, when needed, decrypts a build's metadata.
func Load(a Artifacts, version uint32) ([]byte, metadata.Info, error) {
	raw, err := os.ReadFile(a.Metadata)
	if err != nil {
		return nil, metadata.Info{}, err
	}
	var assembly []byte
	if !metadata.IsDecrypted(raw) {
		if a.GameAssembly == "" {
			return nil, metadata.Info{}, fmt.Errorf("metadata is obfuscated and no GameAssembly was found")
		}
		assembly, err = os.ReadFile(a.GameAssembly)
		if err != nil {
			return nil, metadata.Info{}, err
		}
	}
	return metadata.Decrypt(raw, assembly, version)
}

// Label returns a concise build name for reports.
func Label(a Artifacts) string {
	base := filepath.Base(strings.TrimRight(a.Root, string(filepath.Separator)))
	if base == "game_files" {
		return filepath.Base(filepath.Dir(a.Root))
	}
	return base
}
