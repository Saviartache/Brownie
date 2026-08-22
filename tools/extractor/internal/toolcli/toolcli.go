// Package toolcli implements reusable command-line front ends for extractor's
// inspection subcommands and their standalone binaries.
package toolcli

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"rotmg-extractor/internal/buildreport"
	"rotmg-extractor/internal/handlerreport"
	"rotmg-extractor/internal/packetreport"
)

// RunDiff runs the semantic build-diff command and returns a process exit code.
func RunDiff(command string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(stderr)
	jsonOutput := fs.Bool("json", false, "write the complete report as JSON")
	namespace := fs.String("namespace", strings.Join(buildreport.DefaultNamespaces, ","), "comma-separated namespaces; short suffixes and child namespaces are accepted")
	showAllTypes := fs.Bool("all-types", false, "print every added/removed managed type")
	showLiterals := fs.Bool("literals", false, "print every added/removed managed string literal")
	includeGenerated := fs.Bool("generated", false, "include logs, timestamps, hashes, and generated changelogs")
	fileLimit := fs.Int("file-limit", 100, "maximum file paths printed in text mode; 0 hides them")
	outPath := fs.String("out", "", "write the report to a file instead of stdout")
	fs.Usage = func() {
		_, _ = fmt.Fprintf(stderr, "usage: %s [flags] OLD_BUILD NEW_BUILD\n", command)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 2 {
		fs.Usage()
		return 2
	}
	report, err := buildreport.Compare(fs.Arg(0), fs.Arg(1), buildreport.Options{
		Namespaces: splitCSV(*namespace), IncludeGenerated: *includeGenerated,
	})
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	w, closeOutput, err := output(stdout, *outPath)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	defer closeOutput()
	if *jsonOutput {
		err = report.WriteJSON(w)
	} else {
		err = report.WriteText(w, buildreport.TextOptions{
			ShowAllTypes: *showAllTypes, ShowLiterals: *showLiterals, FileLimit: *fileLimit,
		})
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	return 0
}

// RunHandlers runs packet-handler discovery for one build, or compares the
// discovered native function bodies when two builds are supplied.
func RunHandlers(command string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(stderr)
	jsonOutput := fs.Bool("json", false, "write the complete handler report as JSON")
	outPath := fs.String("out", "", "write the report to a file instead of stdout")
	packetID := fs.Int("packet-id", -1, "show only registrations/callbacks for a packet ID (0-255)")
	match := fs.String("match", "", "show only functions whose identity or role contains this text")
	minConfidence := fs.Int("min-confidence", 0, "minimum evidence confidence (0-100)")
	packetMapPath := fs.String("packet-map", "", "realmlib root, packet-map.ts, or JSON packet map (default: auto-discover realmlib)")
	noPacketMap := fs.Bool("no-packet-map", false, "disable packet-name enrichment")
	managedType := fs.String("managed-type", "", "include every method whose declaring type contains this text")
	returnsType := fs.String("returns-type", "", "include every method whose resolved return type contains this text")
	factoryOnly := fs.Bool("factory", false, "show the client-native byte ID to managed packet-type registries")
	fs.Usage = func() {
		_, _ = fmt.Fprintf(stderr, "usage: %s [flags] BUILD [NEW_BUILD]\n", command)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 && fs.NArg() != 2 {
		fs.Usage()
		return 2
	}
	if *packetID < -1 || *packetID > 255 || *minConfidence < 0 || *minConfidence > 100 {
		_, _ = fmt.Fprintln(stderr, "error: packet-id must be 0-255 and min-confidence must be 0-100")
		return 2
	}
	if fs.NArg() == 2 && (*packetID >= 0 || *match != "" || *minConfidence != 0 || *factoryOnly || *managedType != "" || *returnsType != "") {
		_, _ = fmt.Fprintln(stderr, "error: handler filters apply to a single-build report, not a two-build diff")
		return 2
	}
	w, closeOutput, err := output(stdout, *outPath)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	defer closeOutput()
	if fs.NArg() == 2 {
		oldReport, err := handlerreport.ExtractWithOptions(fs.Arg(0), handlerreport.Options{})
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "error: old build:", err)
			return 1
		}
		newReport, err := handlerreport.ExtractWithOptions(fs.Arg(1), handlerreport.Options{PacketMapPath: *packetMapPath, AutoPacketMap: !*noPacketMap, IncludeType: *managedType, IncludeReturn: *returnsType})
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "error: new build:", err)
			return 1
		}
		diff := handlerreport.CompareReports(oldReport, newReport)
		if *jsonOutput {
			err = diff.WriteJSON(w)
		} else {
			err = diff.WriteText(w)
		}
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "error:", err)
			return 1
		}
		return 0
	}
	report, err := handlerreport.ExtractWithOptions(fs.Arg(0), handlerreport.Options{PacketMapPath: *packetMapPath, AutoPacketMap: !*noPacketMap, IncludeType: *managedType, IncludeReturn: *returnsType})
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	if *factoryOnly && (*packetID >= 0 || *match != "") {
		for i := range report.MessageFactories {
			bindings := report.MessageFactories[i].Bindings[:0]
			for _, binding := range report.MessageFactories[i].Bindings {
				if *packetID >= 0 && binding.ID != *packetID {
					continue
				}
				searchText := binding.ManagedType
				if binding.Packet != nil {
					searchText += " " + binding.Packet.Name + " " + binding.Packet.Type + " " + binding.Packet.Class
				}
				for _, candidate := range binding.NameCandidates {
					searchText += " " + candidate.Name
				}
				if *match != "" && !strings.Contains(strings.ToLower(searchText), strings.ToLower(*match)) {
					continue
				}
				bindings = append(bindings, binding)
			}
			report.MessageFactories[i].Bindings = bindings
		}
	}
	filtered := report.Functions[:0]
	for _, fn := range report.Functions {
		if fn.Confidence < *minConfidence {
			continue
		}
		searchText := fn.Identity + " " + fn.Role
		for _, packet := range fn.PacketNames {
			searchText += " " + packet.Name + " " + packet.Type + " " + packet.Class
		}
		for _, reference := range fn.TypeReferences {
			searchText += " " + reference.DisplayName
		}
		for _, call := range fn.DirectCalls {
			searchText += " " + strings.Join(call.Managed, " ")
		}
		if *match != "" && !strings.Contains(strings.ToLower(searchText), strings.ToLower(*match)) {
			continue
		}
		if *packetID >= 0 {
			found := false
			for _, id := range fn.PacketIDs {
				found = found || id == *packetID
			}
			if !found {
				continue
			}
		}
		filtered = append(filtered, fn)
	}
	report.Functions = filtered
	if *jsonOutput {
		err = report.WriteJSON(w)
	} else if *factoryOnly {
		err = report.WriteFactoryText(w)
	} else {
		err = report.WriteText(w)
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	return 0
}

// RunPackets runs the packet inventory command and returns a process exit code.
func RunPackets(command string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(stderr)
	direction := fs.String("direction", "all", "packet direction: all, incoming, outgoing, or data")
	jsonOutput := fs.Bool("json", false, "write the complete inventory as JSON")
	outPath := fs.String("out", "", "write packet names to a file instead of stdout")
	packetMapPath := fs.String("packet-map", "", "realmlib root, packet-map.ts, or JSON packet map (default: auto-discover realmlib)")
	noPacketMap := fs.Bool("no-packet-map", false, "disable packet-ID enrichment")
	fs.Usage = func() {
		_, _ = fmt.Fprintf(stderr, "usage: %s [flags] BUILD_OR_METADATA\n", command)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	inventory, err := packetreport.ExtractWithOptions(fs.Arg(0), packetreport.Options{PacketMapPath: *packetMapPath, AutoPacketMap: !*noPacketMap})
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	w, closeOutput, err := output(stdout, *outPath)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	defer closeOutput()
	if *jsonOutput {
		err = inventory.WriteDirectionJSON(w, *direction)
	} else {
		err = inventory.WriteText(w, *direction)
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	return 0
}

func output(stdout io.Writer, path string) (io.Writer, func(), error) {
	if path == "" {
		return stdout, func() {}, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, func() {}, err
	}
	return f, func() { _ = f.Close() }, nil
}

func splitCSV(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
