package metadata

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"fmt"
)

// RecoveredKey is a key literal reconstructed from RIP-relative constants in
// GameAssembly's generated key getter.
type RecoveredKey struct {
	Text       [16]byte
	Mask       [8]byte
	CodeOffset int
}

// RecoverKey finds the native key getter, reconstructs its XOR-obfuscated hex
// literal, solves the repeating mask, and verifies candidates against the
// metadata's encrypted-header length sentinel.
func RecoverKey(gameAssembly, metadata []byte) (RecoveredKey, error) {
	block, _, err := encryptedHeaderBlock(metadata)
	if err != nil {
		return RecoveredKey{}, err
	}
	image, err := newPEImage(gameAssembly)
	if err != nil {
		return RecoveredKey{}, fmt.Errorf("reading GameAssembly PE: %w", err)
	}

	// Current builds use three consecutive movdqa loads. Older builds used two;
	// trying the stricter signature first avoids unrelated compiler sequences.
	for _, loads := range []int{3, 2} {
		for _, candidate := range image.keyBlobs(loads) {
			key, ok := solveKeyMask(candidate.data, block)
			if ok {
				key.CodeOffset = candidate.codeOffset
				return key, nil
			}
		}
	}
	return RecoveredKey{}, fmt.Errorf("could not recover a verified XXTEA key from GameAssembly")
}

type peSection struct {
	virtualAddress uint32
	virtualSize    uint32
	rawOffset      uint32
	rawSize        uint32
}

type peImage struct {
	data     []byte
	sections []peSection
}

func newPEImage(data []byte) (*peImage, error) {
	f, err := pe.NewFile(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	image := &peImage{data: data}
	for _, s := range f.Sections {
		image.sections = append(image.sections, peSection{
			virtualAddress: s.VirtualAddress,
			virtualSize:    s.VirtualSize,
			rawOffset:      s.Offset,
			rawSize:        s.Size,
		})
	}
	return image, nil
}

func (p *peImage) fileToRVA(off int) (uint32, bool) {
	for _, s := range p.sections {
		if off >= int(s.rawOffset) && off < int(s.rawOffset+s.rawSize) {
			return s.virtualAddress + uint32(off-int(s.rawOffset)), true
		}
	}
	return 0, false
}

func (p *peImage) rvaToFile(rva uint32) (int, bool) {
	for _, s := range p.sections {
		size := s.virtualSize
		if s.rawSize > size {
			size = s.rawSize
		}
		if rva >= s.virtualAddress && rva < s.virtualAddress+size {
			off := int(s.rawOffset + rva - s.virtualAddress)
			return off, off >= 0 && off < len(p.data)
		}
	}
	return 0, false
}

type keyBlob struct {
	data       []byte
	codeOffset int
}

func (p *peImage) keyBlobs(loads int) []keyBlob {
	var found []keyBlob
	registers := []byte{0x05, 0x0d, 0x15}
	for off := 0; off+loads*8 <= len(p.data); off++ {
		blob := make([]byte, 0, loads*16)
		minTarget, maxTarget := len(p.data), 0
		valid := true
		for n := 0; n < loads; n++ {
			at := off + n*8
			if p.data[at] != 0x66 || p.data[at+1] != 0x0f || p.data[at+2] != 0x6f || p.data[at+3] != registers[n] {
				valid = false
				break
			}
			instructionRVA, ok := p.fileToRVA(at)
			if !ok {
				valid = false
				break
			}
			disp := int32(binary.LittleEndian.Uint32(p.data[at+4:]))
			targetRVA := uint32(int64(instructionRVA) + 8 + int64(disp))
			target, ok := p.rvaToFile(targetRVA)
			if !ok || target+16 > len(p.data) {
				valid = false
				break
			}
			if target < minTarget {
				minTarget = target
			}
			if target > maxTarget {
				maxTarget = target
			}
			blob = append(blob, p.data[target:target+16]...)
		}
		// The key getter's constants are adjacent in .rdata. This small bound is
		// useful for rejecting ordinary vectorized code with the same opcodes.
		if valid && maxTarget-minTarget <= loads*32 {
			found = append(found, keyBlob{data: blob, codeOffset: off})
			off += loads*8 - 1
		}
	}
	return found
}

func solveKeyMask(blob, encryptedHeader []byte) (RecoveredKey, bool) {
	if len(blob) < 16 {
		return RecoveredKey{}, false
	}
	hexDigit := func(c byte) bool { return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' }
	var choices [8][]byte
	product := 1
	for pos := 0; pos < 8; pos++ {
		for mask := 0; mask < 256; mask++ {
			ok := true
			for i := pos; i < len(blob); i += 8 {
				if !hexDigit(blob[i] ^ byte(mask)) {
					ok = false
					break
				}
			}
			if ok {
				choices[pos] = append(choices[pos], byte(mask))
			}
		}
		if len(choices[pos]) == 0 {
			return RecoveredKey{}, false
		}
		product *= len(choices[pos])
		if product > 1_000_000 {
			return RecoveredKey{}, false
		}
	}

	var result RecoveredKey
	var search func(int) bool
	search = func(pos int) bool {
		if pos < 8 {
			for _, mask := range choices[pos] {
				result.Mask[pos] = mask
				if search(pos + 1) {
					return true
				}
			}
			return false
		}
		for i := range result.Text {
			result.Text[i] = blob[i] ^ result.Mask[i&7]
		}
		header, err := xxteaDecryptWithLength(encryptedHeader, keyWords(result.Text[:]))
		return err == nil && len(header) >= standardHeaderSize && len(header) <= 4096
	}
	return result, search(0)
}
