// Package buildreport creates reusable semantic reports between two published
// RotMG builds.
package buildreport

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	filediff "rotmg-extractor/internal/builddiff"
	"rotmg-extractor/internal/buildscan"
	"rotmg-extractor/internal/metadata"
)

// DefaultNamespaces are included in a normal build report.
var DefaultNamespaces = []string{
	"Net.SocketServer.Messages.Incoming",
	"Net.SocketServer.Messages.Outgoing",
	"Net.SocketServer.Messages.Data",
}

// Options controls the data collected by Compare.
type Options struct {
	Namespaces       []string
	IncludeGenerated bool
}

// TextOptions controls optional detail in the human-readable report.
type TextOptions struct {
	ShowAllTypes bool
	ShowLiterals bool
	FileLimit    int
}

// Report is the complete machine-readable comparison between two builds.
type Report struct {
	Old             BuildSummary          `json:"old"`
	New             BuildSummary          `json:"new"`
	Files           []filediff.FileChange `json:"files"`
	TypesAdded      []string              `json:"types_added"`
	TypesRemoved    []string              `json:"types_removed"`
	LiteralsAdded   []string              `json:"string_literals_added"`
	LiteralsRemoved []string              `json:"string_literals_removed"`
	Namespaces      []NamespaceChange     `json:"namespaces"`
}

// BuildSummary describes one side of a report.
type BuildSummary struct {
	Label     string        `json:"label"`
	Path      string        `json:"path"`
	Metadata  metadata.Info `json:"metadata"`
	TypeCount int           `json:"type_count"`
	Literals  int           `json:"string_literal_count"`
}

// NamespaceChange describes types added to or removed from a namespace and
// its child namespaces.
type NamespaceChange struct {
	Namespace string   `json:"namespace"`
	OldCount  int      `json:"old_count"`
	NewCount  int      `json:"new_count"`
	Added     []string `json:"added"`
	Removed   []string `json:"removed"`
}

// Compare decrypts/loads both builds and computes file, type, string-literal,
// and namespace catalog changes.
func Compare(oldPath, newPath string, options Options) (Report, error) {
	oldArtifacts, err := buildscan.Resolve(oldPath, "")
	if err != nil {
		return Report{}, fmt.Errorf("old build: %w", err)
	}
	newArtifacts, err := buildscan.Resolve(newPath, "")
	if err != nil {
		return Report{}, fmt.Errorf("new build: %w", err)
	}
	oldData, oldInfo, err := buildscan.Load(oldArtifacts, metadata.DefaultVersion)
	if err != nil {
		return Report{}, fmt.Errorf("%s: %w", buildscan.Label(oldArtifacts), err)
	}
	newData, newInfo, err := buildscan.Load(newArtifacts, metadata.DefaultVersion)
	if err != nil {
		return Report{}, fmt.Errorf("%s: %w", buildscan.Label(newArtifacts), err)
	}
	oldTypes, err := metadata.Types(oldData)
	if err != nil {
		return Report{}, err
	}
	newTypes, err := metadata.Types(newData)
	if err != nil {
		return Report{}, err
	}
	oldCatalog, err := metadata.Catalog(oldData)
	if err != nil {
		return Report{}, err
	}
	newCatalog, err := metadata.Catalog(newData)
	if err != nil {
		return Report{}, err
	}
	oldLiterals, err := metadata.StringLiterals(oldData)
	if err != nil {
		return Report{}, err
	}
	newLiterals, err := metadata.StringLiterals(newData)
	if err != nil {
		return Report{}, err
	}
	files, err := filediff.CompareFiles(oldArtifacts.Root, newArtifacts.Root)
	if err != nil {
		return Report{}, err
	}
	if !options.IncludeGenerated {
		files = withoutGenerated(files)
	}

	report := Report{
		Old: BuildSummary{
			Label: buildscan.Label(oldArtifacts), Path: oldArtifacts.Root,
			Metadata: oldInfo, TypeCount: len(oldTypes), Literals: len(oldLiterals),
		},
		New: BuildSummary{
			Label: buildscan.Label(newArtifacts), Path: newArtifacts.Root,
			Metadata: newInfo, TypeCount: len(newTypes), Literals: len(newLiterals),
		},
		Files: files,
	}
	report.TypesAdded, report.TypesRemoved = DiffStrings(fullNames(oldTypes), fullNames(newTypes))
	report.LiteralsAdded, report.LiteralsRemoved = DiffStrings(oldLiterals, newLiterals)
	namespaces := options.Namespaces
	if len(namespaces) == 0 {
		namespaces = DefaultNamespaces
	}
	for _, namespace := range namespaces {
		oldNames := metadata.NamesInNamespace(oldCatalog, namespace)
		newNames := metadata.NamesInNamespace(newCatalog, namespace)
		added, removed := DiffStrings(oldNames, newNames)
		report.Namespaces = append(report.Namespaces, NamespaceChange{
			Namespace: namespace, OldCount: len(oldNames), NewCount: len(newNames),
			Added: added, Removed: removed,
		})
	}
	return report, nil
}

// WriteJSON writes a stable, indented complete report.
func (r Report) WriteJSON(w io.Writer) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(r)
}

// WriteText writes the concise human-readable report.
func (r Report) WriteText(w io.Writer, options TextOptions) error {
	checked := &checkedWriter{writer: w}
	fprintf := checked.printf
	fprintf("%s -> %s\n\n", r.Old.Label, r.New.Label)
	fprintf("metadata key: %s -> %s\n", displayKey(r.Old.Metadata), displayKey(r.New.Metadata))
	fprintf("managed types: %d -> %d  (+%d -%d)\n", r.Old.TypeCount, r.New.TypeCount, len(r.TypesAdded), len(r.TypesRemoved))
	fprintf("string literals: %d -> %d  (+%d -%d)\n", r.Old.Literals, r.New.Literals, len(r.LiteralsAdded), len(r.LiteralsRemoved))
	for _, namespace := range r.Namespaces {
		fprintf("\n%s: %d -> %d", namespace.Namespace, namespace.OldCount, namespace.NewCount)
		if len(namespace.Added) == 0 && len(namespace.Removed) == 0 {
			fprintf(" (unchanged)\n")
			continue
		}
		fprintf("\n")
		writeChanges(checked, namespace.Added, namespace.Removed)
	}

	added, removed, changed := 0, 0, 0
	for _, file := range r.Files {
		switch file.Kind {
		case "added":
			added++
		case "removed":
			removed++
		case "changed":
			changed++
		}
	}
	fprintf("\nfiles: +%d -%d ~%d\n", added, removed, changed)
	limit := max(options.FileLimit, 0)
	if limit > len(r.Files) {
		limit = len(r.Files)
	}
	for _, file := range r.Files[:limit] {
		mark := map[string]string{"added": "+", "removed": "-", "changed": "~"}[file.Kind]
		fprintf("  %s %s", mark, file.Path)
		if file.Kind == "changed" {
			fprintf(" (%s -> %s)", byteCount(file.OldSize), byteCount(file.NewSize))
		}
		fprintf("\n")
	}
	if limit > 0 && len(r.Files) > limit {
		fprintf("  ... %d more (use -json for the complete list)\n", len(r.Files)-limit)
	}
	if options.ShowAllTypes {
		fprintf("\nmanaged type changes:\n")
		writeChanges(checked, r.TypesAdded, r.TypesRemoved)
	}
	if options.ShowLiterals {
		fprintf("\nmanaged string literal changes:\n")
		writeChanges(checked, r.LiteralsAdded, r.LiteralsRemoved)
	}
	return checked.err
}

// DiffStrings returns sorted set additions and removals.
func DiffStrings(oldValues, newValues []string) (added, removed []string) {
	oldSet, newSet := map[string]bool{}, map[string]bool{}
	for _, value := range oldValues {
		oldSet[value] = true
	}
	for _, value := range newValues {
		newSet[value] = true
	}
	for value := range newSet {
		if !oldSet[value] {
			added = append(added, value)
		}
	}
	for value := range oldSet {
		if !newSet[value] {
			removed = append(removed, value)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	return added, removed
}

func withoutGenerated(files []filediff.FileChange) []filediff.FileChange {
	ignored := map[string]bool{
		"build_hash.txt": true, "build_version.txt": true, "changelog.md": true,
		"exalt_version.txt": true, "log.txt": true, "timestamp.txt": true,
		"build-diff.json": true, "build-diff.txt": true,
		"packets.json": true, "packets.txt": true,
	}
	out := files[:0]
	for _, file := range files {
		if !ignored[file.Path] && !strings.HasSuffix(file.Path, "/global-metadata.decrypted.dat") {
			out = append(out, file)
		}
	}
	return out
}

func fullNames(types []metadata.Type) []string {
	out := make([]string, len(types))
	for i, typ := range types {
		out[i] = typ.FullName()
	}
	sort.Strings(out)
	return out
}

func displayKey(info metadata.Info) string {
	if info.Key == "" {
		return "standard/unobfuscated"
	}
	return info.Key
}

func writeChanges(w *checkedWriter, added, removed []string) {
	for _, value := range added {
		w.printf("  + %s\n", quoted(value))
	}
	for _, value := range removed {
		w.printf("  - %s\n", quoted(value))
	}
}

type checkedWriter struct {
	writer io.Writer
	err    error
}

func (w *checkedWriter) printf(format string, args ...any) {
	if w.err == nil {
		_, w.err = fmt.Fprintf(w.writer, format, args...)
	}
}

func quoted(value string) string {
	if strings.ContainsAny(value, "\r\n\t") {
		return fmt.Sprintf("%q", value)
	}
	return value
}

func byteCount(size int64) string {
	if size >= 1<<20 {
		return fmt.Sprintf("%.1f MiB", float64(size)/(1<<20))
	}
	if size >= 1<<10 {
		return fmt.Sprintf("%.1f KiB", float64(size)/(1<<10))
	}
	return fmt.Sprintf("%d B", size)
}
