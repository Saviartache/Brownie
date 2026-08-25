// Command metatool recovers RotMG metadata keys, decrypts metadata, and lists
// managed type names without requiring Cpp2IL or Il2CppDumper.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"rotmg-extractor/internal/buildscan"
	"rotmg-extractor/internal/il2cppnative"
	"rotmg-extractor/internal/metadata"
)

var packetNamespaces = []string{
	"Net.SocketServer.Messages.Incoming",
	"Net.SocketServer.Messages.Outgoing",
	"Net.SocketServer.Messages.Data",
}

func main() {
	if len(os.Args) < 3 {
		usage()
	}
	switch os.Args[1] {
	case "decrypt":
		decrypt(os.Args[2:])
	case "names":
		names(os.Args[2:])
	case "info":
		info(os.Args[2:])
	case "members":
		members(os.Args[2:])
	case "type":
		resolveType(os.Args[2:])
	case "method":
		resolveMethod(os.Args[2:])
	case "switch":
		resolveSwitch(os.Args[2:])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `Usage:
  metatool decrypt [-out FILE] [-assembly FILE] BUILD_OR_METADATA
  metatool names   [-namespace NS[,NS...]] [-json] [-assembly FILE] BUILD_OR_METADATA
  metatool info    [-json] [-assembly FILE] BUILD_OR_METADATA
  metatool members [-type TEXT] [-name TEXT] [-field-type-index N] [-rva] [-json] [-assembly FILE] BUILD_OR_METADATA
  metatool type    -index N [-json] [-assembly FILE] BUILD_OR_METADATA
  metatool method  -rva N [-assembly FILE] BUILD_OR_METADATA
  metatool switch  -rva N [-case N] [-assembly FILE] BUILD_OR_METADATA

BUILD_OR_METADATA may be a published build directory, game_files directory,
or a direct global-metadata.dat path.`)
	os.Exit(2)
}

func resolveSwitch(args []string) {
	fs := flag.NewFlagSet("switch", flag.ExitOnError)
	rawRVA := fs.String("rva", "", "function RVA in decimal or 0x-prefixed hexadecimal")
	wantedCase := fs.Int("case", -1, "show only this byte case")
	assembly := fs.String("assembly", "", "GameAssembly.dll override")
	_ = fs.Parse(args)
	a := mustResolve(fs, *assembly)
	if *rawRVA == "" {
		fatal(fmt.Errorf("-rva is required"))
	}
	rva, err := strconv.ParseUint(*rawRVA, 0, 64)
	if err != nil {
		fatal(fmt.Errorf("invalid -rva %q: %w", *rawRVA, err))
	}
	if a.GameAssembly == "" {
		fatal(fmt.Errorf("GameAssembly is required to decode a native switch"))
	}
	native, err := il2cppnative.Load(a.GameAssembly)
	if err != nil {
		fatal(err)
	}
	start, end, ok := native.FunctionRange(native.VA(rva))
	if !ok || start != native.VA(rva) {
		fatal(fmt.Errorf("RVA 0x%X is not a native function start", rva))
	}
	found := false
	cases := native.ByteSwitchCases(start, end)
	for _, switchCase := range cases {
		if *wantedCase >= 0 && switchCase.ID != *wantedCase {
			continue
		}
		found = true
		fmt.Printf("case %d -> rva=0x%X\n", switchCase.ID, native.RVA(switchCase.TargetVA))
	}
	if !found {
		if *wantedCase >= 0 && len(cases) > 0 && *wantedCase <= cases[len(cases)-1].ID {
			fmt.Printf("case %d -> default/unhandled\n", *wantedCase)
			return
		}
		fatal(fmt.Errorf("no matching byte-switch case in function RVA 0x%X", rva))
	}
}

func resolveMethod(args []string) {
	fs := flag.NewFlagSet("method", flag.ExitOnError)
	rawRVA := fs.String("rva", "", "native method RVA in decimal or 0x-prefixed hexadecimal")
	assembly := fs.String("assembly", "", "GameAssembly.dll override")
	_ = fs.Parse(args)
	a := mustResolve(fs, *assembly)
	if *rawRVA == "" {
		fatal(fmt.Errorf("-rva is required"))
	}
	rva, err := strconv.ParseUint(*rawRVA, 0, 64)
	if err != nil {
		fatal(fmt.Errorf("invalid -rva %q: %w", *rawRVA, err))
	}
	data, _ := mustLoad(a)
	methods, err := metadata.Methods(data)
	if err != nil {
		fatal(err)
	}
	addresses := mustResolveMethodRVAs(a, data, methods)
	found := false
	for _, method := range methods {
		if addresses[method.Index] != rva {
			continue
		}
		found = true
		fmt.Printf("method %s.%s token=0x%08X parameters=%d rva=0x%X\n",
			method.DeclaringType.FullName(), method.Name, method.Token, len(method.Parameters), rva)
	}
	if !found {
		fatal(fmt.Errorf("no managed method starts at RVA 0x%X", rva))
	}
}

func resolveType(args []string) {
	fs := flag.NewFlagSet("type", flag.ExitOnError)
	index := fs.Int("index", -1, "metadata type index")
	jsonOutput := fs.Bool("json", false, "write JSON")
	assembly := fs.String("assembly", "", "GameAssembly.dll override")
	_ = fs.Parse(args)
	a := mustResolve(fs, *assembly)
	if *index < 0 {
		fatal(fmt.Errorf("-index must be non-negative"))
	}
	if a.GameAssembly == "" {
		fatal(fmt.Errorf("GameAssembly is required to resolve a metadata type index"))
	}
	data, _ := mustLoad(a)
	definitions, err := metadata.Definitions(data)
	if err != nil {
		fatal(err)
	}
	names := make([]string, len(definitions))
	for i, definition := range definitions {
		names[i] = definition.FullName()
	}
	native, err := il2cppnative.Load(a.GameAssembly)
	if err != nil {
		fatal(err)
	}
	table, err := native.FindTypeTable(len(definitions))
	if err != nil {
		fatal(err)
	}
	resolved, err := table.Resolve(*index, names)
	if err != nil {
		fatal(err)
	}
	if *jsonOutput {
		writeJSON(resolved)
		return
	}
	fmt.Println(resolved.DisplayName)
}

func members(args []string) {
	fs := flag.NewFlagSet("members", flag.ExitOnError)
	typeFilter := fs.String("type", "", "case-insensitive declaring type substring")
	nameFilter := fs.String("name", "", "case-insensitive member name substring")
	fieldTypeIndex := fs.Int("field-type-index", -1, "include only fields with this metadata type index")
	rvas := fs.Bool("rva", false, "resolve native method RVAs from GameAssembly")
	jsonOutput := fs.Bool("json", false, "write JSON")
	assembly := fs.String("assembly", "", "GameAssembly.dll override")
	_ = fs.Parse(args)
	a := mustResolve(fs, *assembly)
	if *rvas && *jsonOutput {
		fatal(fmt.Errorf("-rva and -json cannot be combined"))
	}
	data, _ := mustLoad(a)
	fields, err := metadata.Fields(data)
	if err != nil {
		fatal(err)
	}
	methods, err := metadata.Methods(data)
	if err != nil {
		fatal(err)
	}
	typeNeedle := strings.ToLower(*typeFilter)
	nameNeedle := strings.ToLower(*nameFilter)
	view := struct {
		Fields  []metadata.Field  `json:"fields"`
		Methods []metadata.Method `json:"methods"`
	}{}
	match := func(owner, name string) bool {
		return strings.Contains(strings.ToLower(owner), typeNeedle) && strings.Contains(strings.ToLower(name), nameNeedle)
	}
	for _, field := range fields {
		if (*fieldTypeIndex < 0 || field.TypeIndex == *fieldTypeIndex) && match(field.DeclaringType.FullName(), field.Name) {
			view.Fields = append(view.Fields, field)
		}
	}
	if *fieldTypeIndex < 0 {
		for _, method := range methods {
			if match(method.DeclaringType.FullName(), method.Name) {
				view.Methods = append(view.Methods, method)
			}
		}
	}
	if *jsonOutput {
		writeJSON(view)
		return
	}
	methodRVAs := map[int]uint64{}
	if *rvas {
		methodRVAs = mustResolveMethodRVAs(a, data, view.Methods)
	}
	for _, field := range view.Fields {
		fmt.Printf("field  %s.%s type-index=%d token=0x%08X\n", field.DeclaringType.FullName(), field.Name, field.TypeIndex, field.Token)
	}
	for _, method := range view.Methods {
		fmt.Printf("method %s.%s token=0x%08X parameters=%d", method.DeclaringType.FullName(), method.Name, method.Token, len(method.Parameters))
		if rva, ok := methodRVAs[method.Index]; ok {
			fmt.Printf(" rva=0x%X", rva)
		}
		fmt.Println()
	}
}

func mustResolveMethodRVAs(a buildscan.Artifacts, data []byte, methods []metadata.Method) map[int]uint64 {
	if a.GameAssembly == "" {
		fatal(fmt.Errorf("GameAssembly is required to resolve method RVAs"))
	}
	images, err := metadata.Images(data)
	if err != nil {
		fatal(err)
	}
	native, err := il2cppnative.Load(a.GameAssembly)
	if err != nil {
		fatal(err)
	}
	modules := map[string]il2cppnative.Module{}
	result := make(map[int]uint64, len(methods))
	for _, method := range methods {
		image, ok := metadata.ImageForType(images, method.DeclaringTypeIndex)
		if !ok {
			continue
		}
		module, ok := modules[image.Name]
		if !ok {
			module, err = native.FindModule(image.Name, 1)
			if err != nil {
				continue
			}
			modules[image.Name] = module
		}
		if pointer, found := module.MethodPointer(method.Token); found {
			result[method.Index] = native.RVA(pointer)
		}
	}
	return result
}

func decrypt(args []string) {
	fs := flag.NewFlagSet("decrypt", flag.ExitOnError)
	out := fs.String("out", "", "output path (default: beside the source metadata)")
	assembly := fs.String("assembly", "", "GameAssembly.dll override")
	_ = fs.Parse(args)
	a := mustResolve(fs, *assembly)
	data, result := mustLoad(a)
	path := *out
	if path == "" {
		path = filepath.Join(filepath.Dir(a.Metadata), "global-metadata.decrypted.dat")
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		fatal(err)
	}
	fmt.Printf("wrote %s (%d bytes)\n", path, len(data))
	printInfo(result)
}

func names(args []string) {
	fs := flag.NewFlagSet("names", flag.ExitOnError)
	namespace := fs.String("namespace", strings.Join(packetNamespaces, ","), "comma-separated exact namespaces; empty lists every type")
	jsonOutput := fs.Bool("json", false, "write JSON")
	assembly := fs.String("assembly", "", "GameAssembly.dll override")
	_ = fs.Parse(args)
	a := mustResolve(fs, *assembly)
	data, _ := mustLoad(a)
	types, err := metadata.Catalog(data)
	if err != nil {
		fatal(err)
	}
	wanted := splitCSV(*namespace)
	groups := map[string][]string{}
	if len(wanted) == 0 {
		for _, typ := range types {
			groups[typ.Namespace] = append(groups[typ.Namespace], typ.Name)
		}
	} else {
		for _, ns := range wanted {
			groups[ns] = metadata.NamesInNamespace(types, ns)
		}
	}
	if *jsonOutput {
		writeJSON(groups)
		return
	}
	keys := make([]string, 0, len(groups))
	for ns := range groups {
		keys = append(keys, ns)
	}
	sort.Strings(keys)
	for _, ns := range keys {
		fmt.Printf("%s (%d)\n", ns, len(groups[ns]))
		for _, name := range groups[ns] {
			fmt.Printf("  %s\n", name)
		}
	}
}

func info(args []string) {
	fs := flag.NewFlagSet("info", flag.ExitOnError)
	jsonOutput := fs.Bool("json", false, "write JSON")
	assembly := fs.String("assembly", "", "GameAssembly.dll override")
	_ = fs.Parse(args)
	a := mustResolve(fs, *assembly)
	data, result := mustLoad(a)
	types, err := metadata.Types(data)
	if err != nil {
		fatal(err)
	}
	view := struct {
		Build     string        `json:"build"`
		Metadata  string        `json:"metadata"`
		Assembly  string        `json:"assembly,omitempty"`
		Info      metadata.Info `json:"info"`
		TypeCount int           `json:"type_count"`
	}{buildscan.Label(a), a.Metadata, a.GameAssembly, result, len(types)}
	if *jsonOutput {
		writeJSON(view)
		return
	}
	fmt.Printf("build: %s\nmetadata: %s\n", view.Build, view.Metadata)
	printInfo(result)
	fmt.Printf("managed types: %d\n", len(types))
}

func mustResolve(fs *flag.FlagSet, assembly string) buildscan.Artifacts {
	if fs.NArg() != 1 {
		usage()
	}
	a, err := buildscan.Resolve(fs.Arg(0), assembly)
	if err != nil {
		fatal(err)
	}
	return a
}

func mustLoad(a buildscan.Artifacts) ([]byte, metadata.Info) {
	data, info, err := buildscan.Load(a, metadata.DefaultVersion)
	if err != nil {
		fatal(err)
	}
	return data, info
}

func printInfo(info metadata.Info) {
	if info.Decrypted {
		fmt.Printf("recovered key: %s\nXOR mask: 0x%016x\n", info.Key, info.XORKey)
	} else {
		fmt.Println("metadata was already standard")
	}
	fmt.Printf("metadata version: %d\ntables: %d\n", info.MetadataVersion, len(info.Tables))
}

func splitCSV(s string) []string {
	var out []string
	for _, value := range strings.Split(s, ",") {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func writeJSON(value any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
