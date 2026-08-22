package packetmap

import (
	"os"
	"path/filepath"
	"testing"

	"rotmg-extractor/internal/metadata"
)

func TestLoadRealmlibAndReconcile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.Mkdir(src, 0o755); err != nil {
		t.Fatal(err)
	}
	mapText := "const ID_TO_TYPE = {\n  14: PacketType.TRADEACCEPTED,\n  92: PacketType.MAPINFO,\n};\n"
	factoryText := "[PacketType.TRADEACCEPTED]: () => new IncomingPackets.TradeAcceptedPacket(),\n[PacketType.MAPINFO]: () => new IncomingPackets.MapInfoPacket(),\n"
	if err := os.WriteFile(filepath.Join(src, "packet-map.ts"), []byte(mapText), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "create-packet.ts"), []byte(factoryText), 0o644); err != nil {
		t.Fatal(err)
	}
	catalog := []metadata.Type{{Namespace: "DecaGames.RotMG.Net.SocketServer.Messages.Incoming", Name: "TradeAccepted"}, {Namespace: "DecaGames.RotMG.Net.SocketServer.Messages.Incoming", Name: "MapInfo"}}
	got, err := Load(dir, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if got.Entries[14].Name != "TradeAccepted" || got.Entries[14].Direction != "incoming" || got.Entries[14].Confidence != 85 {
		t.Fatalf("entry 14 = %#v", got.Entries[14])
	}
	if got.Entries[92].CatalogName != "MapInfo" {
		t.Fatalf("entry 92 = %#v", got.Entries[92])
	}
}

func TestLoadJSONBidirectionalShapes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "packets.json")
	if err := os.WriteFile(path, []byte(`{"14":"TRADEACCEPTED","MAPINFO":92}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Entries[14].Type != "TRADEACCEPTED" || got.Entries[92].Type != "MAPINFO" {
		t.Fatalf("entries = %#v", got.Entries)
	}
}
