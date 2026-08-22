// Package builddiff computes a coarse diff between two extracted-build
// directory trees: how many files were added/removed/changed and a multiset
// count of added/removed lines. It is a fast, order-insensitive approximation
// of the original tool's recursive `diff`, suitable for a build-summary line.
package builddiff

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sort"
)

// FileChange is an exact path-level build change. Hashes are SHA-256 and are
// populated for files which exist on the corresponding side.
type FileChange struct {
	Path    string `json:"path"`
	Kind    string `json:"kind"` // added, removed, or changed
	OldSize int64  `json:"old_size,omitempty"`
	NewSize int64  `json:"new_size,omitempty"`
	OldHash string `json:"old_hash,omitempty"`
	NewHash string `json:"new_hash,omitempty"`
}

// CompareFiles returns exact recursive file changes between two directories.
// Missing directories are treated as empty.
func CompareFiles(oldDir, newDir string) ([]FileChange, error) {
	oldFiles, err := listFiles(oldDir)
	if err != nil {
		return nil, err
	}
	newFiles, err := listFiles(newDir)
	if err != nil {
		return nil, err
	}
	paths := make(map[string]bool, len(oldFiles)+len(newFiles))
	for path := range oldFiles {
		paths[path] = true
	}
	for path := range newFiles {
		paths[path] = true
	}
	ordered := make([]string, 0, len(paths))
	for path := range paths {
		ordered = append(ordered, path)
	}
	filepathSort(ordered)

	var changes []FileChange
	for _, rel := range ordered {
		_, oldOK := oldFiles[rel]
		_, newOK := newFiles[rel]
		change := FileChange{Path: filepath.ToSlash(rel)}
		switch {
		case !oldOK:
			change.Kind = "added"
			change.NewSize, change.NewHash, err = fileFingerprint(filepath.Join(newDir, rel))
		case !newOK:
			change.Kind = "removed"
			change.OldSize, change.OldHash, err = fileFingerprint(filepath.Join(oldDir, rel))
		default:
			change.OldSize, change.OldHash, err = fileFingerprint(filepath.Join(oldDir, rel))
			if err == nil {
				change.NewSize, change.NewHash, err = fileFingerprint(filepath.Join(newDir, rel))
			}
			if err == nil && change.OldHash == change.NewHash {
				continue
			}
			change.Kind = "changed"
		}
		if err != nil {
			return nil, err
		}
		changes = append(changes, change)
	}
	return changes, nil
}

func filepathSort(values []string) {
	sort.Slice(values, func(i, j int) bool {
		return filepath.ToSlash(values[i]) < filepath.ToSlash(values[j])
	})
}

func fileFingerprint(path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	if err != nil {
		return 0, "", err
	}
	return size, hex.EncodeToString(hash.Sum(nil)), nil
}

// Diff summarises the difference between two build trees.
type Diff struct {
	NewFiles     int
	DelFiles     int
	ChangedFiles int
	AddedLines   int
	RemovedLines int
}

// Empty reports whether the diff found no changes.
func (d Diff) Empty() bool { return d == Diff{} }

// Compare diffs the directory tree at newDir against oldDir. Missing
// directories are treated as empty.
func Compare(oldDir, newDir string) (Diff, error) {
	oldFiles, err := listFiles(oldDir)
	if err != nil {
		return Diff{}, err
	}
	newFiles, err := listFiles(newDir)
	if err != nil {
		return Diff{}, err
	}

	var d Diff

	for rel := range newFiles {
		if _, ok := oldFiles[rel]; !ok {
			d.NewFiles++
			added, err := countLines(filepath.Join(newDir, rel))
			if err != nil {
				return Diff{}, err
			}
			d.AddedLines += added
			continue
		}
		added, removed, err := lineDiff(filepath.Join(oldDir, rel), filepath.Join(newDir, rel))
		if err != nil {
			return Diff{}, err
		}
		if added > 0 || removed > 0 {
			d.ChangedFiles++
		}
		d.AddedLines += added
		d.RemovedLines += removed
	}

	for rel := range oldFiles {
		if _, ok := newFiles[rel]; !ok {
			d.DelFiles++
			removed, err := countLines(filepath.Join(oldDir, rel))
			if err != nil {
				return Diff{}, err
			}
			d.RemovedLines += removed
		}
	}

	return d, nil
}

// listFiles returns the set of file paths under dir, relative to dir. A missing
// directory yields an empty set.
func listFiles(dir string) (map[string]struct{}, error) {
	files := map[string]struct{}{}
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return files, nil
	}
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, err := filepath.Rel(dir, path)
			if err != nil {
				return err
			}
			files[rel] = struct{}{}
		}
		return nil
	})
	return files, err
}

// lineDiff returns added/removed line counts using a multiset comparison:
// order-insensitive but exact for line insertions and deletions.
func lineDiff(oldPath, newPath string) (added, removed int, err error) {
	oldCounts, err := lineCounts(oldPath)
	if err != nil {
		return 0, 0, err
	}
	newCounts, err := lineCounts(newPath)
	if err != nil {
		return 0, 0, err
	}
	for line, nc := range newCounts {
		if extra := nc - oldCounts[line]; extra > 0 {
			added += extra
		}
	}
	for line, oc := range oldCounts {
		if extra := oc - newCounts[line]; extra > 0 {
			removed += extra
		}
	}
	return added, removed, nil
}

func lineCounts(path string) (map[string]int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// bufio.Reader.ReadString has no line-length limit, unlike bufio.Scanner —
	// some assets (e.g. a 26MB minified sprite atlas) are a single line.
	counts := map[string]int{}
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadString('\n')
		if len(line) > 0 {
			counts[line]++
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return counts, nil
}

func countLines(path string) (int, error) {
	counts, err := lineCounts(path)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, c := range counts {
		n += c
	}
	return n, nil
}
