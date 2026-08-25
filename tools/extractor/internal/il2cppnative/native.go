// Package il2cppnative maps managed metadata tokens to native IL2CPP method
// pointers in a Windows GameAssembly.dll.
package il2cppnative

import (
	"bytes"
	"crypto/sha256"
	"debug/pe"
	"encoding/binary"
	"fmt"
	"os"
	"sort"

	"golang.org/x/arch/x86/x86asm"
)

// Binary is a loaded PE image with IL2CPP codegen-module helpers.
type Binary struct {
	data      []byte
	imageBase uint64
	sections  []section
}

type section struct {
	name               string
	rva, virtualSize   uint32
	rawOffset, rawSize uint32
	characteristics    uint32
}

// Module is one Il2CppCodeGenModule recovered by its managed image name.
type Module struct {
	Name               string `json:"name"`
	StructVA           uint64 `json:"struct_va"`
	MethodPointerCount int    `json:"method_pointer_count"`
	MethodPointersVA   uint64 `json:"method_pointers_va"`
	pointers           []uint64
}

// FunctionRange is one unique native method-pointer interval.
type FunctionRange struct {
	Start uint64
	End   uint64
}

// FunctionRanges returns sorted unique method starts bounded by the next
// method. The last function receives a conservative 4 KiB bound.
func (m Module) FunctionRanges() []FunctionRange {
	starts := append([]uint64(nil), m.pointers...)
	sort.Slice(starts, func(i, j int) bool { return starts[i] < starts[j] })
	unique := starts[:0]
	for _, pointer := range starts {
		if pointer != 0 && (len(unique) == 0 || unique[len(unique)-1] != pointer) {
			unique = append(unique, pointer)
		}
	}
	out := make([]FunctionRange, len(unique))
	for i, start := range unique {
		end := start + 4096
		if i+1 < len(unique) {
			end = unique[i+1]
		}
		out[i] = FunctionRange{Start: start, End: end}
	}
	return out
}

// TypeTable is the Il2CppMetadataRegistration type pointer table.
type TypeTable struct {
	RegistrationVA uint64 `json:"registration_va"`
	Count          int    `json:"count"`
	Address        uint64 `json:"address"`
	binary         *Binary
}

// ResolvedType is the useful portion of one native Il2CppType.
type ResolvedType struct {
	Kind                uint8          `json:"kind"`
	TypeDefinitionIndex int            `json:"type_definition_index,omitempty"`
	ElementTypeIndex    int            `json:"element_type_index,omitempty"`
	DisplayName         string         `json:"display_name"`
	GenericArguments    []ResolvedType `json:"generic_arguments,omitempty"`
}

// TypeReferenceSite is one native instruction that loads an IL2CPP type
// metadata-usage slot.
type TypeReferenceSite struct {
	RVA       uint64       `json:"rva"`
	SlotVA    uint64       `json:"slot_va"`
	TypeIndex int          `json:"type_index"`
	Type      ResolvedType `json:"type"`
}

// StaticFieldStore records a static-field offset populated by a native static
// constructor. IL2CPP emits these stores after constructing cached delegates.
type StaticFieldStore struct {
	RVA    uint64 `json:"rva"`
	Offset uint32 `json:"offset"`
}

// ByteStaticFieldBinding joins a byte key with a cached static-field offset.
// Message factories commonly use this exact shape to populate Dictionary<byte,
// Func<TMessage>> registries.
type ByteStaticFieldBinding struct {
	RVA    uint64 `json:"rva"`
	ID     int    `json:"id"`
	Offset uint32 `json:"offset"`
}

// ByteSwitchCase is one non-default destination in an MSVC byte switch.
type ByteSwitchCase struct {
	ID       int    `json:"id"`
	TargetVA uint64 `json:"target_va"`
}

// Load opens a 64-bit Windows GameAssembly PE.
func Load(path string) (*Binary, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	file, err := pe.NewFile(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("reading PE: %w", err)
	}
	defer file.Close()
	header, ok := file.OptionalHeader.(*pe.OptionalHeader64)
	if !ok {
		return nil, fmt.Errorf("only 64-bit PE GameAssembly binaries are supported")
	}
	b := &Binary{data: data, imageBase: header.ImageBase}
	for _, s := range file.Sections {
		b.sections = append(b.sections, section{
			name: s.Name, rva: s.VirtualAddress, virtualSize: s.VirtualSize,
			rawOffset: s.Offset, rawSize: s.Size, characteristics: s.Characteristics,
		})
	}
	return b, nil
}

// FindModule locates a codegen module using the native pointer to its name.
func (b *Binary) FindModule(name string, minimumMethods int) (Module, error) {
	needle := append([]byte(name), 0)
	for search := 0; search < len(b.data); {
		rel := bytes.Index(b.data[search:], needle)
		if rel < 0 {
			break
		}
		rawName := search + rel
		nameVA, ok := b.rawToVA(rawName)
		if ok {
			encoded := make([]byte, 8)
			binary.LittleEndian.PutUint64(encoded, nameVA)
			for xrefSearch := 0; xrefSearch < len(b.data); {
				xrel := bytes.Index(b.data[xrefSearch:], encoded)
				if xrel < 0 {
					break
				}
				rawStruct := xrefSearch + xrel
				if module, valid := b.readModule(name, rawStruct, minimumMethods); valid {
					return module, nil
				}
				xrefSearch = rawStruct + 1
			}
		}
		search = rawName + 1
	}
	return Module{}, fmt.Errorf("could not locate IL2CPP codegen module %q", name)
}

// FindTypeTable locates Il2CppMetadataRegistration using its two repeated
// type-definition counts and validates every required native pointer.
func (b *Binary) FindTypeTable(typeDefinitionCount int) (TypeTable, error) {
	needle := make([]byte, 8)
	binary.LittleEndian.PutUint64(needle, uint64(typeDefinitionCount))
	for search := 0; search < len(b.data); {
		rel := bytes.Index(b.data[search:], needle)
		if rel < 0 {
			break
		}
		match := search + rel
		// typeDefinitionsSizesCount is word 12 of the 16-word v31 struct.
		candidate := match - 12*8
		if candidate >= 0 && candidate&7 == 0 && candidate+16*8 <= len(b.data) {
			words := make([]uint64, 16)
			valid := true
			for i := range words {
				words[i] = binary.LittleEndian.Uint64(b.data[candidate+i*8:])
				if i&1 == 0 {
					if words[i] > 0xc0000 {
						valid = false
					}
				} else if words[i] != 0 {
					if _, ok := b.vaToRaw(words[i]); !ok {
						valid = false
					}
				}
			}
			if valid && words[12] == uint64(typeDefinitionCount) && words[10] == uint64(typeDefinitionCount) && words[6] >= uint64(typeDefinitionCount) && words[7] != 0 {
				registrationVA, ok := b.rawToVA(candidate)
				if ok {
					return TypeTable{RegistrationVA: registrationVA, Count: int(words[6]), Address: words[7], binary: b}, nil
				}
			}
		}
		search = match + 1
	}
	return TypeTable{}, fmt.Errorf("could not locate IL2CPP metadata registration for %d type definitions", typeDefinitionCount)
}

// Resolve returns the native kind and, for class/value types, the metadata
// type-definition index. names is indexed by type-definition index.
func (t TypeTable) Resolve(index int, names []string) (ResolvedType, error) {
	if index < 0 || index >= t.Count {
		return ResolvedType{}, fmt.Errorf("type index %d is outside 0..%d", index, t.Count-1)
	}
	listRaw, ok := t.binary.vaToRaw(t.Address)
	if !ok || index > (len(t.binary.data)-listRaw)/8-1 {
		return ResolvedType{}, fmt.Errorf("type pointer table is outside PE")
	}
	typeVA := binary.LittleEndian.Uint64(t.binary.data[listRaw+index*8:])
	return t.resolveAt(typeVA, names, 0)
}

func (t TypeTable) resolveAt(typeVA uint64, names []string, depth int) (ResolvedType, error) {
	if depth > 8 {
		return ResolvedType{}, fmt.Errorf("nested Il2CppType depth exceeded")
	}
	raw, ok := t.binary.vaToRaw(typeVA)
	if !ok || raw+12 > len(t.binary.data) {
		return ResolvedType{}, fmt.Errorf("Il2CppType VA %#x is outside PE", typeVA)
	}
	data := binary.LittleEndian.Uint64(t.binary.data[raw:])
	bits := binary.LittleEndian.Uint32(t.binary.data[raw+8:])
	kind := uint8(bits >> 16)
	resolved := ResolvedType{Kind: kind, TypeDefinitionIndex: -1, ElementTypeIndex: -1, DisplayName: primitiveName(kind)}
	switch kind {
	case 0x11, 0x12: // valuetype, class
		idx := int(int32(data))
		resolved.TypeDefinitionIndex = idx
		if idx >= 0 && idx < len(names) {
			resolved.DisplayName = names[idx]
		} else {
			resolved.DisplayName = fmt.Sprintf("type#%d", idx)
		}
	case 0x0f, 0x1d: // pointer, szarray: data points to another Il2CppType
		element, err := t.resolveAt(data, names, depth+1)
		if err != nil {
			return ResolvedType{}, err
		}
		resolved.ElementTypeIndex = element.TypeDefinitionIndex
		resolved.DisplayName = element.DisplayName
		if kind == 0x0f {
			resolved.DisplayName += "*"
		} else {
			resolved.DisplayName += "[]"
		}
	case 0x15: // genericinst: data points to Il2CppGenericClass
		genericRaw, mapped := t.binary.vaToRaw(data)
		if !mapped || genericRaw+32 > len(t.binary.data) {
			resolved.DisplayName = "genericinst"
			break
		}
		definitionVA := binary.LittleEndian.Uint64(t.binary.data[genericRaw:])
		definition, err := t.resolveAt(definitionVA, names, depth+1)
		if err != nil {
			resolved.DisplayName = "genericinst"
			break
		}
		resolved.TypeDefinitionIndex = definition.TypeDefinitionIndex
		resolved.DisplayName = definition.DisplayName
		instVA := binary.LittleEndian.Uint64(t.binary.data[genericRaw+8:])
		instRaw, mapped := t.binary.vaToRaw(instVA)
		if !mapped || instRaw+16 > len(t.binary.data) {
			break
		}
		argc := binary.LittleEndian.Uint64(t.binary.data[instRaw:])
		argvVA := binary.LittleEndian.Uint64(t.binary.data[instRaw+8:])
		argvRaw, mapped := t.binary.vaToRaw(argvVA)
		if !mapped || argc > 64 || argc > uint64((len(t.binary.data)-argvRaw)/8) {
			break
		}
		argumentNames := make([]string, 0, argc)
		for i := uint64(0); i < argc; i++ {
			argumentVA := binary.LittleEndian.Uint64(t.binary.data[argvRaw+int(i)*8:])
			argument, argumentErr := t.resolveAt(argumentVA, names, depth+1)
			if argumentErr != nil {
				argumentNames = append(argumentNames, "?")
				continue
			}
			resolved.GenericArguments = append(resolved.GenericArguments, argument)
			argumentNames = append(argumentNames, argument.DisplayName)
		}
		if len(argumentNames) > 0 {
			base := resolved.DisplayName
			if tick := bytes.IndexByte([]byte(base), '`'); tick >= 0 {
				base = base[:tick]
			}
			resolved.DisplayName = base + "<" + join(argumentNames, ", ") + ">"
		}
	case 0x13:
		resolved.DisplayName = "var"
	case 0x1e:
		resolved.DisplayName = "mvar"
	}
	return resolved, nil
}

func join(values []string, separator string) string {
	if len(values) == 0 {
		return ""
	}
	var out bytes.Buffer
	for i, value := range values {
		if i > 0 {
			out.WriteString(separator)
		}
		out.WriteString(value)
	}
	return out.String()
}

// FunctionRange returns the exact PE unwind range containing va. Windows
// x64 emits one .pdata runtime-function record for ordinary native methods,
// which is a more reliable bound than the next managed IL2CPP method pointer.
func (b *Binary) FunctionRange(va uint64) (start, end uint64, ok bool) {
	for _, s := range b.sections {
		if s.name != ".pdata" {
			continue
		}
		rawStart, rawEnd := int(s.rawOffset), int(s.rawOffset+s.rawSize)
		if rawStart < 0 || rawEnd > len(b.data) {
			return 0, 0, false
		}
		for raw := rawStart; raw+12 <= rawEnd; raw += 12 {
			beginRVA := binary.LittleEndian.Uint32(b.data[raw:])
			endRVA := binary.LittleEndian.Uint32(b.data[raw+4:])
			if beginRVA == 0 || endRVA <= beginRVA {
				continue
			}
			beginVA, endVA := b.imageBase+uint64(beginRVA), b.imageBase+uint64(endRVA)
			if va >= beginVA && va < endVA {
				return beginVA, endVA, true
			}
		}
	}
	return 0, 0, false
}

func primitiveName(kind uint8) string {
	if name, ok := map[uint8]string{
		0x01: "void", 0x02: "bool", 0x03: "char", 0x04: "sbyte", 0x05: "byte",
		0x06: "int16", 0x07: "uint16", 0x08: "int32", 0x09: "uint32", 0x0a: "int64",
		0x0b: "uint64", 0x0c: "float32", 0x0d: "float64", 0x0e: "string", 0x1c: "object",
	}[kind]; ok {
		return name
	}
	return fmt.Sprintf("il2cpp-type-0x%02x", kind)
}

func (b *Binary) readModule(name string, raw int, minimumMethods int) (Module, bool) {
	if raw < 0 || raw+24 > len(b.data) || raw&7 != 0 {
		return Module{}, false
	}
	structVA, ok := b.rawToVA(raw)
	if !ok {
		return Module{}, false
	}
	count64 := binary.LittleEndian.Uint64(b.data[raw+8:])
	ptrVA := binary.LittleEndian.Uint64(b.data[raw+16:])
	if count64 < uint64(minimumMethods) || count64 > 2_000_000 {
		return Module{}, false
	}
	ptrRaw, ok := b.vaToRaw(ptrVA)
	if !ok || count64 > uint64((len(b.data)-ptrRaw)/8) {
		return Module{}, false
	}
	pointers := make([]uint64, int(count64))
	valid := 0
	for i := range pointers {
		pointers[i] = binary.LittleEndian.Uint64(b.data[ptrRaw+i*8:])
		if pointers[i] == 0 || b.isExecutableVA(pointers[i]) {
			valid++
		}
	}
	if valid*100/len(pointers) < 95 {
		return Module{}, false
	}
	return Module{Name: name, StructVA: structVA, MethodPointerCount: len(pointers), MethodPointersVA: ptrVA, pointers: pointers}, true
}

// MethodPointer resolves the low 24-bit row component of a managed method
// token through the codegen module's pointer table.
func (m Module) MethodPointer(token uint32) (uint64, bool) {
	row := int(token & 0x00ffffff)
	if token>>24 != 0x06 || row <= 0 || row > len(m.pointers) {
		return 0, false
	}
	ptr := m.pointers[row-1]
	return ptr, ptr != 0
}

// Pointers returns a copy of the module's token-row-indexed method pointers.
func (m Module) Pointers() []uint64 { return append([]uint64(nil), m.pointers...) }

// DirectCallSites finds x86-64 near-call instructions whose destination is
// targetVA. The result is restricted to executable PE sections.
func (b *Binary) DirectCallSites(targetVA uint64) []uint64 {
	var out []uint64
	for _, s := range b.sections {
		if s.characteristics&pe.IMAGE_SCN_MEM_EXECUTE == 0 {
			continue
		}
		start, end := int(s.rawOffset), int(s.rawOffset+s.rawSize)
		if start < 0 || end > len(b.data) || end-start < 5 {
			continue
		}
		for raw := start; raw+5 <= end; raw++ {
			if b.data[raw] != 0xe8 {
				continue
			}
			callVA := b.imageBase + uint64(s.rva) + uint64(raw-start)
			displacement := int64(int32(binary.LittleEndian.Uint32(b.data[raw+1:])))
			if uint64(int64(callVA+5)+displacement) == targetVA {
				out = append(out, callVA)
			}
		}
	}
	return out
}

// DirectCallTargets decodes near relative calls inside one native function.
func (b *Binary) DirectCallTargets(startVA, endVA uint64) []uint64 {
	if endVA <= startVA {
		return nil
	}
	start, ok := b.vaToRaw(startVA)
	if !ok {
		return nil
	}
	end, ok := b.vaToRaw(endVA - 1)
	if !ok || end < start {
		return nil
	}
	end++
	set := map[uint64]bool{}
	for raw := start; raw < end; {
		inst, err := x86asm.Decode(b.data[raw:end], 64)
		if err != nil || inst.Len <= 0 {
			raw++
			continue
		}
		if inst.Op == x86asm.CALL {
			if rel, ok := inst.Args[0].(x86asm.Rel); ok {
				instructionVA := startVA + uint64(raw-start)
				target := uint64(int64(instructionVA+uint64(inst.Len)) + int64(rel))
				set[target] = true
			}
		}
		raw += inst.Len
	}
	out := make([]uint64, 0, len(set))
	for target := range set {
		out = append(out, target)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// FunctionContaining returns the nearest native method start at or before va,
// bounded by the next distinct pointer. Duplicate generic/shared pointers are
// tolerated.
func (m Module) FunctionContaining(va uint64) (start, end uint64, ok bool) {
	ranges := m.FunctionRanges()
	index := sort.Search(len(ranges), func(i int) bool { return ranges[i].Start > va })
	if index == 0 {
		return 0, 0, false
	}
	start, end = ranges[index-1].Start, ranges[index-1].End
	return start, end, va < end
}

// RIPRelativeCodeReferences finds simple LEA RIP+disp32 references in a native
// method. IL2CPP commonly uses these to pass a managed callback's native
// function pointer while constructing a delegate.
func (b *Binary) RIPRelativeCodeReferences(startVA, endVA uint64) []uint64 {
	start, ok := b.vaToRaw(startVA)
	if !ok {
		return nil
	}
	end, ok := b.vaToRaw(endVA - 1)
	if !ok || end < start {
		end = start + 4096
	} else {
		end++
	}
	if end > len(b.data) {
		end = len(b.data)
	}
	if end-start > 64*1024 {
		end = start + 64*1024
	}
	set := map[uint64]bool{}
	for raw := start; raw < end; raw++ {
		prefix := 0
		if b.data[raw] >= 0x40 && b.data[raw] <= 0x4f {
			prefix = 1
		}
		if raw+prefix+6 > end || b.data[raw+prefix] != 0x8d {
			continue
		}
		modRM := b.data[raw+prefix+1]
		if modRM&0xc7 != 0x05 {
			continue
		}
		length := prefix + 6
		instructionVA := startVA + uint64(raw-start)
		displacement := int64(int32(binary.LittleEndian.Uint32(b.data[raw+prefix+2:])))
		target := uint64(int64(instructionVA+uint64(length)) + displacement)
		if b.isExecutableVA(target) {
			set[target] = true
		}
	}
	out := make([]uint64, 0, len(set))
	for target := range set {
		out = append(out, target)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// MetadataMethodReferences decodes v27+ IL2CPP metadata-usage words reached by
// RIP-relative MOV/LEA instructions. A MethodDef usage directly identifies the
// managed callback index even when its name is obfuscated.
func (b *Binary) MetadataMethodReferences(startVA, endVA uint64, methodCount int) []int {
	start, ok := b.vaToRaw(startVA)
	if !ok {
		return nil
	}
	end, ok := b.vaToRaw(endVA - 1)
	if !ok || end < start {
		end = start + 4096
	} else {
		end++
	}
	if end > len(b.data) {
		end = len(b.data)
	}
	if end-start > 64*1024 {
		end = start + 64*1024
	}
	set := map[int]bool{}
	for raw := start; raw < end; raw++ {
		prefix := 0
		if b.data[raw] >= 0x40 && b.data[raw] <= 0x4f {
			prefix = 1
		}
		if raw+prefix+6 > end || (b.data[raw+prefix] != 0x8b && b.data[raw+prefix] != 0x8d) {
			continue
		}
		if b.data[raw+prefix+1]&0xc7 != 0x05 {
			continue
		}
		length := prefix + 6
		instructionVA := startVA + uint64(raw-start)
		displacement := int64(int32(binary.LittleEndian.Uint32(b.data[raw+prefix+2:])))
		targetVA := uint64(int64(instructionVA+uint64(length)) + displacement)
		targetRaw, mapped := b.vaToRaw(targetVA)
		if !mapped || targetRaw+8 > len(b.data) {
			continue
		}
		encoded := binary.LittleEndian.Uint64(b.data[targetRaw:])
		if encoded>>29&7 != 3 { // MetadataUsageType.MethodDef
			continue
		}
		index := int((encoded & 0x1fff_ffff) >> 1)
		if index >= 0 && index < methodCount {
			set[index] = true
		}
	}
	out := make([]int, 0, len(set))
	for index := range set {
		out = append(out, index)
	}
	sort.Ints(out)
	return out
}

// MetadataTypeReferences decodes TypeInfo/Type metadata usages referenced by a
// function and resolves them through Il2CppMetadataRegistration.
func (b *Binary) MetadataTypeReferences(startVA, endVA uint64, table TypeTable, names []string) []ResolvedType {
	sites := b.MetadataTypeReferenceSites(startVA, endVA, table, names)
	set := map[int]ResolvedType{}
	for _, site := range sites {
		set[site.TypeIndex] = site.Type
	}
	indices := make([]int, 0, len(set))
	for index := range set {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	out := make([]ResolvedType, 0, len(indices))
	for _, index := range indices {
		out = append(out, set[index])
	}
	return out
}

// MetadataTypeReferenceSites resolves TypeInfo/Type metadata usages while
// preserving the native load location needed for local data-flow analysis.
func (b *Binary) MetadataTypeReferenceSites(startVA, endVA uint64, table TypeTable, names []string) []TypeReferenceSite {
	if endVA <= startVA {
		return nil
	}
	start, ok := b.vaToRaw(startVA)
	if !ok {
		return nil
	}
	end, ok := b.vaToRaw(endVA - 1)
	if !ok || end < start {
		end = start + 4096
	} else {
		end++
	}
	if end > len(b.data) {
		end = len(b.data)
	}
	if end-start > 64*1024 {
		end = start + 64*1024
	}
	var out []TypeReferenceSite
	for raw := start; raw < end; raw++ {
		prefix := 0
		if b.data[raw] >= 0x40 && b.data[raw] <= 0x4f {
			prefix = 1
		}
		if raw+prefix+6 > end || (b.data[raw+prefix] != 0x8b && b.data[raw+prefix] != 0x8d) || b.data[raw+prefix+1]&0xc7 != 0x05 {
			continue
		}
		length := prefix + 6
		instructionVA := startVA + uint64(raw-start)
		displacement := int64(int32(binary.LittleEndian.Uint32(b.data[raw+prefix+2:])))
		targetVA := uint64(int64(instructionVA+uint64(length)) + displacement)
		targetRaw, mapped := b.vaToRaw(targetVA)
		if !mapped || targetRaw+8 > len(b.data) {
			continue
		}
		encoded := binary.LittleEndian.Uint64(b.data[targetRaw:])
		usageType := encoded >> 29 & 7
		if usageType != 1 && usageType != 2 {
			continue
		}
		index := int((encoded & 0x1fff_ffff) >> 1)
		resolved, resolveErr := table.Resolve(index, names)
		if resolveErr == nil {
			out = append(out, TypeReferenceSite{
				RVA: b.RVA(instructionVA), SlotVA: targetVA,
				TypeIndex: index, Type: resolved,
			})
		}
	}
	return out
}

// StaticFieldStores finds the common IL2CPP static-constructor stores
// `mov [rdx+offset], rbx`.
func (b *Binary) StaticFieldStores(startVA, endVA uint64) []StaticFieldStore {
	start, end, ok := b.rawRange(startVA, endVA)
	if !ok {
		return nil
	}
	instructionStarts := decodedInstructionStarts(b.data, start, end)
	var out []StaticFieldStore
	for raw := start; raw < end; raw++ {
		if !instructionStarts[raw] {
			continue
		}
		var offset uint32
		var length int
		switch {
		case raw+4 <= end && bytes.Equal(b.data[raw:raw+3], []byte{0x48, 0x89, 0x5a}):
			offset, length = uint32(b.data[raw+3]), 4
		case raw+7 <= end && bytes.Equal(b.data[raw:raw+3], []byte{0x48, 0x89, 0x9a}):
			offset, length = binary.LittleEndian.Uint32(b.data[raw+3:]), 7
		default:
			continue
		}
		out = append(out, StaticFieldStore{RVA: b.RVA(startVA + uint64(raw-start)), Offset: offset})
		raw += length - 1
	}
	return out
}

// ByteStaticFieldBindings finds the dictionary-population shape used by the
// client message factory: `mov dl,id`, followed by a load of one cached factory
// delegate from `[r8+offset]`.
func (b *Binary) ByteStaticFieldBindings(startVA, endVA uint64) []ByteStaticFieldBinding {
	start, end, ok := b.rawRange(startVA, endVA)
	if !ok {
		return nil
	}
	instructionStarts := decodedInstructionStarts(b.data, start, end)
	type candidate struct {
		binding    ByteStaticFieldBinding
		callTarget uint64
	}
	var candidates []candidate
	for raw := start; raw+2 <= end; raw++ {
		if !instructionStarts[raw] {
			continue
		}
		id, isKey := 0, false
		switch {
		case b.data[raw] == 0xb2: // mov dl, imm8
			id, isKey = int(b.data[raw+1]), true
		case raw+2 <= end && bytes.Equal(b.data[raw:raw+2], []byte{0x33, 0xd2}): // xor edx, edx
			id, isKey = 0, true
		}
		if !isKey {
			continue
		}
		windowStart := raw - 32
		if windowStart < start {
			windowStart = start
		}
		limit := raw + 40
		if limit > end {
			limit = end
		}
		bestDistance := 1 << 30
		bestOffset := uint32(0)
		foundOffset := false
		for cursor := windowStart; cursor < limit; cursor++ {
			if !instructionStarts[cursor] {
				continue
			}
			var offset uint32
			matched := false
			switch {
			case cursor+4 <= limit && bytes.Equal(b.data[cursor:cursor+3], []byte{0x4d, 0x8b, 0x40}):
				offset, matched = uint32(b.data[cursor+3]), true
			case cursor+7 <= limit && bytes.Equal(b.data[cursor:cursor+3], []byte{0x4d, 0x8b, 0x80}):
				offset, matched = binary.LittleEndian.Uint32(b.data[cursor+3:]), true
			}
			if !matched {
				continue
			}
			distance := cursor - raw
			if distance < 0 {
				distance = -distance
			}
			if distance < bestDistance || distance == bestDistance && cursor > raw {
				bestDistance, bestOffset, foundOffset = distance, offset, true
			}
		}
		if foundOffset {
			callTarget := uint64(0)
			for cursor := raw + 2; cursor+5 <= limit; cursor++ {
				if instructionStarts[cursor] && b.data[cursor] == 0xe8 {
					callVA := startVA + uint64(cursor-start)
					callTarget = uint64(int64(callVA+5) + int64(int32(binary.LittleEndian.Uint32(b.data[cursor+1:]))))
					break
				}
			}
			if callTarget != 0 {
				candidates = append(candidates, candidate{
					binding:    ByteStaticFieldBinding{RVA: b.RVA(startVA + uint64(raw-start)), ID: id, Offset: bestOffset},
					callTarget: callTarget,
				})
			}
		}
	}
	callCounts := map[uint64]int{}
	for _, item := range candidates {
		callCounts[item.callTarget]++
	}
	commonCall, commonCount := uint64(0), 0
	for target, count := range callCounts {
		if count > commonCount {
			commonCall, commonCount = target, count
		}
	}
	var out []ByteStaticFieldBinding
	seen := map[[2]uint32]bool{}
	for _, item := range candidates {
		if item.callTarget != commonCall {
			continue
		}
		key := [2]uint32{uint32(item.binding.ID), item.binding.Offset}
		if !seen[key] {
			seen[key] = true
			out = append(out, item.binding)
		}
	}
	return out
}

// ByteSwitchCases recovers the non-default cases from the compact byte and
// dword jump tables MSVC emits for switches over a byte packet ID.
func (b *Binary) ByteSwitchCases(startVA, endVA uint64) []ByteSwitchCase {
	start, end, ok := b.rawRange(startVA, endVA)
	if !ok {
		return nil
	}
	instructionStarts := decodedInstructionStarts(b.data, start, end)
	cases := map[int]uint64{}
	frequencies := map[uint64]int{}
	rangeFailureTargets := map[uint64]int{}
	addTable := func(base, count int, indexRVA uint32, jumpRVA uint32, compressed bool) {
		indexRaw, indexOK := b.vaToRaw(b.imageBase + uint64(indexRVA))
		jumpRaw, jumpOK := b.vaToRaw(b.imageBase + uint64(jumpRVA))
		if !indexOK || !jumpOK || count <= 0 || count > 256 {
			return
		}
		for i := 0; i < count; i++ {
			jumpIndex := i
			if compressed {
				if indexRaw+i >= len(b.data) {
					return
				}
				jumpIndex = int(b.data[indexRaw+i])
			}
			entryRaw := jumpRaw + jumpIndex*4
			if entryRaw < 0 || entryRaw+4 > len(b.data) {
				return
			}
			target := b.imageBase + uint64(binary.LittleEndian.Uint32(b.data[entryRaw:]))
			if target >= startVA && target < endVA {
				cases[base+i] = target
				frequencies[target]++
			}
		}
	}
	for raw := start; raw < end; raw++ {
		if !instructionStarts[raw] {
			continue
		}
		// Unsigned-above branches guard switch ranges and converge on the true
		// default/error block. Count their destinations independently of table
		// frequency (a valid delegated case can be more common than default).
		if raw+6 <= end && bytes.Equal(b.data[raw:raw+2], []byte{0x0f, 0x87}) {
			instructionVA := startVA + uint64(raw-start)
			target := uint64(int64(instructionVA+6) + int64(int32(binary.LittleEndian.Uint32(b.data[raw+2:]))))
			if target >= startVA && target < endVA {
				rangeFailureTargets[target]++
			}
		}
		if raw+2 <= end && b.data[raw] == 0x77 {
			instructionVA := startVA + uint64(raw-start)
			target := uint64(int64(instructionVA+2) + int64(int8(b.data[raw+1])))
			if target >= startVA && target < endVA {
				rangeFailureTargets[target]++
			}
		}
		// Equality cases outside jump tables: cmp bl, id; je rel32.
		if raw+9 <= end && bytes.Equal(b.data[raw:raw+2], []byte{0x80, 0xfb}) && bytes.Equal(b.data[raw+3:raw+5], []byte{0x0f, 0x84}) {
			instructionVA := startVA + uint64(raw-start)
			target := uint64(int64(instructionVA+9) + int64(int32(binary.LittleEndian.Uint32(b.data[raw+5:]))))
			if target >= startVA && target < endVA {
				cases[int(b.data[raw+2])] = target
			}
			continue
		}
		// Compressed table: byte index lookup followed by dword target lookup.
		if raw+16 <= end && bytes.Equal(b.data[raw:raw+4], []byte{0x0f, 0xb6, 0x84, 0x0a}) {
			indexRVA := binary.LittleEndian.Uint32(b.data[raw+4:])
			if !bytes.Equal(b.data[raw+8:raw+11], []byte{0x8b, 0x8c, 0x82}) && !bytes.Equal(b.data[raw+8:raw+11], []byte{0x8b, 0x84, 0x82}) {
				continue
			}
			jumpRVA := binary.LittleEndian.Uint32(b.data[raw+11:])
			base, count, found := precedingByteTableRange(b.data, start, raw)
			if found {
				addTable(base, count, indexRVA, jumpRVA, true)
			}
			continue
		}
		// Zero-based compressed table uses BL directly as the byte index.
		if raw+16 <= end && bytes.Equal(b.data[raw:raw+4], []byte{0x0f, 0xb6, 0x84, 0x1a}) {
			indexRVA := binary.LittleEndian.Uint32(b.data[raw+4:])
			if !bytes.Equal(b.data[raw+8:raw+11], []byte{0x8b, 0x8c, 0x82}) {
				continue
			}
			jumpRVA := binary.LittleEndian.Uint32(b.data[raw+11:])
			_, count, found := precedingByteTableRange(b.data, start, raw)
			if found {
				addTable(0, count, indexRVA, jumpRVA, true)
			}
			continue
		}
		// Direct dword table indexed by RCX or RAX.
		if raw+7 <= end && isDirectDwordTable(b.data[raw:raw+3]) {
			jumpRVA := binary.LittleEndian.Uint32(b.data[raw+3:])
			base, count, found := precedingByteTableRange(b.data, start, raw)
			if found {
				addTable(base, count, jumpRVA, jumpRVA, false)
			}
		}
	}
	var defaultTarget uint64
	defaultCount := 0
	for target, count := range rangeFailureTargets {
		if count > defaultCount {
			defaultTarget, defaultCount = target, count
		}
	}
	if defaultTarget == 0 {
		for target, count := range frequencies {
			if count > defaultCount {
				defaultTarget, defaultCount = target, count
			}
		}
	}
	var out []ByteSwitchCase
	for id, target := range cases {
		if target != defaultTarget {
			out = append(out, ByteSwitchCase{ID: id, TargetVA: target})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func isDirectDwordTable(instruction []byte) bool {
	return bytes.Equal(instruction, []byte{0x8b, 0x84, 0x8a}) ||
		bytes.Equal(instruction, []byte{0x8b, 0x8c, 0x82})
}

func decodedInstructionStarts(data []byte, start, end int) map[int]bool {
	starts := map[int]bool{}
	for raw := start; raw < end; {
		inst, err := x86asm.Decode(data[raw:end], 64)
		if err != nil || inst.Len <= 0 {
			raw++
			continue
		}
		starts[raw] = true
		raw += inst.Len
	}
	return starts
}

func precedingByteTableRange(data []byte, functionStart, raw int) (base, count int, ok bool) {
	window := raw - 64
	if window < functionStart {
		window = functionStart
	}
	base, count = 0, 0
	for cursor := window; cursor < raw; cursor++ {
		switch {
		case cursor+3 <= raw && bytes.Equal(data[cursor:cursor+2], []byte{0x8d, 0x43}):
			base = -int(int8(data[cursor+2]))
		case cursor+6 <= raw && bytes.Equal(data[cursor:cursor+2], []byte{0x8d, 0x83}):
			base = -int(int32(binary.LittleEndian.Uint32(data[cursor+2:])))
		case cursor+3 <= raw && bytes.Equal(data[cursor:cursor+2], []byte{0x83, 0xf8}):
			count = int(data[cursor+2]) + 1
		case cursor+3 <= raw && bytes.Equal(data[cursor:cursor+2], []byte{0x83, 0xfb}):
			base, count = 0, int(data[cursor+2])+1
		case cursor+2 <= raw && data[cursor] == 0x3c: // cmp al, imm8
			base, count = 0, int(data[cursor+1])+1
		}
	}
	return base, count, count > 0 && base >= 0 && base+count <= 256
}

func (b *Binary) rawRange(startVA, endVA uint64) (start, end int, ok bool) {
	if endVA <= startVA {
		return 0, 0, false
	}
	start, ok = b.vaToRaw(startVA)
	if !ok {
		return 0, 0, false
	}
	last, ok := b.vaToRaw(endVA - 1)
	if !ok || last < start {
		return 0, 0, false
	}
	return start, last + 1, true
}

// MetadataStringLiteralReferences returns string-literal table indices loaded
// through native IL2CPP metadata-usage slots by one function.
func (b *Binary) MetadataStringLiteralReferences(startVA, endVA uint64, literalCount int) []int {
	return b.metadataUsageIndices(startVA, endVA, 5, literalCount)
}

func (b *Binary) metadataUsageIndices(startVA, endVA uint64, usageType uint64, count int) []int {
	if endVA <= startVA || count <= 0 {
		return nil
	}
	start, ok := b.vaToRaw(startVA)
	if !ok {
		return nil
	}
	end, ok := b.vaToRaw(endVA - 1)
	if !ok || end < start {
		return nil
	}
	end++
	if end > len(b.data) {
		end = len(b.data)
	}
	set := map[int]bool{}
	for raw := start; raw < end; raw++ {
		prefix := 0
		if b.data[raw] >= 0x40 && b.data[raw] <= 0x4f {
			prefix = 1
		}
		if raw+prefix+6 > end || (b.data[raw+prefix] != 0x8b && b.data[raw+prefix] != 0x8d) || b.data[raw+prefix+1]&0xc7 != 0x05 {
			continue
		}
		length := prefix + 6
		instructionVA := startVA + uint64(raw-start)
		displacement := int64(int32(binary.LittleEndian.Uint32(b.data[raw+prefix+2:])))
		targetVA := uint64(int64(instructionVA+uint64(length)) + displacement)
		targetRaw, mapped := b.vaToRaw(targetVA)
		if !mapped || targetRaw+8 > len(b.data) {
			continue
		}
		encoded := binary.LittleEndian.Uint64(b.data[targetRaw:])
		if encoded>>29&7 != usageType {
			continue
		}
		index := int((encoded & 0x1fff_ffff) >> 1)
		if index >= 0 && index < count {
			set[index] = true
		}
	}
	out := make([]int, 0, len(set))
	for index := range set {
		out = append(out, index)
	}
	sort.Ints(out)
	return out
}

// NearestMetadataMethodReference returns the last MethodDef metadata usage
// loaded shortly before a call. IL2CPP's delegate-construction sequence places
// the callback MethodInfo in this window immediately before AddListener.
func (b *Binary) NearestMetadataMethodReference(callVA uint64, backBytes, methodCount int) (int, bool) {
	if backBytes <= 0 {
		backBytes = 192
	}
	startVA := callVA - uint64(backBytes)
	indices := b.metadataMethodReferencesOrdered(startVA, callVA, methodCount)
	if len(indices) == 0 {
		return 0, false
	}
	return indices[len(indices)-1], true
}

func (b *Binary) metadataMethodReferencesOrdered(startVA, endVA uint64, methodCount int) []int {
	start, ok := b.vaToRaw(startVA)
	if !ok {
		return nil
	}
	end, ok := b.vaToRaw(endVA - 1)
	if !ok || end < start {
		return nil
	}
	end++
	var out []int
	for raw := start; raw < end; raw++ {
		prefix := 0
		if b.data[raw] >= 0x40 && b.data[raw] <= 0x4f {
			prefix = 1
		}
		if raw+prefix+6 > end || (b.data[raw+prefix] != 0x8b && b.data[raw+prefix] != 0x8d) || b.data[raw+prefix+1]&0xc7 != 0x05 {
			continue
		}
		length := prefix + 6
		instructionVA := startVA + uint64(raw-start)
		displacement := int64(int32(binary.LittleEndian.Uint32(b.data[raw+prefix+2:])))
		targetVA := uint64(int64(instructionVA+uint64(length)) + displacement)
		targetRaw, mapped := b.vaToRaw(targetVA)
		if !mapped || targetRaw+8 > len(b.data) {
			continue
		}
		encoded := binary.LittleEndian.Uint64(b.data[targetRaw:])
		if encoded>>29&7 == 3 {
			index := int((encoded & 0x1fff_ffff) >> 1)
			if index >= 0 && index < methodCount {
				out = append(out, index)
			}
		}
	}
	return out
}

// ImmediateEDXBefore finds the closest MOV EDX, imm32 before a call. RotMG's
// AddListener sites use this value as the signed packet ID.
func (b *Binary) ImmediateEDXBefore(callVA uint64, backBytes int) (int32, bool) {
	if backBytes <= 0 {
		backBytes = 64
	}
	callRaw, ok := b.vaToRaw(callVA)
	if !ok {
		return 0, false
	}
	start := callRaw - backBytes
	if start < 0 {
		start = 0
	}
	var value int32
	found := false
	for raw := start; raw < callRaw; raw++ {
		if b.data[raw] == 0xba && raw+5 <= callRaw {
			value, found = int32(binary.LittleEndian.Uint32(b.data[raw+1:])), true
			raw += 4
			continue
		}
		if raw+2 <= callRaw && (b.data[raw] == 0x31 || b.data[raw] == 0x33) && b.data[raw+1] == 0xd2 {
			value, found = 0, true // XOR EDX, EDX
			raw++
		}
	}
	return value, found
}

// RVA converts a virtual address to its image-relative address.
func (b *Binary) RVA(va uint64) uint64 {
	if va < b.imageBase {
		return 0
	}
	return va - b.imageBase
}

// VA converts an image-relative address to the preferred virtual address used
// by the file's native code and exception table.
func (b *Binary) VA(rva uint64) uint64 { return b.imageBase + rva }

// Fingerprint hashes the decoded instruction shape and stable operands of up
// to maxBytes of native code. PC-relative calls and RIP-relative data offsets
// are normalized, so address shuffling alone does not report a code change.
func (b *Binary) Fingerprint(va uint64, maxBytes int) (string, error) {
	if maxBytes <= 0 {
		maxBytes = 4096
	}
	raw, ok := b.vaToRaw(va)
	if !ok {
		return "", fmt.Errorf("VA %#x is not mapped", va)
	}
	if maxBytes > len(b.data)-raw {
		maxBytes = len(b.data) - raw
	}
	code := b.data[raw : raw+maxBytes]
	normalized := make([]byte, 0, len(code)*2)
	for len(code) > 0 {
		instruction, err := x86asm.Decode(code, 64)
		if err != nil || instruction.Len <= 0 {
			// Preserve undecodable bytes so real data/code changes remain visible.
			normalized = append(normalized, 0xff, code[0])
			code = code[1:]
			continue
		}
		normalized = binary.LittleEndian.AppendUint16(normalized, uint16(instruction.Op))
		for _, argument := range instruction.Args {
			switch arg := argument.(type) {
			case nil:
				normalized = append(normalized, 0)
			case x86asm.Reg:
				normalized = append(normalized, 1)
				normalized = binary.LittleEndian.AppendUint16(normalized, uint16(arg))
			case x86asm.Imm:
				normalized = append(normalized, 2)
				normalized = binary.LittleEndian.AppendUint64(normalized, uint64(arg))
			case x86asm.Rel:
				normalized = append(normalized, 3) // destination intentionally omitted
			case x86asm.Mem:
				normalized = append(normalized, 4)
				normalized = binary.LittleEndian.AppendUint16(normalized, uint16(arg.Segment))
				normalized = binary.LittleEndian.AppendUint16(normalized, uint16(arg.Base))
				normalized = binary.LittleEndian.AppendUint16(normalized, uint16(arg.Index))
				normalized = append(normalized, byte(arg.Scale))
				if arg.Base == x86asm.RIP {
					normalized = binary.LittleEndian.AppendUint64(normalized, 0)
				} else {
					normalized = binary.LittleEndian.AppendUint64(normalized, uint64(arg.Disp))
				}
			default:
				normalized = append(normalized, 0xfe)
			}
		}
		code = code[instruction.Len:]
	}
	sum := sha256.Sum256(normalized)
	return fmt.Sprintf("%x", sum[:12]), nil
}

func (b *Binary) rawToVA(raw int) (uint64, bool) {
	for _, s := range b.sections {
		if raw >= int(s.rawOffset) && raw < int(s.rawOffset+s.rawSize) {
			return b.imageBase + uint64(s.rva) + uint64(raw-int(s.rawOffset)), true
		}
	}
	return 0, false
}

func (b *Binary) vaToRaw(va uint64) (int, bool) {
	if va < b.imageBase {
		return 0, false
	}
	rva := va - b.imageBase
	for _, s := range b.sections {
		limit := uint64(s.virtualSize)
		if uint64(s.rawSize) < limit {
			limit = uint64(s.rawSize)
		}
		if rva >= uint64(s.rva) && rva < uint64(s.rva)+limit {
			return int(s.rawOffset) + int(rva-uint64(s.rva)), true
		}
	}
	return 0, false
}

func (b *Binary) isExecutableVA(va uint64) bool {
	if va < b.imageBase {
		return false
	}
	rva := va - b.imageBase
	for _, s := range b.sections {
		if rva >= uint64(s.rva) && rva < uint64(s.rva)+uint64(s.virtualSize) {
			return s.characteristics&pe.IMAGE_SCN_MEM_EXECUTE != 0
		}
	}
	return false
}
