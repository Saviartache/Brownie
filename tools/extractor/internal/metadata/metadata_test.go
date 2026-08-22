package metadata

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestXXTEADecryptGolden verifies the Go XXTEA decrypt matches the reference
// Python implementation byte-for-byte. The ciphertext was produced by XXTEA-
// encrypting the plaintext (with the length word appended) in Python.
func TestXXTEADecryptGolden(t *testing.T) {
	key := [4]uint32{0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00}
	cipher, _ := hex.DecodeString("8848d4412f5bb0c3da73c0ec5bf0afc555a72fa40158ee99faf38e50ce4d0c4910b0cb12")
	want := []byte("objects.xml RotMG metadata test!")

	got, err := xxteaDecryptWithLength(cipher, key)
	if err != nil {
		t.Fatalf("xxteaDecryptWithLength: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("decrypt = %q, want %q", got, want)
	}
}

func TestKeyWords(t *testing.T) {
	// Key packing is intentionally unusual: word zero uses byte 6 as its high
	// byte, matching the native RotMG loader.
	key := []byte("68b24db643504546")
	want := [4]uint32{0x62623836, 0x36626434, 0x30353334, 0x36343534}
	if got := keyWords(key); got != want {
		t.Errorf("keyWords = %#x, want %#x", got, want)
	}
}

func TestSolveKeyMask(t *testing.T) {
	key := []byte("baa89fdd7ab4b5d4")
	plainBlob := []byte("baa89fdd7ab4b5d40123456789abcdef0123456789abcdef")
	mask := make([]byte, 8)
	binary.LittleEndian.PutUint64(mask, 0x89D75571BBA92FD7)
	encodedBlob := make([]byte, len(plainBlob))
	for i := range plainBlob {
		encodedBlob[i] = plainBlob[i] ^ mask[i&7]
	}
	header := bytes.Repeat([]byte{0x42}, 300)
	cipher := xxteaEncryptWithLength(header, keyWords(key))

	got, ok := solveKeyMask(encodedBlob, cipher)
	if !ok {
		t.Fatal("solveKeyMask did not find a verified key")
	}
	if string(got.Text[:]) != string(key) || !bytes.Equal(got.Mask[:], mask) {
		t.Fatalf("got key=%q mask=%x", got.Text, got.Mask)
	}
}

func xxteaEncryptWithLength(data []byte, key [4]uint32) []byte {
	n := (len(data)+3)/4 + 1
	v := make([]uint32, n)
	for i, c := range data {
		v[i/4] |= uint32(c) << uint((i&3)*8)
	}
	v[n-1] = uint32(len(data))
	rounds := 6 + 52/n
	var sum uint32
	z := v[n-1]
	for range rounds {
		sum += delta
		e := int((sum >> 2) & 3)
		for p := 0; p < n-1; p++ {
			y := v[p+1]
			mx := (((z >> 5) ^ (y << 2)) + ((y >> 3) ^ (z << 4))) ^ ((sum ^ y) + (key[(p&3)^e] ^ z))
			v[p] += mx
			z = v[p]
		}
		y := v[0]
		p := n - 1
		mx := (((z >> 5) ^ (y << 2)) + ((y >> 3) ^ (z << 4))) ^ ((sum ^ y) + (key[(p&3)^e] ^ z))
		v[p] += mx
		z = v[p]
	}
	out := make([]byte, n*4)
	for i, value := range v {
		binary.LittleEndian.PutUint32(out[i*4:], value)
	}
	return out
}

func TestIsDecrypted(t *testing.T) {
	valid := make([]byte, 8)
	binary.LittleEndian.PutUint32(valid, Magic)
	if !IsDecrypted(valid) {
		t.Error("magic-prefixed data should be detected as decrypted")
	}
	if IsDecrypted([]byte{0x55, 0xd4, 0xf3, 0xfe}) {
		t.Error("encrypted data should not be detected as decrypted")
	}
	if IsDecrypted([]byte{0x01, 0x02}) {
		t.Error("short data should not be detected as decrypted")
	}
}

// TestRealMacMetadata checks the installed macOS metadata is recognised as
// already-decrypted (so the mac pipeline skips decryption). Skipped if absent.
func TestRealMacMetadata(t *testing.T) {
	path := "/Users/admin/.local/share/RealmOfTheMadGod/Production/RotMGExalt.app/Contents/Resources/Data/il2cpp_data/Metadata/global-metadata.dat"
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skip("macOS metadata not installed; skipping")
	}
	if !IsDecrypted(data) {
		t.Fatal("installed macOS metadata should already be a valid il2cpp file")
	}
	dst := filepath.Join(t.TempDir(), "out.dat")
	info, err := Prepare(path, "", dst, DefaultVersion)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if info.Decrypted {
		t.Error("macOS metadata should pass through without decryption")
	}
}

func TestPreparePassthrough(t *testing.T) {
	// An already-valid metadata (macOS case) is copied through unchanged with
	// decrypted=false — no build-specific decryption attempted.
	dir := t.TempDir()
	src := filepath.Join(dir, "global-metadata.dat")
	dst := filepath.Join(dir, "out.dat")

	content := makeValidMetadata()
	if err := os.WriteFile(src, content, 0o644); err != nil {
		t.Fatal(err)
	}

	info, err := Prepare(src, "", dst, DefaultVersion)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if info.Decrypted {
		t.Error("already-valid metadata should not be decrypted")
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, content) {
		t.Error("passthrough output differs from input")
	}
}

func TestEmbeddedPacketCatalog(t *testing.T) {
	data := []byte("junk\x00DecaGames.RotMG.Net.SocketServer.Messages.Incoming|PlayerHit\x00\x00\x00\x00" +
		"DecaGames.RotMG.Net.SocketServer.Messages.Incoming.Trade|TradeAccepted\x00" +
		"DecaGames.RotMG.Net.SocketServer.Messages.Outgoing|UseItem\x00")
	types := EmbeddedTypes(data)
	got := NamesInNamespace(types, "Net.SocketServer.Messages.Incoming")
	want := []string{"PlayerHit", "TradeAccepted"}
	if !bytes.Equal([]byte(strings.Join(got, ",")), []byte(strings.Join(want, ","))) {
		t.Fatalf("incoming names = %v, want %v", got, want)
	}
	got = NamesInNamespace(types, "Net.SocketServer.Messages.Outgoing")
	if len(got) != 1 || got[0] != "UseItem" {
		t.Fatalf("outgoing names = %v", got)
	}
}

func makeValidMetadata() []byte {
	heap := make([]byte, 4096)
	for i := range heap {
		heap[i] = 'A'
	}
	for i := 15; i < len(heap); i += 16 {
		heap[i] = 0
	}
	copy(heap, []byte("Assembly-CSharp\x00"))
	data := make([]byte, standardHeaderSize+len(heap))
	binary.LittleEndian.PutUint32(data, Magic)
	binary.LittleEndian.PutUint32(data[4:], DefaultVersion)
	for i := range tableNames {
		binary.LittleEndian.PutUint32(data[8+i*8:], uint32(len(data)))
	}
	for i := 0; i <= 2; i++ {
		binary.LittleEndian.PutUint32(data[8+i*8:], standardHeaderSize)
	}
	binary.LittleEndian.PutUint32(data[12+2*8:], uint32(len(heap)))
	copy(data[standardHeaderSize:], heap)
	return data
}
