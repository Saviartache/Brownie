package buildreport

import (
	"bytes"
	"strings"
	"testing"

	filediff "rotmg-extractor/internal/builddiff"
)

func TestDiffStrings(t *testing.T) {
	added, removed := DiffStrings([]string{"A", "B", "B"}, []string{"B", "C"})
	if strings.Join(added, ",") != "C" || strings.Join(removed, ",") != "A" {
		t.Fatalf("added=%v removed=%v", added, removed)
	}
}

func TestWriteText(t *testing.T) {
	report := Report{
		Old:        BuildSummary{Label: "old", TypeCount: 10, Literals: 20},
		New:        BuildSummary{Label: "new", TypeCount: 11, Literals: 21},
		Files:      []filediff.FileChange{{Path: "game_files/GameAssembly.dll", Kind: "changed", OldSize: 10, NewSize: 20}},
		Namespaces: []NamespaceChange{{Namespace: DefaultNamespaces[0], OldCount: 2, NewCount: 3, Added: []string{"NewPacket"}}},
	}
	var out bytes.Buffer
	if err := report.WriteText(&out, TextOptions{FileLimit: 10}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"old -> new", "NewPacket", "game_files/GameAssembly.dll"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("report missing %q:\n%s", want, out.String())
		}
	}
}

func TestWithoutGeneratedMetadata(t *testing.T) {
	files := []filediff.FileChange{
		{Path: "game_files/global-metadata.decrypted.dat"},
		{Path: "game_files/global-metadata.dat"},
		{Path: "build-diff.json"},
		{Path: "packets.json"},
	}
	got := withoutGenerated(files)
	if len(got) != 1 || got[0].Path != "game_files/global-metadata.dat" {
		t.Fatalf("withoutGenerated = %+v", got)
	}
}
