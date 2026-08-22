package metadata

import (
	"encoding/binary"
	"testing"
)

func TestMethodsV31(t *testing.T) {
	heap := []byte("\x00Game\x00Example\x00Handle\x00message\x00")
	typeRecord := make([]byte, tableRecordSizes[19])
	binary.LittleEndian.PutUint32(typeRecord, 6)     // Example
	binary.LittleEndian.PutUint32(typeRecord[4:], 1) // Game
	binary.LittleEndian.PutUint32(typeRecord[36:], 0)
	binary.LittleEndian.PutUint16(typeRecord[64:], 1)
	binary.LittleEndian.PutUint32(typeRecord[84:], 0x02000001)
	methodRecord := make([]byte, tableRecordSizes[5])
	binary.LittleEndian.PutUint32(methodRecord, 14) // Handle
	binary.LittleEndian.PutUint32(methodRecord[4:], 0)
	binary.LittleEndian.PutUint32(methodRecord[8:], 3)
	binary.LittleEndian.PutUint32(methodRecord[12:], 0x08000000)
	binary.LittleEndian.PutUint32(methodRecord[16:], 0)
	binary.LittleEndian.PutUint32(methodRecord[20:], ^uint32(0))
	binary.LittleEndian.PutUint32(methodRecord[24:], 0x06000001)
	binary.LittleEndian.PutUint16(methodRecord[34:], 1)
	parameterRecord := make([]byte, tableRecordSizes[10])
	binary.LittleEndian.PutUint32(parameterRecord, 21) // message
	binary.LittleEndian.PutUint32(parameterRecord[4:], 0x08000001)
	binary.LittleEndian.PutUint32(parameterRecord[8:], 42)

	data := make([]byte, standardHeaderSize)
	binary.LittleEndian.PutUint32(data, Magic)
	binary.LittleEndian.PutUint32(data[4:], DefaultVersion)
	setTable := func(index int, value []byte) {
		offset := len(data)
		data = append(data, value...)
		binary.LittleEndian.PutUint32(data[8+index*8:], uint32(offset))
		binary.LittleEndian.PutUint32(data[12+index*8:], uint32(len(value)))
	}
	for i := range tableNames {
		binary.LittleEndian.PutUint32(data[8+i*8:], uint32(standardHeaderSize))
	}
	setTable(2, heap)
	setTable(5, methodRecord)
	setTable(10, parameterRecord)
	setTable(19, typeRecord)

	methods, err := Methods(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(methods) != 1 || methods[0].DeclaringType.FullName() != "Game.Example" || methods[0].Name != "Handle" {
		t.Fatalf("unexpected methods: %#v", methods)
	}
	if len(methods[0].Parameters) != 1 || methods[0].Parameters[0].Name != "message" || methods[0].Parameters[0].TypeIndex != 42 {
		t.Fatalf("unexpected parameters: %#v", methods[0].Parameters)
	}
}
