package metadata

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sort"
	"strings"
)

// Type is one managed type recovered directly from the metadata namespace and
// type-definition tables; no external IL2CPP dumper is needed.
type Type struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// FullName returns Namespace.Name, or Name for a global-namespace type.
func (t Type) FullName() string {
	if t.Namespace == "" {
		return t.Name
	}
	return t.Namespace + "." + t.Name
}

// Types extracts all managed namespace/type names from valid metadata.
func Types(data []byte) ([]Type, error) {
	if len(data) < standardHeaderSize || binary.LittleEndian.Uint32(data) != Magic {
		return nil, fmt.Errorf("not standard IL2CPP metadata")
	}
	heapOff, heapSize := tableRange(data, 2)
	typeOff, typeSize := tableRange(data, 19)
	if heapOff < 0 || heapSize < 0 || heapOff+heapSize > len(data) || typeOff < 0 || typeSize < 0 || typeOff+typeSize > len(data) {
		return nil, fmt.Errorf("table range outside file")
	}
	if typeSize%tableRecordSizes[19] != 0 {
		return nil, fmt.Errorf("typeDefinitions size %d is invalid", typeSize)
	}
	heap := data[heapOff : heapOff+heapSize]
	getString := func(index uint32) (string, bool) {
		if uint64(index) >= uint64(len(heap)) {
			return "", false
		}
		end := bytes.IndexByte(heap[index:], 0)
		if end < 0 {
			return "", false
		}
		s := string(heap[index : int(index)+end])
		if strings.IndexFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
			return "", false
		}
		return s, true
	}

	count := typeSize / tableRecordSizes[19]
	out := make([]Type, 0, count)
	for i := 0; i < count; i++ {
		record := data[typeOff+i*tableRecordSizes[19]:]
		name, nameOK := getString(binary.LittleEndian.Uint32(record))
		namespace, namespaceOK := getString(binary.LittleEndian.Uint32(record[4:]))
		if !nameOK || !namespaceOK || name == "" {
			return nil, fmt.Errorf("record %d has invalid name or namespace index", i)
		}
		out = append(out, Type{Namespace: namespace, Name: name})
	}
	return out, nil
}

// NamesInNamespace returns sorted, unique type names from an exact namespace.
func NamesInNamespace(types []Type, namespace string) []string {
	set := map[string]bool{}
	for _, typ := range types {
		if namespaceMatches(typ.Namespace, namespace) {
			set[typ.Name] = true
		}
	}
	out := make([]string, 0, len(set))
	for name := range set {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func namespaceMatches(actual, query string) bool {
	if actual == query || strings.HasPrefix(actual, query+".") {
		return true
	}
	marker := "." + query
	index := strings.Index(actual, marker)
	return index >= 0 && (index+len(marker) == len(actual) || actual[index+len(marker)] == '.')
}

// EmbeddedTypes extracts RotMG's unobfuscated namespace|type catalog embedded
// in the metadata's default-value blob. It includes generated packet classes
// whose ordinary IL2CPP TypeDefinition names have been obfuscated, making this
// the useful source for Incoming/Outgoing packet inventories.
func EmbeddedTypes(data []byte) []Type {
	prefix := []byte("DecaGames.RotMG.")
	set := map[string]Type{}
	for cursor := 0; cursor < len(data); {
		rel := bytes.Index(data[cursor:], prefix)
		if rel < 0 {
			break
		}
		start := cursor + rel
		endRel := bytes.IndexByte(data[start:], 0)
		if endRel > 0 && endRel <= 512 {
			entry := data[start : start+endRel]
			separator := bytes.LastIndexByte(entry, '|')
			if separator > len(prefix) && separator+1 < len(entry) && catalogText(entry) {
				typ := Type{Namespace: string(entry[:separator]), Name: string(entry[separator+1:])}
				set[typ.FullName()] = typ
			}
		}
		cursor = start + len(prefix)
	}
	out := make([]Type, 0, len(set))
	for _, typ := range set {
		out = append(out, typ)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FullName() < out[j].FullName() })
	return out
}

func catalogText(value []byte) bool {
	for _, c := range value {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			continue
		}
		switch c {
		case '.', '_', '$', '`', '+', '<', '>', '-', '|':
			continue
		}
		return false
	}
	return true
}

// Catalog combines ordinary TypeDefinitions and the embedded unobfuscated
// RotMG type catalog, removing duplicates.
func Catalog(data []byte) ([]Type, error) {
	types, err := Types(data)
	if err != nil {
		return nil, err
	}
	set := make(map[string]Type, len(types))
	for _, typ := range types {
		set[typ.FullName()] = typ
	}
	for _, typ := range EmbeddedTypes(data) {
		set[typ.FullName()] = typ
	}
	out := make([]Type, 0, len(set))
	for _, typ := range set {
		out = append(out, typ)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FullName() < out[j].FullName() })
	return out, nil
}

// StringLiterals extracts sorted, unique managed string literals. This is
// particularly useful in build diffs because protocol message labels remain
// visible even when their generated class names are obfuscated.
func StringLiterals(data []byte) ([]string, error) {
	definitions, err := StringLiteralDefinitions(data)
	if err != nil {
		return nil, err
	}
	set := map[string]bool{}
	for _, literal := range definitions {
		set[literal.Value] = true
	}
	out := make([]string, 0, len(set))
	for value := range set {
		out = append(out, value)
	}
	sort.Strings(out)
	return out, nil
}

// StringLiteral is one indexed metadata literal. Index is the value encoded in
// native MetadataUsage.StringLiteral references.
type StringLiteral struct {
	Index int    `json:"index"`
	Value string `json:"value"`
}

// StringLiteralDefinitions preserves literal table indices for native xrefs.
func StringLiteralDefinitions(data []byte) ([]StringLiteral, error) {
	if len(data) < standardHeaderSize || binary.LittleEndian.Uint32(data) != Magic {
		return nil, fmt.Errorf("not standard IL2CPP metadata")
	}
	indexOff, indexSize := tableRange(data, 0)
	valueOff, valueSize := tableRange(data, 1)
	if indexSize%8 != 0 || indexOff < 0 || valueOff < 0 || indexOff+indexSize > len(data) || valueOff+valueSize > len(data) {
		return nil, fmt.Errorf("string literal tables are invalid")
	}
	values := data[valueOff : valueOff+valueSize]
	out := make([]StringLiteral, indexSize/8)
	for i := 0; i < indexSize; i += 8 {
		length := int(binary.LittleEndian.Uint32(data[indexOff+i:]))
		index := int(binary.LittleEndian.Uint32(data[indexOff+i+4:]))
		if length < 0 || index < 0 || index+length > len(values) {
			return nil, fmt.Errorf("string literal record %d is outside its data heap", i/8)
		}
		out[i/8] = StringLiteral{Index: i / 8, Value: string(values[index : index+length])}
	}
	return out, nil
}
