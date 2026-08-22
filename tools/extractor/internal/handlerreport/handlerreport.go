// Package handlerreport finds managed/native packet handling entry points and
// produces code fingerprints suitable for build-to-build comparison.
package handlerreport

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"unicode"

	"rotmg-extractor/internal/buildscan"
	"rotmg-extractor/internal/il2cppnative"
	"rotmg-extractor/internal/metadata"
	"rotmg-extractor/internal/packetmap"
)

// Options controls optional enrichment sources.
type Options struct {
	PacketMapPath string
	AutoPacketMap bool
	IncludeType   string
	IncludeReturn string
}

// Function describes one packet-related managed method and its native body.
type Function struct {
	Identity       string                      `json:"identity"`
	Type           string                      `json:"type"`
	Method         string                      `json:"method"`
	Parameters     []string                    `json:"parameters,omitempty"`
	ReturnType     string                      `json:"return_type,omitempty"`
	Token          uint32                      `json:"token"`
	RVA            uint64                      `json:"rva,omitempty"`
	NativeSize     uint64                      `json:"native_size,omitempty"`
	Fingerprint    string                      `json:"fingerprint,omitempty"`
	PacketIDs      []int                       `json:"packet_ids,omitempty"`
	PacketNames    []packetmap.Entry           `json:"packet_names,omitempty"`
	TypeReferences []il2cppnative.ResolvedType `json:"type_references,omitempty"`
	DirectCalls    []NativeCall                `json:"direct_calls,omitempty"`
	Role           string                      `json:"role"`
	Direction      string                      `json:"direction,omitempty"`
	Confidence     int                         `json:"confidence"`
	Evidence       []string                    `json:"evidence"`
}

// NativeCall is a direct native call target and any managed methods sharing it.
type NativeCall struct {
	RVA     uint64   `json:"rva"`
	Managed []string `json:"managed,omitempty"`
}

// PacketCandidate is a deliberately non-authoritative name suggestion for an
// unmapped listener ID, ranked from handler subsystem and current catalog text.
type PacketCandidate struct {
	ID        int      `json:"id"`
	Name      string   `json:"name"`
	Direction string   `json:"direction"`
	Score     int      `json:"score"`
	Evidence  []string `json:"evidence"`
}

// Report is one build's packet-handler inventory.
type Report struct {
	Build                string            `json:"build"`
	Path                 string            `json:"path"`
	Metadata             metadata.Info     `json:"metadata"`
	ManagedMethodCount   int               `json:"managed_method_count"`
	CodegenModule        string            `json:"codegen_module"`
	NativePointers       int               `json:"native_pointer_count"`
	MetadataRegistration uint64            `json:"metadata_registration_va,omitempty"`
	AddListenerAliases   []string          `json:"add_listener_pointer_aliases,omitempty"`
	PacketMapSource      string            `json:"packet_map_source,omitempty"`
	PacketMapFormat      string            `json:"packet_map_format,omitempty"`
	PacketMapEntries     int               `json:"packet_map_entries,omitempty"`
	PacketMapMatches     int               `json:"packet_map_catalog_matches,omitempty"`
	PacketMapConflicts   int               `json:"packet_map_conflicts,omitempty"`
	NativePacketIDs      []int             `json:"native_listener_packet_ids,omitempty"`
	NativeMappedIDs      []int             `json:"mapped_native_listener_packet_ids,omitempty"`
	UnmappedPacketIDs    []int             `json:"unmapped_native_listener_packet_ids,omitempty"`
	PacketMappings       []packetmap.Entry `json:"packet_mappings,omitempty"`
	UnmappedCandidates   []PacketCandidate `json:"unmapped_candidates,omitempty"`
	MessageFactories     []MessageFactory  `json:"message_factories,omitempty"`
	Functions            []Function        `json:"functions"`
	Catalog              []metadata.Type   `json:"-"`
}

// MessageFactory is a client-native byte-ID registry recovered from a static
// constructor. Unlike listener registrations, this directly associates IDs
// with the concrete managed packet types the client instantiates.
type MessageFactory struct {
	Type             string           `json:"type"`
	Kind             string           `json:"kind"`
	LookupMethod     string           `json:"lookup_method,omitempty"`
	DelegatesTo      string           `json:"delegates_to,omitempty"`
	DelegatedEntries int              `json:"delegated_entries,omitempty"`
	DelegatedIDs     []int            `json:"delegated_ids,omitempty"`
	DanglingIDs      []int            `json:"dangling_delegated_ids,omitempty"`
	InitializerRVA   uint64           `json:"initializer_rva"`
	RegistryEntries  int              `json:"registry_entries"`
	ResolvedEntries  int              `json:"resolved_entries"`
	Bindings         []FactoryBinding `json:"bindings"`
}

// FactoryBinding is one exact ID-to-managed-type entry in a client registry.
type FactoryBinding struct {
	ID                int               `json:"id"`
	ManagedType       string            `json:"managed_type"`
	StaticFieldOffset uint32            `json:"static_field_offset"`
	Packet            *packetmap.Entry  `json:"packet,omitempty"`
	NameCandidates    []PacketCandidate `json:"name_candidates,omitempty"`
	Confidence        int               `json:"confidence"`
	Evidence          []string          `json:"evidence"`
}

// Diff compares handler identities and their exact native fingerprints.
type Diff struct {
	Old            string          `json:"old"`
	New            string          `json:"new"`
	Added          []Function      `json:"added"`
	Removed        []Function      `json:"removed"`
	Changed        []Change        `json:"changed"`
	BindingChanges []BindingChange `json:"packet_binding_changes"`
	FactoryChanges []FactoryChange `json:"factory_id_changes,omitempty"`
}

// FactoryChange reports IDs added to or removed from the same native factory
// shape across builds; obfuscated type names are intentionally not used as the
// stable factory identity.
type FactoryChange struct {
	Kind     string           `json:"kind"`
	OldCount int              `json:"old_count"`
	NewCount int              `json:"new_count"`
	Added    []FactoryBinding `json:"added,omitempty"`
	Removed  []FactoryBinding `json:"removed,omitempty"`
}

// Change is one stable managed function whose native body changed.
type Change struct {
	Identity       string `json:"identity"`
	OldRVA         uint64 `json:"old_rva"`
	NewRVA         uint64 `json:"new_rva"`
	OldFingerprint string `json:"old_fingerprint"`
	NewFingerprint string `json:"new_fingerprint"`
}

// BindingChange is a stable callback/listener method whose registered packet
// IDs changed between builds.
type BindingChange struct {
	Identity string            `json:"identity"`
	OldIDs   []int             `json:"old_ids"`
	NewIDs   []int             `json:"new_ids"`
	Names    []packetmap.Entry `json:"new_packet_names,omitempty"`
}

// Extract decrypts metadata, parses all managed methods, resolves native
// pointers, and ranks packet-related entry points by evidence.
func Extract(path string) (Report, error) {
	return ExtractWithOptions(path, Options{AutoPacketMap: true})
}

// ExtractWithOptions performs handler discovery with optional packet-name map
// enrichment.
func ExtractWithOptions(path string, options Options) (Report, error) {
	artifacts, err := buildscan.Resolve(path, "")
	if err != nil {
		return Report{}, err
	}
	if artifacts.GameAssembly == "" {
		return Report{}, fmt.Errorf("GameAssembly was not found under %s", artifacts.Root)
	}
	data, info, err := buildscan.Load(artifacts, metadata.DefaultVersion)
	if err != nil {
		return Report{}, err
	}
	methods, err := metadata.Methods(data)
	if err != nil {
		return Report{}, err
	}
	catalog, err := metadata.Catalog(data)
	if err != nil {
		return Report{}, err
	}
	definitions, err := metadata.Definitions(data)
	if err != nil {
		return Report{}, err
	}
	images, err := metadata.Images(data)
	if err != nil {
		return Report{}, err
	}
	image, ok := findGameImage(images)
	if !ok {
		return Report{}, fmt.Errorf("Assembly-CSharp image is absent from metadata")
	}
	var names packetmap.Map
	if options.PacketMapPath != "" || options.AutoPacketMap {
		names, err = packetmap.Load(options.PacketMapPath, catalog)
		if err != nil && !(options.PacketMapPath == "" && errors.Is(err, os.ErrNotExist)) {
			return Report{}, fmt.Errorf("loading packet map: %w", err)
		}
		if err != nil {
			names = packetmap.Map{}
		}
	}
	native, err := il2cppnative.Load(artifacts.GameAssembly)
	if err != nil {
		return Report{}, err
	}
	maxRow := 0
	for _, method := range methods {
		if method.DeclaringTypeIndex >= image.FirstTypeIndex && method.DeclaringTypeIndex < image.FirstTypeIndex+image.TypeCount {
			if row := int(method.Token & 0x00ffffff); row > maxRow {
				maxRow = row
			}
		}
	}
	module, err := native.FindModule(image.Name, maxRow)
	if err != nil {
		return Report{}, err
	}
	typeNames := make([]string, len(definitions))
	for i := range definitions {
		typeNames[i] = definitions[i].FullName()
	}
	typeTable, typeErr := native.FindTypeTable(len(definitions))

	report := Report{
		Build: buildscan.Label(artifacts), Path: artifacts.Root, Metadata: info,
		ManagedMethodCount: len(methods), CodegenModule: image.Name, NativePointers: module.MethodPointerCount,
		Catalog: catalog,
	}
	if names.Source != "" {
		report.PacketMapSource, report.PacketMapFormat, report.PacketMapEntries = names.Source, names.Format, len(names.Entries)
		for _, entry := range names.Entries {
			if entry.CatalogName != "" {
				report.PacketMapMatches++
			}
		}
	}
	if typeErr == nil {
		report.MetadataRegistration = typeTable.RegistrationVA
	}
	gameMethods := make([]metadata.Method, 0, maxRow)
	methodsByPointer := map[uint64][]metadata.Method{}
	var addListenerPointer uint64
	for _, method := range methods {
		if method.DeclaringTypeIndex < image.FirstTypeIndex || method.DeclaringTypeIndex >= image.FirstTypeIndex+image.TypeCount {
			continue
		}
		gameMethods = append(gameMethods, method)
		if pointer, found := module.MethodPointer(method.Token); found {
			methodsByPointer[pointer] = append(methodsByPointer[pointer], method)
			if strings.Contains(strings.ToLower(method.DeclaringType.FullName()), "socketmanager") && strings.EqualFold(method.Name, "AddListener") {
				addListenerPointer = pointer
			}
		}
	}
	for _, method := range methodsByPointer[addListenerPointer] {
		report.AddListenerAliases = append(report.AddListenerAliases, method.DeclaringType.FullName()+"."+method.Name)
	}
	sort.Strings(report.AddListenerAliases)
	makeFunction := func(method metadata.Method) Function {
		fn := Function{Type: method.DeclaringType.FullName(), Method: method.Name, Token: method.Token}
		fn.ReturnType = fmt.Sprintf("type#%d", method.ReturnTypeIndex)
		if typeErr == nil {
			if resolved, resolveErr := typeTable.Resolve(method.ReturnTypeIndex, typeNames); resolveErr == nil {
				fn.ReturnType = resolved.DisplayName
			}
		}
		for _, parameter := range method.Parameters {
			name := fmt.Sprintf("type#%d", parameter.TypeIndex)
			if typeErr == nil {
				if resolved, resolveErr := typeTable.Resolve(parameter.TypeIndex, typeNames); resolveErr == nil {
					name = resolved.DisplayName
				}
			}
			fn.Parameters = append(fn.Parameters, name)
		}
		fn.Identity = identity(fn.Type, fn.Method, fn.Parameters)
		if pointer, found := module.MethodPointer(method.Token); found {
			fn.RVA = native.RVA(pointer)
			fingerprintBytes := 4096
			if start, end, bounded := native.FunctionRange(pointer); bounded && start == pointer && end > start {
				fingerprintBytes = int(end - start)
				fn.NativeSize = end - start
			} else if start, end, bounded := module.FunctionContaining(pointer); bounded && start == pointer && end > start && end-start < uint64(fingerprintBytes) {
				fingerprintBytes = int(end - start)
				fn.NativeSize = end - start
			}
			if fn.NativeSize == 0 {
				fn.NativeSize = uint64(fingerprintBytes)
			}
			fn.Fingerprint, _ = native.Fingerprint(pointer, fingerprintBytes)
			if typeErr == nil {
				fn.TypeReferences = native.MetadataTypeReferences(pointer, pointer+uint64(fingerprintBytes), typeTable, typeNames)
			}
			for _, target := range native.DirectCallTargets(pointer, pointer+uint64(fingerprintBytes)) {
				call := NativeCall{RVA: native.RVA(target)}
				for _, targetMethod := range methodsByPointer[target] {
					call.Managed = append(call.Managed, targetMethod.DeclaringType.FullName()+"."+targetMethod.Name)
				}
				sort.Strings(call.Managed)
				fn.DirectCalls = append(fn.DirectCalls, call)
			}
		}
		return fn
	}
	if typeErr == nil {
		report.MessageFactories = recoverMessageFactories(native, module, gameMethods, catalog, typeTable, typeNames, names)
	}
	byIdentity := map[string]Function{}
	for _, method := range methods {
		if method.DeclaringTypeIndex < image.FirstTypeIndex || method.DeclaringTypeIndex >= image.FirstTypeIndex+image.TypeCount {
			continue
		}
		fn, include := classify(method)
		if !include && options.IncludeType != "" && strings.Contains(strings.ToLower(method.DeclaringType.FullName()), strings.ToLower(options.IncludeType)) {
			fn = Function{Type: method.DeclaringType.FullName(), Method: method.Name, Token: method.Token, Role: "selected managed type method", Confidence: 100, Evidence: []string{"declaring type selected with --managed-type"}}
			include = true
		}
		if !include && options.IncludeReturn != "" {
			returnType := fmt.Sprintf("type#%d", method.ReturnTypeIndex)
			if typeErr == nil {
				if resolved, resolveErr := typeTable.Resolve(method.ReturnTypeIndex, typeNames); resolveErr == nil {
					returnType = resolved.DisplayName
				}
			}
			if strings.Contains(strings.ToLower(returnType), strings.ToLower(options.IncludeReturn)) {
				fn = Function{Type: method.DeclaringType.FullName(), Method: method.Name, Token: method.Token, Role: "selected return-type method", Confidence: 100, Evidence: []string{"return type selected with --returns-type"}}
				include = true
			}
		}
		if !include {
			continue
		}
		resolved := makeFunction(method)
		fn.Parameters, fn.ReturnType, fn.Identity, fn.RVA, fn.NativeSize, fn.Fingerprint = resolved.Parameters, resolved.ReturnType, resolved.Identity, resolved.RVA, resolved.NativeSize, resolved.Fingerprint
		fn.TypeReferences = resolved.TypeReferences
		fn.DirectCalls = resolved.DirectCalls
		if fn.RVA != 0 {
			fn.Evidence = append(fn.Evidence, "native method pointer resolved from Assembly-CSharp token")
		}
		byIdentity[fn.Identity] = fn
	}
	// Metadata obfuscates most registration method names. Direct native calls to
	// SocketManager.AddListener recover those sites, and RIP-relative LEAs in
	// the same functions reveal callbacks passed while delegates are built.
	if addListenerPointer != 0 {
		for _, callSite := range native.DirectCallSites(addListenerPointer) {
			start, end, found := module.FunctionContaining(callSite)
			if !found {
				continue
			}
			for _, method := range methodsByPointer[start] {
				fn := makeFunction(method)
				fn.Role, fn.Confidence = "packet listener registration site", 95
				fn.Evidence = []string{fmt.Sprintf("native call at RVA 0x%X targets SocketManager.AddListener", native.RVA(callSite))}
				if packetID, ok := native.ImmediateEDXBefore(callSite, 64); ok {
					fn.PacketIDs = []int{int(uint8(packetID))}
					fn.Evidence = append(fn.Evidence, fmt.Sprintf("packet ID %d loaded into EDX", uint8(packetID)))
				}
				byIdentity[fn.Identity] = prefer(byIdentity[fn.Identity], fn)
			}
			for _, target := range native.RIPRelativeCodeReferences(start, end) {
				for _, method := range methodsByPointer[target] {
					if target == addListenerPointer {
						continue
					}
					fn := makeFunction(method)
					fn.Role, fn.Confidence = "registered listener callback candidate", 85
					fn.Evidence = []string{fmt.Sprintf("function pointer referenced by AddListener caller at RVA 0x%X", native.RVA(start))}
					byIdentity[fn.Identity] = prefer(byIdentity[fn.Identity], fn)
				}
			}
			if methodIndex, ok := native.NearestMetadataMethodReference(callSite, 192, len(methods)); ok {
				method := methods[methodIndex]
				if method.DeclaringTypeIndex >= image.FirstTypeIndex && method.DeclaringTypeIndex < image.FirstTypeIndex+image.TypeCount {
					fn := makeFunction(method)
					fn.Role, fn.Confidence = "registered packet callback", 99
					fn.Evidence = []string{fmt.Sprintf("nearest MethodDef delegate reference before AddListener call at RVA 0x%X", native.RVA(callSite))}
					if packetID, foundID := native.ImmediateEDXBefore(callSite, 64); foundID {
						fn.PacketIDs = []int{int(uint8(packetID))}
						fn.Evidence = append(fn.Evidence, fmt.Sprintf("registered for packet ID %d", uint8(packetID)))
					}
					byIdentity[fn.Identity] = prefer(byIdentity[fn.Identity], fn)
				}
			}
		}
	}
	nativeIDs, mappedIDs := map[int]bool{}, map[int]bool{}
	for _, fn := range byIdentity {
		directions := map[string]bool{}
		for _, id := range fn.PacketIDs {
			if entry, found := names.Entries[id]; found {
				if entry.CatalogName != "" && entry.Confidence < 95 {
					entry.Confidence = 95
					entry.Provenance = addProvenance(entry.Provenance, "native listener ID match")
				}
				names.Entries[id] = entry
				fn.PacketNames = append(fn.PacketNames, entry)
				mappedIDs[id] = true
				if entry.Direction != "" {
					directions[entry.Direction] = true
				}
			}
			if fn.Role == "registered packet callback" {
				nativeIDs[id] = true
			}
		}
		if len(directions) == 1 {
			for direction := range directions {
				fn.Direction = direction
			}
		} else if len(directions) > 1 {
			fn.Direction = "mixed"
		}
		sort.Slice(fn.PacketNames, func(i, j int) bool { return fn.PacketNames[i].ID < fn.PacketNames[j].ID })
		report.Functions = append(report.Functions, fn)
	}
	for id := range nativeIDs {
		report.NativePacketIDs = append(report.NativePacketIDs, id)
	}
	for id := range mappedIDs {
		if nativeIDs[id] {
			report.NativeMappedIDs = append(report.NativeMappedIDs, id)
		}
	}
	for id := range nativeIDs {
		if !mappedIDs[id] {
			report.UnmappedPacketIDs = append(report.UnmappedPacketIDs, id)
		}
	}
	sort.Ints(report.NativePacketIDs)
	sort.Ints(report.NativeMappedIDs)
	sort.Ints(report.UnmappedPacketIDs)
	report.PacketMappings = names.SortedEntries()
	report.UnmappedCandidates = rankUnmappedCandidates(catalog, names, byIdentity, nativeIDs)
	for _, entry := range report.PacketMappings {
		if entry.Conflict != "" {
			report.PacketMapConflicts++
		}
	}
	sort.Slice(report.Functions, func(i, j int) bool {
		if report.Functions[i].Confidence != report.Functions[j].Confidence {
			return report.Functions[i].Confidence > report.Functions[j].Confidence
		}
		return report.Functions[i].Identity < report.Functions[j].Identity
	})
	return report, nil
}

func recoverMessageFactories(native *il2cppnative.Binary, module il2cppnative.Module, methods []metadata.Method, catalog []metadata.Type, typeTable il2cppnative.TypeTable, typeNames []string, packetNames packetmap.Map) []MessageFactory {
	methodsByType := map[int][]metadata.Method{}
	for _, method := range methods {
		methodsByType[method.DeclaringTypeIndex] = append(methodsByType[method.DeclaringTypeIndex], method)
	}
	var factories []MessageFactory
	factoryReturnTypes := map[string]bool{}
	for _, initializer := range methods {
		if initializer.Name != ".cctor" {
			continue
		}
		pointer, found := module.MethodPointer(initializer.Token)
		if !found {
			continue
		}
		start, end, bounded := native.FunctionRange(pointer)
		if !bounded || start != pointer {
			continue
		}
		rawBindings := native.ByteStaticFieldBindings(start, end)
		if len(rawBindings) < 20 {
			continue
		}
		stores := native.StaticFieldStores(start, end)
		sites := native.MetadataTypeReferenceSites(start, end, typeTable, typeNames)
		typeByOffset := correlateFactoryTypes(stores, sites)
		factory := MessageFactory{
			Type: initializer.DeclaringType.FullName(), Kind: "static byte registry", InitializerRVA: native.RVA(pointer), RegistryEntries: len(rawBindings),
		}
		for _, method := range methodsByType[initializer.DeclaringTypeIndex] {
			if len(method.Parameters) != 1 {
				continue
			}
			parameter, parameterErr := typeTable.Resolve(method.Parameters[0].TypeIndex, typeNames)
			result, resultErr := typeTable.Resolve(method.ReturnTypeIndex, typeNames)
			if parameterErr == nil && resultErr == nil && parameter.DisplayName == "byte" && result.DisplayName != "void" {
				factory.LookupMethod = method.DeclaringType.FullName() + "." + method.Name
				factoryReturnTypes[result.DisplayName] = true
				break
			}
		}
		for _, raw := range rawBindings {
			managedType := typeByOffset[raw.Offset]
			binding := FactoryBinding{
				ID: raw.ID, ManagedType: managedType, StaticFieldOffset: raw.Offset,
				Confidence: 70,
				Evidence: []string{
					fmt.Sprintf("native registry insertion at RVA 0x%X uses byte ID %d", raw.RVA, raw.ID),
					fmt.Sprintf("registry value loads a cached factory from static field +0x%X", raw.Offset),
				},
			}
			if managedType != "" {
				binding.Confidence = 100
				binding.Evidence = append(binding.Evidence, fmt.Sprintf("that field is initialized as a factory for managed type %s", managedType))
				factory.ResolvedEntries++
			}
			if entry, ok := packetNames.Entries[raw.ID]; ok {
				copy := entry
				binding.Packet = &copy
			} else {
				binding.NameCandidates = factoryNameCandidates(raw.ID, managedType, methodsByType, catalog, typeTable, typeNames, packetNames)
			}
			factory.Bindings = append(factory.Bindings, binding)
		}
		sort.Slice(factory.Bindings, func(i, j int) bool { return factory.Bindings[i].ID < factory.Bindings[j].ID })
		if len(factory.Bindings) >= 20 {
			factories = append(factories, factory)
		}
	}
	for _, method := range methods {
		if len(method.Parameters) != 1 {
			continue
		}
		parameter, parameterErr := typeTable.Resolve(method.Parameters[0].TypeIndex, typeNames)
		result, resultErr := typeTable.Resolve(method.ReturnTypeIndex, typeNames)
		if parameterErr != nil || resultErr != nil || parameter.DisplayName != "byte" || !factoryReturnTypes[result.DisplayName] {
			continue
		}
		pointer, found := module.MethodPointer(method.Token)
		if !found {
			continue
		}
		start, end, bounded := native.FunctionRange(pointer)
		if !bounded || start != pointer {
			continue
		}
		cases := native.ByteSwitchCases(start, end)
		if len(cases) < 2 {
			continue
		}
		factory := MessageFactory{
			Type: method.DeclaringType.FullName(), Kind: "native byte switch",
			LookupMethod:   method.DeclaringType.FullName() + "." + method.Name,
			InitializerRVA: native.RVA(pointer), RegistryEntries: len(cases),
		}
		for _, switchCase := range cases {
			blockEnd := switchCase.TargetVA + 64
			if blockEnd > end {
				blockEnd = end
			}
			managedType := ""
			for _, site := range native.MetadataTypeReferenceSites(switchCase.TargetVA, blockEnd, typeTable, typeNames) {
				if site.Type.TypeDefinitionIndex >= 0 {
					managedType = site.Type.DisplayName
					break
				}
			}
			delegated := false
			for _, existing := range factories {
				if managedType == existing.Type {
					factory.DelegatesTo = managedType
					delegated = true
					break
				}
			}
			if delegated {
				factory.DelegatedEntries++
				factory.DelegatedIDs = append(factory.DelegatedIDs, switchCase.ID)
				continue
			}
			if managedType == "" {
				continue
			}
			binding := FactoryBinding{
				ID: switchCase.ID, ManagedType: managedType, Confidence: 95,
				Evidence: []string{fmt.Sprintf("native byte switch routes ID %d to RVA 0x%X", switchCase.ID, native.RVA(switchCase.TargetVA))},
			}
			if managedType != "" {
				binding.Confidence = 100
				binding.Evidence = append(binding.Evidence, "case block constructs or delegates to managed type "+managedType)
				factory.ResolvedEntries++
			}
			if entry, ok := packetNames.Entries[switchCase.ID]; ok {
				copy := entry
				binding.Packet = &copy
			} else {
				binding.NameCandidates = factoryNameCandidates(switchCase.ID, managedType, methodsByType, catalog, typeTable, typeNames, packetNames)
			}
			factory.Bindings = append(factory.Bindings, binding)
		}
		factory.RegistryEntries = factory.DelegatedEntries + len(factory.Bindings)
		factories = append(factories, factory)
	}
	bindingsByFactory := map[string]map[int]bool{}
	for _, factory := range factories {
		ids := map[int]bool{}
		for _, binding := range factory.Bindings {
			ids[binding.ID] = true
		}
		bindingsByFactory[factory.Type] = ids
	}
	for i := range factories {
		if factories[i].DelegatesTo == "" {
			continue
		}
		known := bindingsByFactory[factories[i].DelegatesTo]
		for _, id := range factories[i].DelegatedIDs {
			if !known[id] {
				factories[i].DanglingIDs = append(factories[i].DanglingIDs, id)
			}
		}
	}
	sort.Slice(factories, func(i, j int) bool { return factories[i].Type < factories[j].Type })
	return factories
}

func factoryNameCandidates(id int, managedType string, methodsByType map[int][]metadata.Method, catalog []metadata.Type, typeTable il2cppnative.TypeTable, typeNames []string, packetNames packetmap.Map) []PacketCandidate {
	typeIndex := -1
	for index, name := range typeNames {
		if name == managedType {
			typeIndex = index
			break
		}
	}
	if typeIndex < 0 {
		return nil
	}
	references := map[string]bool{}
	referenceDirection := ""
	for _, method := range methodsByType[typeIndex] {
		indices := []int{method.ReturnTypeIndex}
		for _, parameter := range method.Parameters {
			indices = append(indices, parameter.TypeIndex)
		}
		for _, index := range indices {
			resolved, err := typeTable.Resolve(index, typeNames)
			if err == nil && !looksObfuscated(resolved.DisplayName) {
				references[resolved.DisplayName] = true
				lower := strings.ToLower(resolved.DisplayName)
				if strings.Contains(lower, ".messages.incoming.") {
					referenceDirection = "incoming"
				} else if strings.Contains(lower, ".messages.outgoing.") && referenceDirection == "" {
					referenceDirection = "outgoing"
				}
			}
		}
	}
	used := map[string]bool{}
	for _, entry := range packetNames.Entries {
		used[canonicalName(entry.CatalogName)] = true
	}
	var candidates []PacketCandidate
	for _, typ := range catalog {
		lowerNamespace := strings.ToLower(typ.Namespace)
		direction := ""
		switch {
		case strings.Contains(lowerNamespace, ".messages.incoming"):
			direction = "incoming"
		case strings.Contains(lowerNamespace, ".messages.outgoing"):
			direction = "outgoing"
		default:
			continue
		}
		if used[canonicalName(typ.Name)] || references[typ.FullName()] || references[typ.Name] {
			continue
		}
		candidateTokens := semanticTokens(typ.Name)
		score := 0
		var evidence []string
		for reference := range references {
			overlap := 0
			for token := range semanticTokens(reference) {
				if len(token) >= 4 && candidateTokens[token] {
					overlap++
				}
			}
			if overlap > 0 {
				candidateScore := 55 + overlap*20
				if strings.Contains(strings.ToLower(typ.Name), "message") {
					candidateScore += 10
				}
				if referenceDirection != "" && direction == referenceDirection {
					candidateScore += 10
				}
				if candidateScore > score {
					score = candidateScore
					evidence = []string{fmt.Sprintf("%s methods directly expose %s; candidate shares %d semantic token(s)", managedType, reference, overlap)}
				}
			}
		}
		if score > 0 {
			if score > 95 {
				score = 95
			}
			candidates = append(candidates, PacketCandidate{ID: id, Name: typ.Name, Direction: direction, Score: score, Evidence: evidence})
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Score != candidates[j].Score {
			return candidates[i].Score > candidates[j].Score
		}
		return candidates[i].Name < candidates[j].Name
	})
	if len(candidates) > 3 {
		candidates = candidates[:3]
	}
	return candidates
}

func looksObfuscated(name string) bool {
	if name == "" {
		return true
	}
	last := name
	if dot := strings.LastIndexByte(last, '.'); dot >= 0 {
		last = last[dot+1:]
	}
	if len(last) != 11 {
		return false
	}
	for _, r := range last {
		if r < 'A' || r > 'P' {
			return false
		}
	}
	return true
}

func correlateFactoryTypes(stores []il2cppnative.StaticFieldStore, sites []il2cppnative.TypeReferenceSite) map[uint32]string {
	out := map[uint32]string{}
	previousRVA := uint64(0)
	for _, store := range stores {
		counts := map[string]int{}
		for _, site := range sites {
			if site.RVA <= previousRVA || site.RVA > store.RVA {
				continue
			}
			for _, argument := range site.Type.GenericArguments {
				collectConcreteGenericTypes(argument, counts)
			}
		}
		best, bestCount := "", 0
		for candidate, count := range counts {
			if count > bestCount || count == bestCount && candidate < best {
				best, bestCount = candidate, count
			}
		}
		if best != "" {
			out[store.Offset] = best
		}
		previousRVA = store.RVA
	}
	return out
}

func collectConcreteGenericTypes(typ il2cppnative.ResolvedType, counts map[string]int) {
	if len(typ.GenericArguments) > 0 {
		for _, argument := range typ.GenericArguments {
			collectConcreteGenericTypes(argument, counts)
		}
		return
	}
	if typ.TypeDefinitionIndex >= 0 && typ.DisplayName != "" {
		counts[typ.DisplayName]++
	}
}

func addProvenance(current, evidence string) string {
	for _, item := range strings.Split(current, "; ") {
		if item == evidence {
			return current
		}
	}
	if current == "" {
		return evidence
	}
	return current + "; " + evidence
}

func rankUnmappedCandidates(catalog []metadata.Type, names packetmap.Map, functions map[string]Function, nativeIDs map[int]bool) []PacketCandidate {
	used := map[string]bool{}
	for _, entry := range names.Entries {
		if entry.CatalogName != "" {
			used[canonicalName(entry.CatalogName)] = true
		}
	}
	type catalogName struct{ name, direction string }
	var available []catalogName
	for _, typ := range catalog {
		direction := ""
		lower := strings.ToLower(typ.Namespace)
		switch {
		case strings.Contains(lower, ".net.socketserver.messages.incoming"):
			direction = "incoming"
		case strings.Contains(lower, ".net.socketserver.messages.outgoing"):
			direction = "outgoing"
		default:
			continue
		}
		if !used[canonicalName(typ.Name)] {
			available = append(available, catalogName{typ.Name, direction})
		}
	}
	contexts := map[int]map[string]bool{}
	for _, fn := range functions {
		for _, id := range fn.PacketIDs {
			if !nativeIDs[id] || names.Entries[id].Name != "" {
				continue
			}
			if contexts[id] == nil {
				contexts[id] = map[string]bool{}
			}
			for token := range semanticTokens(fn.Type) {
				contexts[id][token] = true
			}
		}
	}
	var out []PacketCandidate
	for id, context := range contexts {
		var ranked []PacketCandidate
		for _, candidate := range available {
			score := 0
			var evidence []string
			for token := range semanticTokens(candidate.name) {
				if context[token] {
					score += 30
					evidence = append(evidence, "handler context matches "+token)
				}
				for related, points := range relatedTokens(token) {
					if context[related] {
						score += points
						evidence = append(evidence, fmt.Sprintf("handler context %s is related to %s", related, token))
					}
				}
			}
			if score >= 20 {
				if score > 99 {
					score = 99
				}
				ranked = append(ranked, PacketCandidate{ID: id, Name: candidate.name, Direction: candidate.direction, Score: score, Evidence: evidence})
			}
		}
		sort.Slice(ranked, func(i, j int) bool {
			if ranked[i].Score != ranked[j].Score {
				return ranked[i].Score > ranked[j].Score
			}
			return ranked[i].Name < ranked[j].Name
		})
		if len(ranked) > 3 {
			ranked = ranked[:3]
		}
		out = append(out, ranked...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ID != out[j].ID {
			return out[i].ID < out[j].ID
		}
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func semanticTokens(value string) map[string]bool {
	var words []string
	start := 0
	runes := []rune(value)
	for i := 1; i < len(runes); i++ {
		if !unicode.IsLetter(runes[i]) && !unicode.IsDigit(runes[i]) || unicode.IsUpper(runes[i]) && unicode.IsLower(runes[i-1]) {
			if i > start {
				words = append(words, string(runes[start:i]))
			}
			start = i
			if !unicode.IsLetter(runes[i]) && !unicode.IsDigit(runes[i]) {
				start++
			}
		}
	}
	if start < len(runes) {
		words = append(words, string(runes[start:]))
	}
	out := map[string]bool{}
	stop := map[string]bool{"deca": true, "games": true, "rot": true, "mg": true, "manager": true, "managers": true, "gui": true, "ui": true, "message": true, "packet": true, "result": true, "data": true, "info": true}
	for _, word := range words {
		word = strings.ToLower(strings.Trim(word, "._+$`<>-"))
		if strings.HasSuffix(word, "s") && len(word) > 4 {
			word = strings.TrimSuffix(word, "s")
		}
		if word != "" && !stop[word] {
			out[word] = true
		}
	}
	if strings.Contains(strings.ToLower(value), "battlepass") || strings.Contains(strings.ToLower(value), "battle pass") {
		out["battlepass"], out["bp"] = true, true
	}
	if strings.Contains(value, "BP") {
		out["bp"] = true
	}
	return out
}

func relatedTokens(token string) map[string]int {
	return map[string]map[string]int{
		"gift": {"chest": 12, "shop": 8}, "reward": {"chest": 10, "battlepass": 8},
		"buy": {"shop": 12}, "purchase": {"shop": 12}, "milestone": {"battlepass": 12, "bp": 12},
		"boost": {"battlepass": 8, "bp": 8}, "claim": {"battlepass": 6, "chest": 6},
	}[token]
}

func canonicalName(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func prefer(current, candidate Function) Function {
	if current.Identity == "" || candidate.Confidence > current.Confidence {
		return candidate
	}
	if candidate.Confidence == current.Confidence {
		ids := map[int]bool{}
		for _, id := range current.PacketIDs {
			ids[id] = true
		}
		for _, id := range candidate.PacketIDs {
			ids[id] = true
		}
		current.PacketIDs = current.PacketIDs[:0]
		for id := range ids {
			current.PacketIDs = append(current.PacketIDs, id)
		}
		sort.Ints(current.PacketIDs)
		current.Evidence = append(current.Evidence, candidate.Evidence...)
	}
	return current
}

func findGameImage(images []metadata.ImageDefinition) (metadata.ImageDefinition, bool) {
	for _, image := range images {
		if strings.EqualFold(image.Name, "Assembly-CSharp.dll") {
			return image, true
		}
	}
	return metadata.ImageDefinition{}, false
}

func classify(method metadata.Method) (Function, bool) {
	owner := method.DeclaringType.FullName()
	ownerLower, nameLower := strings.ToLower(owner), strings.ToLower(method.Name)
	fn := Function{Type: owner, Method: method.Name, Token: method.Token, Confidence: 0}

	exact := map[string]struct{ role, direction string }{
		"gotmessagehandler": {"central packet dispatcher", "incoming"},
		"addlistener":       {"packet listener registration", ""},
		"removelistener":    {"packet listener registration", ""},
		"sendmessage":       {"central packet sender", "outgoing"},
	}
	if strings.Contains(ownerLower, "socketmanager") {
		if match, ok := exact[nameLower]; ok {
			fn.Role, fn.Direction, fn.Confidence = match.role, match.direction, 100
			fn.Evidence = append(fn.Evidence, "exact SocketManager network gateway")
			return fn, true
		}
	}

	score := 0
	if strings.Contains(ownerLower, ".net.") || strings.Contains(ownerLower, "socket") {
		score += 35
		fn.Evidence = append(fn.Evidence, "declaring type is in the network/socket subsystem")
	}
	if len(method.Parameters) == 1 {
		score += 10
		fn.Evidence = append(fn.Evidence, "single message-shaped parameter")
	}
	if strings.Contains(nameLower, "server") || strings.Contains(nameLower, "socket") || strings.Contains(nameLower, "packet") || strings.Contains(nameLower, "message") {
		score += 20
		fn.Evidence = append(fn.Evidence, "method name contains a network/message term")
	}
	if strings.HasPrefix(nameLower, "handle") || strings.HasPrefix(nameLower, "got") || strings.Contains(nameLower, "receive") || strings.Contains(nameLower, "dispatch") {
		score += 25
		fn.Direction = "incoming"
		fn.Evidence = append(fn.Evidence, "receive/dispatch naming pattern")
	}
	if strings.HasPrefix(nameLower, "send") {
		score += 25
		fn.Direction = "outgoing"
		fn.Evidence = append(fn.Evidence, "send naming pattern")
	}
	if strings.Contains(ownerLower, ".ui.") || strings.Contains(ownerLower, "popup") || strings.Contains(ownerLower, "widget") {
		score -= 30
	}
	if score < 50 {
		return Function{}, false
	}
	fn.Confidence = score
	if fn.Direction == "" {
		fn.Direction = "unknown"
	}
	fn.Role = "packet-handler candidate"
	return fn, true
}

func identity(owner, method string, parameters []string) string {
	return owner + "." + method + "(" + strings.Join(parameters, ",") + ")"
}

// Compare extracts and compares two builds.
func Compare(oldPath, newPath string) (Diff, error) {
	oldReport, err := ExtractWithOptions(oldPath, Options{})
	if err != nil {
		return Diff{}, fmt.Errorf("old build: %w", err)
	}
	newReport, err := ExtractWithOptions(newPath, Options{AutoPacketMap: true})
	if err != nil {
		return Diff{}, fmt.Errorf("new build: %w", err)
	}
	return CompareReports(oldReport, newReport), nil
}

// CompareReports compares two already-extracted inventories. This avoids
// rescanning the new GameAssembly during normal publishing.
func CompareReports(oldReport, newReport Report) Diff {
	diff := Diff{Old: oldReport.Build, New: newReport.Build}
	oldByID, newByID := map[string]Function{}, map[string]Function{}
	for _, fn := range oldReport.Functions {
		oldByID[fn.Identity] = fn
	}
	for _, fn := range newReport.Functions {
		newByID[fn.Identity] = fn
	}
	for id, oldFn := range oldByID {
		newFn, found := newByID[id]
		if !found {
			diff.Removed = append(diff.Removed, oldFn)
		} else {
			if oldFn.Fingerprint != "" && newFn.Fingerprint != "" && oldFn.Fingerprint != newFn.Fingerprint {
				diff.Changed = append(diff.Changed, Change{Identity: id, OldRVA: oldFn.RVA, NewRVA: newFn.RVA, OldFingerprint: oldFn.Fingerprint, NewFingerprint: newFn.Fingerprint})
			}
			if !sameInts(oldFn.PacketIDs, newFn.PacketIDs) {
				diff.BindingChanges = append(diff.BindingChanges, BindingChange{Identity: id, OldIDs: append([]int(nil), oldFn.PacketIDs...), NewIDs: append([]int(nil), newFn.PacketIDs...), Names: append([]packetmap.Entry(nil), newFn.PacketNames...)})
			}
		}
	}
	for id, newFn := range newByID {
		if _, found := oldByID[id]; !found {
			diff.Added = append(diff.Added, newFn)
		}
	}
	oldFactories, newFactories := factoriesByKind(oldReport.MessageFactories), factoriesByKind(newReport.MessageFactories)
	kinds := map[string]bool{}
	for kind := range oldFactories {
		kinds[kind] = true
	}
	for kind := range newFactories {
		kinds[kind] = true
	}
	for kind := range kinds {
		oldBindings, newBindings := oldFactories[kind], newFactories[kind]
		change := FactoryChange{Kind: kind, OldCount: len(oldBindings), NewCount: len(newBindings)}
		for id, binding := range newBindings {
			if _, found := oldBindings[id]; !found {
				change.Added = append(change.Added, promoteNewCatalogCandidate(binding, oldReport.Catalog, newReport.Catalog))
			}
		}
		for id, binding := range oldBindings {
			if _, found := newBindings[id]; !found {
				change.Removed = append(change.Removed, binding)
			}
		}
		sort.Slice(change.Added, func(i, j int) bool { return change.Added[i].ID < change.Added[j].ID })
		sort.Slice(change.Removed, func(i, j int) bool { return change.Removed[i].ID < change.Removed[j].ID })
		if len(change.Added) > 0 || len(change.Removed) > 0 {
			diff.FactoryChanges = append(diff.FactoryChanges, change)
		}
	}
	sort.Slice(diff.Added, func(i, j int) bool { return diff.Added[i].Identity < diff.Added[j].Identity })
	sort.Slice(diff.Removed, func(i, j int) bool { return diff.Removed[i].Identity < diff.Removed[j].Identity })
	sort.Slice(diff.Changed, func(i, j int) bool { return diff.Changed[i].Identity < diff.Changed[j].Identity })
	sort.Slice(diff.BindingChanges, func(i, j int) bool { return diff.BindingChanges[i].Identity < diff.BindingChanges[j].Identity })
	sort.Slice(diff.FactoryChanges, func(i, j int) bool { return diff.FactoryChanges[i].Kind < diff.FactoryChanges[j].Kind })
	return diff
}

func promoteNewCatalogCandidate(binding FactoryBinding, oldCatalog, newCatalog []metadata.Type) FactoryBinding {
	oldNames := map[string]bool{}
	for _, typ := range oldCatalog {
		oldNames[canonicalName(typ.Name)] = true
	}
	addedNames := map[string]bool{}
	for _, typ := range newCatalog {
		name := canonicalName(typ.Name)
		if !oldNames[name] {
			addedNames[name] = true
		}
	}
	for i := range binding.NameCandidates {
		if addedNames[canonicalName(binding.NameCandidates[i].Name)] {
			binding.NameCandidates[i].Score = 99
			binding.NameCandidates[i].Evidence = append(binding.NameCandidates[i].Evidence, "friendly packet type was added in the same build that added this native factory ID")
		}
	}
	sort.Slice(binding.NameCandidates, func(i, j int) bool {
		if binding.NameCandidates[i].Score != binding.NameCandidates[j].Score {
			return binding.NameCandidates[i].Score > binding.NameCandidates[j].Score
		}
		return binding.NameCandidates[i].Name < binding.NameCandidates[j].Name
	})
	return binding
}

func factoriesByKind(factories []MessageFactory) map[string]map[int]FactoryBinding {
	out := map[string]map[int]FactoryBinding{}
	for _, factory := range factories {
		if out[factory.Kind] == nil {
			out[factory.Kind] = map[int]FactoryBinding{}
		}
		for _, binding := range factory.Bindings {
			out[factory.Kind][binding.ID] = binding
		}
	}
	return out
}

func sameInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// WriteJSON writes an indented report.
func (r Report) WriteJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}

// WriteText writes a concise evidence-ranked inventory.
func (r Report) WriteText(w io.Writer) error {
	if _, err := fmt.Fprintf(w, "%s\nmanaged methods: %d\ncodegen module: %s (%d pointers)\nhandler functions: %d\n", r.Build, r.ManagedMethodCount, r.CodegenModule, r.NativePointers, len(r.Functions)); err != nil {
		return err
	}
	if r.PacketMapSource != "" {
		if _, err := fmt.Fprintf(w, "packet map: %s (%d entries, %d metadata matches, %d conflicts)\n", r.PacketMapSource, r.PacketMapEntries, r.PacketMapMatches, r.PacketMapConflicts); err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "native listener IDs: %d; mapped: %d; unmapped: %d\n", len(r.NativePacketIDs), len(r.NativeMappedIDs), len(r.UnmappedPacketIDs)); err != nil {
			return err
		}
		if len(r.UnmappedPacketIDs) > 0 {
			if _, err := fmt.Fprintf(w, "unmapped native IDs: %v\n", r.UnmappedPacketIDs); err != nil {
				return err
			}
		}
		if len(r.UnmappedCandidates) > 0 {
			if _, err := fmt.Fprintln(w, "ranked suggestions for unmapped listener IDs (heuristic, not asserted):"); err != nil {
				return err
			}
			byID := map[int][]string{}
			for _, candidate := range r.UnmappedCandidates {
				byID[candidate.ID] = append(byID[candidate.ID], fmt.Sprintf("%s/%s %d%%", candidate.Direction, candidate.Name, candidate.Score))
			}
			ids := make([]int, 0, len(byID))
			for id := range byID {
				ids = append(ids, id)
			}
			sort.Ints(ids)
			for _, id := range ids {
				if _, err := fmt.Fprintf(w, "  %d: %s\n", id, strings.Join(byID[id], "; ")); err != nil {
					return err
				}
			}
		}
	}
	if len(r.MessageFactories) > 0 {
		bindings := 0
		for _, factory := range r.MessageFactories {
			bindings += len(factory.Bindings)
		}
		if _, err := fmt.Fprintf(w, "client-native message factories: %d (%d concrete ID/type bindings; use --factory to list)\n", len(r.MessageFactories), bindings); err != nil {
			return err
		}
	}
	for _, fn := range r.Functions {
		signature := fn.Identity
		if fn.ReturnType != "" {
			signature = fn.ReturnType + " " + signature
		}
		if _, err := fmt.Fprintf(w, "\n[%d%%] %s\n  role: %s", fn.Confidence, signature, fn.Role); err != nil {
			return err
		}
		if fn.Direction != "" {
			if _, err := fmt.Fprintf(w, " / %s", fn.Direction); err != nil {
				return err
			}
		}
		if len(fn.PacketIDs) > 0 {
			if _, err := fmt.Fprintf(w, " / packet IDs %v", fn.PacketIDs); err != nil {
				return err
			}
		}
		if len(fn.PacketNames) > 0 {
			labels := make([]string, 0, len(fn.PacketNames))
			for _, packet := range fn.PacketNames {
				label := fmt.Sprintf("%d=%s", packet.ID, packet.Name)
				if packet.Type != "" && packet.Type != packet.Name {
					label += " [" + packet.Type + "]"
				}
				if packet.Conflict != "" {
					label += " CONFLICT"
				}
				labels = append(labels, label)
			}
			if _, err := fmt.Fprintf(w, "\n  names: %s", strings.Join(labels, ", ")); err != nil {
				return err
			}
		}
		if fn.Role == "registered packet callback" && len(fn.TypeReferences) > 0 {
			types := make([]string, 0, len(fn.TypeReferences))
			for _, typ := range fn.TypeReferences {
				types = append(types, typ.DisplayName)
			}
			if _, err := fmt.Fprintf(w, "\n  referenced types: %s", strings.Join(types, ", ")); err != nil {
				return err
			}
		}
		if (strings.HasPrefix(fn.Role, "selected ") || strings.HasPrefix(fn.Role, "central packet")) && len(fn.DirectCalls) > 0 {
			calls := make([]string, 0, len(fn.DirectCalls))
			for index, call := range fn.DirectCalls {
				if index == 12 {
					calls = append(calls, fmt.Sprintf("... %d more", len(fn.DirectCalls)-index))
					break
				}
				label := fmt.Sprintf("0x%X", call.RVA)
				if len(call.Managed) > 0 {
					label += "=" + strings.Join(call.Managed, "|")
				}
				calls = append(calls, label)
			}
			if _, err := fmt.Fprintf(w, "\n  direct calls: %s", strings.Join(calls, ", ")); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintf(w, "\n  token: 0x%08X  RVA: 0x%X  size: %d  code: %s\n  evidence: %s\n", fn.Token, fn.RVA, fn.NativeSize, fn.Fingerprint, strings.Join(fn.Evidence, "; ")); err != nil {
			return err
		}
	}
	return nil
}

// WriteFactoryText writes only the client-native byte-ID registries and their
// optional friendly-name annotations.
func (r Report) WriteFactoryText(w io.Writer) error {
	if _, err := fmt.Fprintf(w, "%s\nclient-native message factories: %d\n", r.Build, len(r.MessageFactories)); err != nil {
		return err
	}
	for _, factory := range r.MessageFactories {
		if _, err := fmt.Fprintf(w, "\n%s.%s [%s] RVA 0x%X\n", factory.Type, strings.TrimPrefix(factory.LookupMethod, factory.Type+"."), factory.Kind, factory.InitializerRVA); err != nil {
			return err
		}
		if factory.DelegatesTo != "" {
			if _, err := fmt.Fprintf(w, "  delegates %d IDs to %s", factory.DelegatedEntries, factory.DelegatesTo); err != nil {
				return err
			}
			if len(factory.DanglingIDs) > 0 {
				if _, err := fmt.Fprintf(w, "; delegated but absent from target registry: %v", factory.DanglingIDs); err != nil {
					return err
				}
			}
			if _, err := fmt.Fprintln(w); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintf(w, "  concrete bindings: %d\n", len(factory.Bindings)); err != nil {
			return err
		}
		for _, binding := range factory.Bindings {
			annotation := ""
			if binding.Packet != nil {
				annotation = " = " + binding.Packet.Name
				if binding.Packet.Direction != "" {
					annotation += " [" + binding.Packet.Direction + "]"
				}
			} else if len(binding.NameCandidates) > 0 {
				candidate := binding.NameCandidates[0]
				annotation = fmt.Sprintf(" ? %s [%s, %d%% heuristic]", candidate.Name, candidate.Direction, candidate.Score)
			}
			if _, err := fmt.Fprintf(w, "  %3d -> %-24s%s\n", binding.ID, binding.ManagedType, annotation); err != nil {
				return err
			}
		}
	}
	return nil
}

// WriteJSON writes an indented diff.
func (d Diff) WriteJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(d)
}

// WriteText writes changed, added, and removed handler functions.
func (d Diff) WriteText(w io.Writer) error {
	if _, err := fmt.Fprintf(w, "%s -> %s\ncode changed: %d  listener bindings changed: %d  factory ID sets changed: %d  added: %d  removed: %d\n", d.Old, d.New, len(d.Changed), len(d.BindingChanges), len(d.FactoryChanges), len(d.Added), len(d.Removed)); err != nil {
		return err
	}
	for _, change := range d.FactoryChanges {
		if _, err := fmt.Fprintf(w, "\nFACTORY %s (%d -> %d concrete IDs)\n", change.Kind, change.OldCount, change.NewCount); err != nil {
			return err
		}
		for _, binding := range change.Added {
			label := binding.ManagedType
			if binding.Packet != nil && binding.Packet.Name != "" {
				label += " = " + binding.Packet.Name
			} else if len(binding.NameCandidates) > 0 {
				candidate := binding.NameCandidates[0]
				label += fmt.Sprintf(" ? %s [%s, %d%%]", candidate.Name, candidate.Direction, candidate.Score)
			}
			if _, err := fmt.Fprintf(w, "  + %d -> %s\n", binding.ID, label); err != nil {
				return err
			}
		}
		for _, binding := range change.Removed {
			if _, err := fmt.Fprintf(w, "  - %d -> %s\n", binding.ID, binding.ManagedType); err != nil {
				return err
			}
		}
	}
	for _, change := range d.BindingChanges {
		label := ""
		if len(change.Names) > 0 {
			var names []string
			for _, entry := range change.Names {
				names = append(names, entry.Name)
			}
			label = " (" + strings.Join(names, ", ") + ")"
		}
		if _, err := fmt.Fprintf(w, "\nREBOUND %s\n  IDs %v -> %v%s\n", change.Identity, change.OldIDs, change.NewIDs, label); err != nil {
			return err
		}
	}
	for _, change := range d.Changed {
		if _, err := fmt.Fprintf(w, "\nCHANGED %s\n  RVA 0x%X -> 0x%X\n  code %s -> %s\n", change.Identity, change.OldRVA, change.NewRVA, change.OldFingerprint, change.NewFingerprint); err != nil {
			return err
		}
	}
	for _, fn := range d.Added {
		if _, err := fmt.Fprintf(w, "\nADDED   %s\n", fn.Identity); err != nil {
			return err
		}
	}
	for _, fn := range d.Removed {
		if _, err := fmt.Fprintf(w, "\nREMOVED %s\n", fn.Identity); err != nil {
			return err
		}
	}
	return nil
}
