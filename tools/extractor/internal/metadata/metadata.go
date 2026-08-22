// Package metadata recovers RotMG's per-build XXTEA key and converts its
// obfuscated Windows global-metadata.dat into ordinary IL2CPP metadata.
package metadata

import (
	"encoding/binary"
	"fmt"
	"os"
)

// Magic is the standard IL2CPP metadata sanity value (0xFAB11BAF).
const Magic uint32 = 0xFAB11BAF

// DefaultVersion is the current IL2CPP metadata layout used by Exalt.
const DefaultVersion uint32 = 31

const (
	delta      uint32 = 0x9E3779B9
	shift             = 0x1E4
	lenOffBase        = 0x2F1AF
	teaLenAdd         = 0x621CF
)

// Info describes how an input metadata file was prepared.
type Info struct {
	Decrypted       bool        `json:"decrypted"`
	MetadataVersion uint32      `json:"metadata_version"`
	Key             string      `json:"key,omitempty"`
	XORKey          uint64      `json:"xor_key,omitempty"`
	KeyCodeOffset   int64       `json:"key_code_offset,omitempty"`
	CustomHeaderLen int         `json:"custom_header_length,omitempty"`
	Tables          []TableInfo `json:"tables,omitempty"`
}

// IsDecrypted reports whether data begins with the IL2CPP metadata magic.
func IsDecrypted(data []byte) bool {
	return len(data) >= 4 && binary.LittleEndian.Uint32(data) == Magic
}

// Decrypt automatically recovers the XXTEA key from GameAssembly.dll,
// decrypts the custom header, locates its shuffled table descriptors, unmasks
// the two protected heaps, and emits a compact standard metadata file.
func Decrypt(enc, gameAssembly []byte, version uint32) ([]byte, Info, error) {
	if IsDecrypted(enc) {
		if err := Validate(enc); err != nil {
			return nil, Info{}, fmt.Errorf("metadata has magic but is malformed: %w", err)
		}
		return append([]byte(nil), enc...), Info{
			MetadataVersion: binary.LittleEndian.Uint32(enc[4:]),
		}, nil
	}
	if len(gameAssembly) == 0 {
		return nil, Info{}, fmt.Errorf("GameAssembly.dll is required to recover the XXTEA key")
	}

	key, err := RecoverKey(gameAssembly, enc)
	if err != nil {
		return nil, Info{}, err
	}
	dec, header, tables, err := decryptWithKey(enc, key.Text[:], version)
	if err != nil {
		return nil, Info{}, fmt.Errorf("using recovered key %q: %w", string(key.Text[:]), err)
	}
	if err := Validate(dec); err != nil {
		return nil, Info{}, fmt.Errorf("rebuilt metadata failed validation: %w", err)
	}

	return dec, Info{
		Decrypted:       true,
		MetadataVersion: version,
		Key:             string(key.Text[:]),
		XORKey:          binary.LittleEndian.Uint64(key.Mask[:]),
		KeyCodeOffset:   int64(key.CodeOffset),
		CustomHeaderLen: len(header),
		Tables:          tables,
	}, nil
}

// DecryptWithKey is useful when inspecting an older build without its native
// binary. Normal callers should use Decrypt so a stale hardcoded key can never
// silently produce corrupt output.
func DecryptWithKey(enc []byte, key string, version uint32) ([]byte, Info, error) {
	if len(key) != 16 {
		return nil, Info{}, fmt.Errorf("XXTEA key must be 16 ASCII bytes, got %d", len(key))
	}
	dec, header, tables, err := decryptWithKey(enc, []byte(key), version)
	if err != nil {
		return nil, Info{}, err
	}
	if err := Validate(dec); err != nil {
		return nil, Info{}, fmt.Errorf("rebuilt metadata failed validation: %w", err)
	}
	return dec, Info{
		Decrypted:       true,
		MetadataVersion: version,
		Key:             key,
		CustomHeaderLen: len(header),
		Tables:          tables,
	}, nil
}

func decryptWithKey(enc, key []byte, version uint32) ([]byte, []byte, []TableInfo, error) {
	block, dataEnd, err := encryptedHeaderBlock(enc)
	if err != nil {
		return nil, nil, nil, err
	}
	header, err := xxteaDecryptWithLength(block, keyWords(key))
	if err != nil {
		return nil, nil, nil, err
	}
	if len(header) < standardHeaderSize {
		return nil, nil, nil, fmt.Errorf("decrypted custom header too small (%d bytes)", len(header))
	}

	// Post-processing performed by the game's loader after XXTEA.
	header[0], header[len(header)-1] = header[len(header)-1], header[0]
	header[9] ^= 0x27
	header[5] ^= 0x59

	dec, tables, err := rebuild(enc, header, dataEnd, version)
	if err != nil {
		return nil, nil, nil, err
	}
	return dec, header, tables, nil
}

// Prepare writes dumpable metadata to dstPath. Standard metadata is validated
// and copied unchanged; obfuscated metadata is decrypted using assemblyPath.
func Prepare(srcPath, assemblyPath, dstPath string, version uint32) (Info, error) {
	enc, err := os.ReadFile(srcPath)
	if err != nil {
		return Info{}, err
	}
	var assembly []byte
	if !IsDecrypted(enc) {
		assembly, err = os.ReadFile(assemblyPath)
		if err != nil {
			return Info{}, fmt.Errorf("reading GameAssembly: %w", err)
		}
	}
	dec, info, err := Decrypt(enc, assembly, version)
	if err != nil {
		return Info{}, err
	}
	if err := os.WriteFile(dstPath, dec, 0o644); err != nil {
		return Info{}, err
	}
	return info, nil
}

func encryptedHeaderBlock(enc []byte) (block []byte, dataEnd int, err error) {
	if len(enc) < 8 {
		return nil, 0, fmt.Errorf("metadata too small (%d bytes)", len(enc))
	}
	enc0 := int32(binary.LittleEndian.Uint32(enc))
	lenOff := -lenOffBase - int(enc0) - 4
	if lenOff < shift || lenOff+4 > len(enc) {
		return nil, 0, fmt.Errorf("length offset %d out of range (size %d)", lenOff, len(enc))
	}
	lenSeed := int32(binary.LittleEndian.Uint32(enc[lenOff:]))
	teaLen := int(lenSeed) + teaLenAdd
	if teaLen <= 0 || 4+teaLen > len(enc) {
		return nil, 0, fmt.Errorf("XXTEA block length %d out of range (size %d)", teaLen, len(enc))
	}
	return enc[4 : 4+teaLen], lenOff - shift, nil
}

// keyWords reproduces RotMG's slightly unusual native key packing. The high
// byte of word zero comes from key byte 6, not byte 3.
func keyWords(key []byte) [4]uint32 {
	return [4]uint32{
		binary.LittleEndian.Uint32([]byte{key[0], key[1], key[2], key[6]}),
		binary.LittleEndian.Uint32(key[4:8]),
		binary.LittleEndian.Uint32(key[8:12]),
		binary.LittleEndian.Uint32(key[12:16]),
	}
}

func xxteaDecryptWithLength(data []byte, key [4]uint32) ([]byte, error) {
	n := (len(data) + 3) / 4
	if n == 0 {
		return nil, nil
	}
	v := make([]uint32, n)
	for i, c := range data {
		v[i/4] |= uint32(c) << uint((i&3)*8)
	}

	if n > 1 {
		rounds := 6 + 52/n
		s := uint32(rounds) * delta
		y := v[0]
		for s != 0 {
			e := int((s >> 2) & 3)
			for p := n - 1; p > 0; p-- {
				z := v[p-1]
				mx := (((z >> 5) ^ (y << 2)) + ((z << 4) ^ (y >> 3))) ^ ((s ^ y) + (key[(p&3)^e] ^ z))
				v[p] -= mx
				y = v[p]
			}
			z := v[n-1]
			mx := (((z >> 5) ^ (y << 2)) + ((z << 4) ^ (y >> 3))) ^ ((s ^ y) + (key[e] ^ z))
			v[0] -= mx
			y = v[0]
			s -= delta
		}
	}

	outLen := int64(v[n-1])
	dataLen := int64((n - 1) * 4)
	if outLen < dataLen-3 || outLen > dataLen {
		return nil, fmt.Errorf("bad XXTEA plaintext length %d", v[n-1])
	}
	out := make([]byte, outLen)
	for i := range out {
		out[i] = byte(v[i/4] >> uint((i&3)*8))
	}
	return out, nil
}
