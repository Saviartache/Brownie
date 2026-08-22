package il2cppnative

import (
	"encoding/binary"
	"testing"
)

func TestFingerprintNormalizesRelativeAddresses(t *testing.T) {
	one := []byte{0xe8, 1, 0, 0, 0, 0xb8, 42, 0, 0, 0, 0xc3}
	two := append([]byte(nil), one...)
	two[1] = 99
	b1 := testBinary(one)
	b2 := testBinary(two)
	h1, err := b1.Fingerprint(0x180001000, len(one))
	if err != nil {
		t.Fatal(err)
	}
	h2, err := b2.Fingerprint(0x180001000, len(two))
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Fatalf("relative relocation changed normalized hash: %s != %s", h1, h2)
	}
	two[6] = 43
	h3, err := testBinary(two).Fingerprint(0x180001000, len(two))
	if err != nil {
		t.Fatal(err)
	}
	if h1 == h3 {
		t.Fatal("changed immediate constant did not change hash")
	}
}

func TestByteStaticFieldBindingsHandlesBothInstructionOrdersAndZero(t *testing.T) {
	data := []byte{
		0xb2, 0x0e, 0x4d, 0x8b, 0x80, 0x18, 0x01, 0x00, 0x00, 0xe8, 0, 0, 0, 0,
		0x4d, 0x8b, 0x80, 0x20, 0x01, 0x00, 0x00, 0xb2, 0x1c, 0xe8, 0, 0, 0, 0,
		0x33, 0xd2, 0x4d, 0x8b, 0x80, 0x28, 0x01, 0x00, 0x00, 0xe8, 0, 0, 0, 0, 0xc3,
	}
	base := uint64(0x180001000)
	callTarget := base + 0x200
	for _, callOffset := range []int{9, 23, 37} {
		displacement := int32(callTarget - (base + uint64(callOffset+5)))
		binary.LittleEndian.PutUint32(data[callOffset+1:], uint32(displacement))
	}
	bindings := testBinary(data).ByteStaticFieldBindings(base, base+uint64(len(data)))
	if len(bindings) != 3 {
		t.Fatalf("bindings = %#v", bindings)
	}
	want := []ByteStaticFieldBinding{{ID: 14, Offset: 0x118}, {ID: 28, Offset: 0x120}, {ID: 0, Offset: 0x128}}
	for i := range want {
		if bindings[i].ID != want[i].ID || bindings[i].Offset != want[i].Offset {
			t.Fatalf("binding %d = %#v, want ID %d offset %#x", i, bindings[i], want[i].ID, want[i].Offset)
		}
	}
}

func testBinary(data []byte) *Binary {
	return &Binary{data: data, imageBase: 0x180000000, sections: []section{{rva: 0x1000, virtualSize: uint32(len(data)), rawSize: uint32(len(data)), characteristics: 0x20000000}}}
}
