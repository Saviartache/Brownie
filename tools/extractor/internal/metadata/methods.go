package metadata

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// TypeDefinition contains the metadata fields needed to associate methods and
// fields with their declaring managed type.
type TypeDefinition struct {
	Index       int    `json:"index"`
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	MethodStart int    `json:"method_start"`
	MethodCount int    `json:"method_count"`
	FieldStart  int    `json:"field_start"`
	FieldCount  int    `json:"field_count"`
	Token       uint32 `json:"token"`
}

// FullName returns Namespace.Name, or Name for a global-namespace type.
func (t TypeDefinition) FullName() string {
	if t.Namespace == "" {
		return t.Name
	}
	return t.Namespace + "." + t.Name
}

// Parameter is one managed method parameter. TypeIndex indexes the native
// Il2CppMetadataRegistration type table and is resolved when GameAssembly is
// available.
type Parameter struct {
	Name      string `json:"name"`
	Token     uint32 `json:"token"`
	TypeIndex int    `json:"type_index"`
}

// Method is one managed method definition recovered from metadata v31.
type Method struct {
	Index                int            `json:"index"`
	Name                 string         `json:"name"`
	DeclaringTypeIndex   int            `json:"declaring_type_index"`
	DeclaringType        TypeDefinition `json:"declaring_type"`
	ReturnTypeIndex      int            `json:"return_type_index"`
	ReturnParameterToken uint32         `json:"return_parameter_token"`
	ParameterStart       int            `json:"parameter_start"`
	GenericContainer     int            `json:"generic_container_index"`
	Token                uint32         `json:"token"`
	Flags                uint16         `json:"flags"`
	ImplementationFlags  uint16         `json:"implementation_flags"`
	Slot                 uint16         `json:"slot"`
	Parameters           []Parameter    `json:"parameters"`
}

// ImageDefinition associates a contiguous type-definition range with its
// generated native code module (for example Assembly-CSharp.dll).
type ImageDefinition struct {
	Index          int    `json:"index"`
	Name           string `json:"name"`
	AssemblyIndex  int    `json:"assembly_index"`
	FirstTypeIndex int    `json:"first_type_index"`
	TypeCount      int    `json:"type_count"`
	Token          uint32 `json:"token"`
}

// Images extracts the managed image/type ranges needed for native method
// pointer resolution.
func Images(data []byte) ([]ImageDefinition, error) {
	if len(data) < standardHeaderSize || binary.LittleEndian.Uint32(data) != Magic {
		return nil, fmt.Errorf("not standard IL2CPP metadata")
	}
	heapOff, heapSize := tableRange(data, 2)
	imageOff, imageSize := tableRange(data, 20)
	if !validRange(data, heapOff, heapSize) || !validRange(data, imageOff, imageSize) || imageSize%tableRecordSizes[20] != 0 {
		return nil, fmt.Errorf("image table range outside file")
	}
	heap := data[heapOff : heapOff+heapSize]
	table := data[imageOff : imageOff+imageSize]
	out := make([]ImageDefinition, imageSize/tableRecordSizes[20])
	for i := range out {
		record := table[i*tableRecordSizes[20]:]
		name, ok := heapString(heap, int32(binary.LittleEndian.Uint32(record)))
		if !ok || name == "" {
			return nil, fmt.Errorf("image record %d has invalid name", i)
		}
		out[i] = ImageDefinition{
			Index: i, Name: name,
			AssemblyIndex:  int(int32(binary.LittleEndian.Uint32(record[4:]))),
			FirstTypeIndex: int(int32(binary.LittleEndian.Uint32(record[8:]))),
			TypeCount:      int(binary.LittleEndian.Uint32(record[12:])),
			Token:          binary.LittleEndian.Uint32(record[28:]),
		}
	}
	return out, nil
}

// ImageForType returns the image owning typeIndex.
func ImageForType(images []ImageDefinition, typeIndex int) (ImageDefinition, bool) {
	for _, image := range images {
		if typeIndex >= image.FirstTypeIndex && typeIndex < image.FirstTypeIndex+image.TypeCount {
			return image, true
		}
	}
	return ImageDefinition{}, false
}

// Definitions extracts the complete type-definition ownership ranges.
func Definitions(data []byte) ([]TypeDefinition, error) {
	heap, typeData, err := catalogTables(data)
	if err != nil {
		return nil, err
	}
	count := len(typeData) / tableRecordSizes[19]
	out := make([]TypeDefinition, count)
	for i := range out {
		record := typeData[i*tableRecordSizes[19]:]
		name, ok := heapString(heap, int32(binary.LittleEndian.Uint32(record)))
		if !ok || name == "" {
			return nil, fmt.Errorf("type record %d has invalid name", i)
		}
		namespace, ok := heapString(heap, int32(binary.LittleEndian.Uint32(record[4:])))
		if !ok {
			return nil, fmt.Errorf("type record %d has invalid namespace", i)
		}
		out[i] = TypeDefinition{
			Index: i, Namespace: namespace, Name: name,
			FieldStart:  int(int32(binary.LittleEndian.Uint32(record[32:]))),
			MethodStart: int(int32(binary.LittleEndian.Uint32(record[36:]))),
			MethodCount: int(binary.LittleEndian.Uint16(record[64:])),
			FieldCount:  int(binary.LittleEndian.Uint16(record[68:])),
			Token:       binary.LittleEndian.Uint32(record[84:]),
		}
	}
	return out, nil
}

// Methods extracts all method definitions and their parameter metadata.
func Methods(data []byte) ([]Method, error) {
	if len(data) < standardHeaderSize || binary.LittleEndian.Uint32(data) != Magic {
		return nil, fmt.Errorf("not standard IL2CPP metadata")
	}
	heapOff, heapSize := tableRange(data, 2)
	methodOff, methodSize := tableRange(data, 5)
	parameterOff, parameterSize := tableRange(data, 10)
	if !validRange(data, heapOff, heapSize) || !validRange(data, methodOff, methodSize) || !validRange(data, parameterOff, parameterSize) {
		return nil, fmt.Errorf("method table range outside file")
	}
	if methodSize%tableRecordSizes[5] != 0 || parameterSize%tableRecordSizes[10] != 0 {
		return nil, fmt.Errorf("invalid method or parameter table size")
	}
	types, err := Definitions(data)
	if err != nil {
		return nil, err
	}
	heap := data[heapOff : heapOff+heapSize]
	parameters := data[parameterOff : parameterOff+parameterSize]
	parameterCount := parameterSize / tableRecordSizes[10]
	methods := data[methodOff : methodOff+methodSize]
	out := make([]Method, methodSize/tableRecordSizes[5])
	for i := range out {
		record := methods[i*tableRecordSizes[5]:]
		name, ok := heapString(heap, int32(binary.LittleEndian.Uint32(record)))
		if !ok || name == "" {
			return nil, fmt.Errorf("method record %d has invalid name", i)
		}
		declaring := int(int32(binary.LittleEndian.Uint32(record[4:])))
		if declaring < 0 || declaring >= len(types) {
			return nil, fmt.Errorf("method record %d has invalid declaring type %d", i, declaring)
		}
		start := int(int32(binary.LittleEndian.Uint32(record[16:])))
		count := int(binary.LittleEndian.Uint16(record[34:]))
		if count > 0 && (start < 0 || start > parameterCount-count) {
			return nil, fmt.Errorf("method record %d has invalid parameter range %d+%d", i, start, count)
		}
		params := make([]Parameter, count)
		for j := range params {
			p := parameters[(start+j)*tableRecordSizes[10]:]
			parameterName, ok := heapString(heap, int32(binary.LittleEndian.Uint32(p)))
			if !ok {
				return nil, fmt.Errorf("parameter %d of method %d has invalid name", j, i)
			}
			params[j] = Parameter{
				Name: parameterName, Token: binary.LittleEndian.Uint32(p[4:]),
				TypeIndex: int(int32(binary.LittleEndian.Uint32(p[8:]))),
			}
		}
		out[i] = Method{
			Index: i, Name: name, DeclaringTypeIndex: declaring, DeclaringType: types[declaring],
			ReturnTypeIndex:      int(int32(binary.LittleEndian.Uint32(record[8:]))),
			ReturnParameterToken: binary.LittleEndian.Uint32(record[12:]),
			ParameterStart:       start, GenericContainer: int(int32(binary.LittleEndian.Uint32(record[20:]))),
			Token: binary.LittleEndian.Uint32(record[24:]), Flags: binary.LittleEndian.Uint16(record[28:]),
			ImplementationFlags: binary.LittleEndian.Uint16(record[30:]), Slot: binary.LittleEndian.Uint16(record[32:]),
			Parameters: params,
		}
	}
	return out, nil
}

func catalogTables(data []byte) ([]byte, []byte, error) {
	if len(data) < standardHeaderSize || binary.LittleEndian.Uint32(data) != Magic {
		return nil, nil, fmt.Errorf("not standard IL2CPP metadata")
	}
	heapOff, heapSize := tableRange(data, 2)
	typeOff, typeSize := tableRange(data, 19)
	if !validRange(data, heapOff, heapSize) || !validRange(data, typeOff, typeSize) || typeSize%tableRecordSizes[19] != 0 {
		return nil, nil, fmt.Errorf("type-definition table range outside file")
	}
	return data[heapOff : heapOff+heapSize], data[typeOff : typeOff+typeSize], nil
}

func heapString(heap []byte, index int32) (string, bool) {
	if index < 0 || int(index) >= len(heap) {
		return "", false
	}
	end := bytes.IndexByte(heap[index:], 0)
	if end < 0 {
		return "", false
	}
	return string(heap[index : int(index)+end]), true
}

func validRange(data []byte, offset, size int) bool {
	return offset >= 0 && size >= 0 && offset <= len(data) && size <= len(data)-offset
}
