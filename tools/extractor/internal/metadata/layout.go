package metadata

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sort"
)

const standardHeaderSize = 0x100

var tableNames = [...]string{
	"stringLiterals", "stringLiteralData", "strings", "events", "properties",
	"methods", "parameterDefaultValues", "fieldDefaultValues",
	"fieldAndParameterDefaultValueData", "fieldMarshaledSizes", "parameters",
	"fields", "genericParameters", "genericParameterConstraints",
	"genericContainers", "nestedTypes", "interfaces", "vtableMethods",
	"interfaceOffsets", "typeDefinitions", "images", "assemblies", "fieldRefs",
	"referencedAssemblies", "attributeData", "attributeDataRanges",
	"unresolvedVirtualCallParameterTypes", "unresolvedVirtualCallParameterRanges",
	"windowsRuntimeTypeNames", "windowsRuntimeStrings", "exportedTypeDefinitions",
}

// Sizes of records in metadata version 31. A size of one marks a byte heap.
var tableRecordSizes = [...]int{
	8, 1, 1, 8, 20, 36, 12, 12, 1, 12, 12, 12, 16, 8, 16, 4,
	4, 4, 8, 88, 40, 64, 8, 4, 1, 8, 4, 8, 8, 1, 4,
}

// TableInfo describes one reconstructed IL2CPP table. SourceOffset is its
// location in the game's shifted/custom layout; Offset is its standard output
// location.
type TableInfo struct {
	Name         string `json:"name"`
	Offset       int    `json:"offset"`
	Size         int    `json:"size"`
	SourceOffset int    `json:"source_offset,omitempty"`
}

type sourceTable struct {
	offset int
	size   int
}

func rebuild(enc, header []byte, dataEnd int, version uint32) ([]byte, []TableInfo, error) {
	if version != 31 {
		return nil, nil, fmt.Errorf("unsupported target metadata version %d (expected 31)", version)
	}
	values := headerValues(header, dataEnd)
	tables, err := discoverTables(enc, values, dataEnd)
	if err != nil {
		return nil, nil, err
	}

	out := make([]byte, standardHeaderSize)
	binary.LittleEndian.PutUint32(out, Magic)
	binary.LittleEndian.PutUint32(out[4:], version)
	info := make([]TableInfo, len(tables))
	for i, table := range tables {
		for len(out)&3 != 0 {
			out = append(out, 0)
		}
		start := table.offset + shift
		end := start + table.size
		if start < 0 || end < start || end > len(enc) {
			return nil, nil, fmt.Errorf("%s source range %#x..%#x is outside metadata", tableNames[i], start, end)
		}
		data := append([]byte(nil), enc[start:end]...)
		switch i {
		case 1:
			for n := range data {
				data[n] ^= byte(0x0d - n)
			}
		case 2:
			for n := range data {
				data[n] ^= byte(n + 0x5f)
			}
		}
		offset := len(out)
		binary.LittleEndian.PutUint32(out[8+i*8:], uint32(offset))
		binary.LittleEndian.PutUint32(out[12+i*8:], uint32(len(data)))
		out = append(out, data...)
		info[i] = TableInfo{Name: tableNames[i], Offset: offset, Size: len(data), SourceOffset: table.offset}
	}
	return out, info, nil
}

func headerValues(header []byte, dataEnd int) []int {
	set := map[int]bool{dataEnd: true}
	for i := 0; i+4 <= len(header); i += 4 {
		v := int(binary.LittleEndian.Uint32(header[i:]))
		if v >= 0 && v <= dataEnd {
			set[v] = true
		}
	}
	values := make([]int, 0, len(set))
	for v := range set {
		values = append(values, v)
	}
	sort.Ints(values)
	return values
}

func discoverTables(enc []byte, values []int, dataEnd int) ([]sourceTable, error) {
	valueSet := make(map[int]bool, len(values))
	for _, v := range values {
		valueSet[v] = true
	}

	// Locate tables 1 and 2 by decoding candidates for table 2 and requiring a
	// real managed string heap. This avoids every build-specific shuffled-header
	// field offset used by the previous implementation.
	var best []sourceTable
	bestScore := -1
	for _, table1Off := range values {
		if table1Off < standardHeaderSize || table1Off >= dataEnd {
			continue
		}
		for _, table2Off := range values {
			table1Size := table2Off - table1Off
			if table1Size < 4096 || !valueSet[table1Size] {
				continue
			}
			for _, table3Off := range values {
				table2Size := table3Off - table2Off
				if table2Size < 4096 || !valueSet[table2Size] {
					continue
				}
				start, end := table2Off+shift, table3Off+shift
				if start < 0 || end > len(enc) || end <= start {
					continue
				}
				heap := append([]byte(nil), enc[start:end]...)
				for i := range heap {
					heap[i] ^= byte(i + 0x5f)
				}
				heapScore := stringHeapScore(heap)
				if heapScore < 800 {
					continue
				}

				literalStart, literalEnd := table1Off+shift, table2Off+shift
				if literalStart < 0 || literalEnd > len(enc) {
					continue
				}
				literalData := append([]byte(nil), enc[literalStart:literalEnd]...)
				for i := range literalData {
					literalData[i] ^= byte(0x0d - i)
				}
				for _, table0Off := range values {
					table0Size := table1Off - table0Off
					if table0Off < standardHeaderSize || table0Size <= 0 || table0Size%8 != 0 || !valueSet[table0Size] {
						continue
					}
					litScore := literalTableScore(enc, table0Off, table0Size, literalData)
					if litScore < 800 {
						continue
					}
					candidate := []sourceTable{
						{offset: table0Off, size: table0Size},
						{offset: table1Off, size: table1Size},
						{offset: table2Off, size: table2Size},
					}
					rest, ok := discoverRemaining(values, valueSet, table3Off, dataEnd)
					if !ok {
						continue
					}
					candidate = append(candidate, rest...)
					score := heapScore + litScore
					if score > bestScore {
						best, bestScore = candidate, score
					}
				}
			}
		}
	}
	if len(best) != len(tableNames) {
		return nil, fmt.Errorf("could not reconstruct shuffled metadata table layout")
	}
	return best, nil
}

func discoverRemaining(values []int, valueSet map[int]bool, start, dataEnd int) ([]sourceTable, bool) {
	tables := make([]sourceTable, len(tableNames)-3)
	failed := map[[2]int]bool{}
	var walk func(index, current int) bool
	walk = func(index, current int) bool {
		if index == len(tableNames) {
			return current == dataEnd
		}
		state := [2]int{index, current}
		if failed[state] {
			return false
		}
		if index == 28 || index == 29 {
			tables[index-3] = sourceTable{offset: current}
			if walk(index+1, current) {
				return true
			}
			failed[state] = true
			return false
		}

		for _, size := range values {
			if size <= 0 || size%tableRecordSizes[index] != 0 {
				continue
			}
			for padding := 0; padding <= 7; padding++ {
				next := current + size + padding
				if next > dataEnd {
					break
				}
				if index == len(tableNames)-1 {
					if next != dataEnd {
						continue
					}
				} else if !valueSet[next] {
					continue
				}
				tables[index-3] = sourceTable{offset: current, size: size}
				if walk(index+1, next) {
					return true
				}
			}
		}
		failed[state] = true
		return false
	}
	return tables, walk(3, start)
}

func stringHeapScore(data []byte) int {
	if len(data) < 4096 || !bytes.Contains(data, []byte("Assembly-CSharp\x00")) {
		return 0
	}
	printable, zeros := 0, 0
	for _, c := range data {
		if c == 0 {
			zeros++
			printable++
		} else if c == '\t' || c == '\n' || c == '\r' || c >= 0x20 && c < 0x7f {
			printable++
		}
	}
	printableRatio := printable * 1000 / len(data)
	zeroRatio := zeros * 1000 / len(data)
	if printableRatio < 850 || zeroRatio < 5 || zeroRatio > 300 {
		return 0
	}
	return printableRatio
}

func literalTableScore(enc []byte, offset, size int, literalData []byte) int {
	start, end := offset+shift, offset+shift+size
	if start < 0 || end > len(enc) || size < 8 {
		return 0
	}
	records := size / 8
	if records > 4096 {
		records = 4096
	}
	valid := 0
	for i := 0; i < records; i++ {
		length := int(binary.LittleEndian.Uint32(enc[start+i*8:]))
		index := int(binary.LittleEndian.Uint32(enc[start+i*8+4:]))
		if length >= 0 && index >= 0 && index+length <= len(literalData) {
			valid++
		}
	}
	return valid * 1000 / records
}

// Validate performs structural and semantic checks strong enough to reject the
// old magic-prefixed-but-still-shuffled output.
func Validate(data []byte) error {
	if len(data) < standardHeaderSize {
		return fmt.Errorf("file is only %d bytes", len(data))
	}
	if binary.LittleEndian.Uint32(data) != Magic {
		return fmt.Errorf("bad magic %#x", binary.LittleEndian.Uint32(data))
	}
	version := binary.LittleEndian.Uint32(data[4:])
	if version != 31 {
		return fmt.Errorf("unsupported metadata version %d", version)
	}
	previousEnd := standardHeaderSize
	for i, name := range tableNames {
		offset := int(binary.LittleEndian.Uint32(data[8+i*8:]))
		size := int(binary.LittleEndian.Uint32(data[12+i*8:]))
		if offset < standardHeaderSize || offset > len(data) || size < 0 || size > len(data)-offset {
			return fmt.Errorf("%s range %#x+%#x is outside a %#x-byte file", name, offset, size, len(data))
		}
		if size%tableRecordSizes[i] != 0 {
			return fmt.Errorf("%s size %#x is not divisible by record size %d", name, size, tableRecordSizes[i])
		}
		if offset < previousEnd {
			return fmt.Errorf("%s offset %#x overlaps the preceding table ending at %#x", name, offset, previousEnd)
		}
		if offset+size > previousEnd {
			previousEnd = offset + size
		}
	}
	heapOff, heapSize := tableRange(data, 2)
	if stringHeapScore(data[heapOff:heapOff+heapSize]) < 800 {
		return fmt.Errorf("managed string heap failed semantic validation")
	}
	if _, err := Types(data); err != nil {
		return fmt.Errorf("type definitions: %w", err)
	}
	return nil
}

func tableRange(data []byte, index int) (int, int) {
	return int(binary.LittleEndian.Uint32(data[8+index*8:])), int(binary.LittleEndian.Uint32(data[12+index*8:]))
}
