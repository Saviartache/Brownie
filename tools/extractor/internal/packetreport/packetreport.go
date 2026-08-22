// Package packetreport extracts RotMG's unobfuscated packet names from a
// published build.
package packetreport

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"rotmg-extractor/internal/buildscan"
	"rotmg-extractor/internal/metadata"
	"rotmg-extractor/internal/packetmap"
)

const (
	IncomingNamespace = "Net.SocketServer.Messages.Incoming"
	OutgoingNamespace = "Net.SocketServer.Messages.Outgoing"
	DataNamespace     = "Net.SocketServer.Messages.Data"
)

// Inventory is a build's complete packet-name catalog.
type Inventory struct {
	Build            string            `json:"build"`
	Path             string            `json:"path"`
	Metadata         metadata.Info     `json:"metadata"`
	Incoming         []string          `json:"incoming"`
	Outgoing         []string          `json:"outgoing"`
	Data             []string          `json:"data"`
	PacketMapSource  string            `json:"packet_map_source,omitempty"`
	PacketMapFormat  string            `json:"packet_map_format,omitempty"`
	PacketMappings   []packetmap.Entry `json:"packet_mappings,omitempty"`
	UnmappedIncoming []string          `json:"unmapped_incoming,omitempty"`
	UnmappedOutgoing []string          `json:"unmapped_outgoing,omitempty"`
}

// Options controls optional packet-ID enrichment.
type Options struct {
	PacketMapPath string
	AutoPacketMap bool
}

// DirectionInventory is the JSON representation for a single requested
// direction.
type DirectionInventory struct {
	Build           string            `json:"build"`
	Path            string            `json:"path"`
	Metadata        metadata.Info     `json:"metadata"`
	Direction       string            `json:"direction"`
	Count           int               `json:"count"`
	Names           []string          `json:"names"`
	PacketMapSource string            `json:"packet_map_source,omitempty"`
	PacketMapFormat string            `json:"packet_map_format,omitempty"`
	PacketMappings  []packetmap.Entry `json:"packet_mappings,omitempty"`
	Unmapped        []string          `json:"unmapped,omitempty"`
}

// Extract loads/decrypts a build and returns all Incoming, Outgoing, and Data
// names, including child namespaces such as Incoming.Trade.
func Extract(path string) (Inventory, error) {
	return ExtractWithOptions(path, Options{AutoPacketMap: true})
}

// ExtractWithOptions loads the catalog and optionally joins a realmlib or JSON
// ID map to its unobfuscated names.
func ExtractWithOptions(path string, options Options) (Inventory, error) {
	if filepath.Base(path) == "packets.json" {
		return readCached(path)
	}
	artifacts, err := buildscan.Resolve(path, "")
	if err != nil {
		cached, cacheErr := readCached(path)
		if cacheErr == nil {
			return cached, nil
		}
		if !os.IsNotExist(cacheErr) {
			return Inventory{}, fmt.Errorf("reading cached packet inventory: %w", cacheErr)
		}
		return Inventory{}, err
	}
	data, info, err := buildscan.Load(artifacts, metadata.DefaultVersion)
	if err != nil {
		if cached, cacheErr := readCached(path); cacheErr == nil {
			return cached, nil
		}
		return Inventory{}, err
	}
	catalog, err := metadata.Catalog(data)
	if err != nil {
		return Inventory{}, err
	}
	inventory := Inventory{
		Build: buildscan.Label(artifacts), Path: artifacts.Root, Metadata: info,
		Incoming: metadata.NamesInNamespace(catalog, IncomingNamespace),
		Outgoing: metadata.NamesInNamespace(catalog, OutgoingNamespace),
		Data:     metadata.NamesInNamespace(catalog, DataNamespace),
	}
	if options.PacketMapPath != "" || options.AutoPacketMap {
		mapping, mapErr := packetmap.Load(options.PacketMapPath, catalog)
		if mapErr != nil && !(options.PacketMapPath == "" && errors.Is(mapErr, os.ErrNotExist)) {
			return Inventory{}, fmt.Errorf("loading packet map: %w", mapErr)
		}
		if mapErr == nil {
			inventory.PacketMapSource = mapping.Source
			inventory.PacketMapFormat = mapping.Format
			inventory.PacketMappings = mapping.SortedEntries()
			inventory.UnmappedIncoming = unmappedNames(inventory.Incoming, "incoming", inventory.PacketMappings)
			inventory.UnmappedOutgoing = unmappedNames(inventory.Outgoing, "outgoing", inventory.PacketMappings)
		}
	}
	return inventory, nil
}

func readCached(path string) (Inventory, error) {
	candidate := path
	if filepath.Base(path) != "packets.json" {
		candidate = filepath.Join(path, "packets.json")
	}
	data, err := os.ReadFile(candidate)
	if err != nil {
		return Inventory{}, err
	}
	var inventory Inventory
	if err := json.Unmarshal(data, &inventory); err != nil {
		return Inventory{}, err
	}
	return inventory, nil
}

// WriteJSON writes the complete inventory.
func (i Inventory) WriteJSON(w io.Writer) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(i)
}

// WriteDirectionJSON writes either the complete inventory (all) or a compact
// single-direction document.
func (i Inventory) WriteDirectionJSON(w io.Writer, direction string) error {
	if strings.EqualFold(direction, "all") {
		return i.WriteJSON(w)
	}
	names, err := i.Direction(direction)
	if err != nil {
		return err
	}
	sort.Strings(names)
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	mappings := make([]packetmap.Entry, 0)
	for _, entry := range i.PacketMappings {
		if entry.Direction == strings.ToLower(direction) {
			mappings = append(mappings, entry)
		}
	}
	var unmapped []string
	if strings.EqualFold(direction, "incoming") {
		unmapped = i.UnmappedIncoming
	} else if strings.EqualFold(direction, "outgoing") {
		unmapped = i.UnmappedOutgoing
	}
	return encoder.Encode(DirectionInventory{
		Build: i.Build, Path: i.Path, Metadata: i.Metadata,
		Direction: strings.ToLower(direction), Count: len(names), Names: names,
		PacketMapSource: i.PacketMapSource, PacketMapFormat: i.PacketMapFormat,
		PacketMappings: mappings, Unmapped: unmapped,
	})
}

// WriteText writes all requested directions. Direction is all, incoming,
// outgoing, or data.
func (i Inventory) WriteText(w io.Writer, direction string) error {
	direction = strings.ToLower(direction)
	if direction != "all" && direction != "incoming" && direction != "outgoing" && direction != "data" {
		return fmt.Errorf("unknown direction %q (want all, incoming, outgoing, or data)", direction)
	}
	checked := &checkedWriter{writer: w}
	checked.printf("%s\n", i.Build)
	if i.Metadata.Key != "" {
		checked.printf("recovered key: %s\n", i.Metadata.Key)
	}
	if i.PacketMapSource != "" {
		matches := 0
		for _, entry := range i.PacketMappings {
			if entry.CatalogName != "" {
				matches++
			}
		}
		checked.printf("packet map: %s (%d entries, %d current-catalog matches, %d unmatched)\n", i.PacketMapSource, len(i.PacketMappings), matches, len(i.PacketMappings)-matches)
	}
	if direction == "all" || direction == "incoming" {
		writeGroup(checked, "Incoming", "incoming", i.Incoming, i.PacketMappings)
	}
	if direction == "all" || direction == "outgoing" {
		writeGroup(checked, "Outgoing", "outgoing", i.Outgoing, i.PacketMappings)
	}
	if direction == "all" || direction == "data" {
		writeGroup(checked, "Data", "data", i.Data, nil)
	}
	return checked.err
}

// Direction returns a copy of the requested packet-name slice.
func (i Inventory) Direction(direction string) ([]string, error) {
	var names []string
	switch strings.ToLower(direction) {
	case "incoming":
		names = i.Incoming
	case "outgoing":
		names = i.Outgoing
	case "data":
		names = i.Data
	default:
		return nil, fmt.Errorf("unknown direction %q", direction)
	}
	return append([]string(nil), names...), nil
}

func writeGroup(w *checkedWriter, label, direction string, names []string, mappings []packetmap.Entry) {
	copyNames := append([]string(nil), names...)
	sort.Strings(copyNames)
	byName := mappingsByName(direction, mappings)
	mapped := 0
	for _, name := range copyNames {
		if len(byName[canonical(name)]) > 0 {
			mapped++
		}
	}
	if mappings != nil {
		w.printf("\n%s (%d names, %d with IDs)\n", label, len(copyNames), mapped)
	} else {
		w.printf("\n%s (%d)\n", label, len(copyNames))
	}
	for _, name := range copyNames {
		entries := byName[canonical(name)]
		if len(entries) == 0 {
			if mappings != nil {
				w.printf("    ?  %s\n", name)
			} else {
				w.printf("  %s\n", name)
			}
			continue
		}
		ids := make([]string, 0, len(entries))
		conflict := false
		for _, entry := range entries {
			ids = append(ids, fmt.Sprintf("%d", entry.ID))
			conflict = conflict || entry.Conflict != ""
		}
		marker := " "
		if conflict {
			marker = "!"
		}
		w.printf("  %s%3s  %s\n", marker, strings.Join(ids, ","), name)
	}
}

func unmappedNames(names []string, direction string, mappings []packetmap.Entry) []string {
	byName := mappingsByName(direction, mappings)
	var out []string
	for _, name := range names {
		if len(byName[canonical(name)]) == 0 {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func mappingsByName(direction string, mappings []packetmap.Entry) map[string][]packetmap.Entry {
	out := map[string][]packetmap.Entry{}
	for _, entry := range mappings {
		if entry.Direction != direction || entry.CatalogName == "" {
			continue
		}
		key := canonical(entry.CatalogName)
		out[key] = append(out[key], entry)
	}
	for key := range out {
		sort.Slice(out[key], func(a, b int) bool { return out[key][a].ID < out[key][b].ID })
	}
	return out
}

func canonical(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

type checkedWriter struct {
	writer io.Writer
	err    error
}

func (w *checkedWriter) printf(format string, args ...any) {
	if w.err == nil {
		_, w.err = fmt.Fprintf(w.writer, format, args...)
	}
}
