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
	"strings"

	"rotmg-extractor/internal/buildscan"
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
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `Usage:
  metatool decrypt [-out FILE] [-assembly FILE] BUILD_OR_METADATA
  metatool names   [-namespace NS[,NS...]] [-json] [-assembly FILE] BUILD_OR_METADATA
  metatool info    [-json] [-assembly FILE] BUILD_OR_METADATA

BUILD_OR_METADATA may be a published build directory, game_files directory,
or a direct global-metadata.dat path.`)
	os.Exit(2)
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
