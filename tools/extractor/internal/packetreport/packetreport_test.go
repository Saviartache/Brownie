package packetreport

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rotmg-extractor/internal/packetmap"
)

func TestWriteTextDirection(t *testing.T) {
	inventory := Inventory{Build: "test", Incoming: []string{"MapInfo"}, Outgoing: []string{"UseItem"}, Data: []string{"WorldPosData"}}
	var out bytes.Buffer
	if err := inventory.WriteText(&out, "outgoing"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "UseItem") || strings.Contains(out.String(), "MapInfo") || strings.Contains(out.String(), "WorldPosData") {
		t.Fatalf("unexpected output:\n%s", out.String())
	}
	if err := inventory.WriteText(&out, "sideways"); err == nil {
		t.Fatal("invalid direction should fail")
	}
}

func TestWriteTextIncludesMappedIDsAndUnknowns(t *testing.T) {
	inventory := Inventory{
		Build: "test", Incoming: []string{"MapInfo", "NewPacket"},
		PacketMapSource: "packet-map.ts",
		PacketMappings:  []packetmap.Entry{{ID: 92, Name: "MapInfo", CatalogName: "MapInfo", Direction: "incoming"}},
	}
	var out bytes.Buffer
	if err := inventory.WriteText(&out, "incoming"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "92  MapInfo") || !strings.Contains(out.String(), "?  NewPacket") {
		t.Fatalf("unexpected output:\n%s", out.String())
	}
}

func TestWriteDirectionJSON(t *testing.T) {
	inventory := Inventory{
		Build: "test", Outgoing: []string{"UseItem", "PlayerHit"},
		PacketMapSource: "packet-map.ts",
		PacketMappings: []packetmap.Entry{
			{ID: 1, Name: "UseItem", Direction: "outgoing"},
			{ID: 2, Name: "MapInfo", Direction: "incoming"},
		},
		UnmappedOutgoing: []string{"PlayerHit"},
	}
	var out bytes.Buffer
	if err := inventory.WriteDirectionJSON(&out, "outgoing"); err != nil {
		t.Fatal(err)
	}
	var decoded DirectionInventory
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Direction != "outgoing" || decoded.Count != 2 || decoded.Names[0] != "PlayerHit" || len(decoded.PacketMappings) != 1 || decoded.PacketMappings[0].ID != 1 || len(decoded.Unmapped) != 1 {
		t.Fatalf("decoded = %+v", decoded)
	}
}

func TestExtractCachedInventory(t *testing.T) {
	dir := t.TempDir()
	want := Inventory{Build: "cached", Incoming: []string{"MapInfo"}, Outgoing: []string{"UseItem"}}
	var encoded bytes.Buffer
	if err := want.WriteJSON(&encoded); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "packets.json"), encoded.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := Extract(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Build != want.Build || len(got.Incoming) != 1 || got.Outgoing[0] != "UseItem" {
		t.Fatalf("got = %+v", got)
	}
}
