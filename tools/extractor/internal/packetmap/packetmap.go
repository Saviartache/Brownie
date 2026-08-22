// Package packetmap imports build-specific packet IDs from realmlib or JSON
// and reconciles them with Exalt's embedded friendly packet catalog.
package packetmap

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"rotmg-extractor/internal/metadata"
)

const (
	incomingNamespace = "Net.SocketServer.Messages.Incoming"
	outgoingNamespace = "Net.SocketServer.Messages.Outgoing"
)

var (
	typeScriptEntry = regexp.MustCompile(`^\s*([0-9]+)\s*:\s*PacketType\.([A-Za-z0-9_]+)`)
	factoryEntry    = regexp.MustCompile(`\[PacketType\.([A-Za-z0-9_]+)\]\s*:\s*\(\)\s*=>\s*new\s+(IncomingPackets|OutgoingPackets)\.([A-Za-z0-9_$]+)`)
)

// Entry is one packet map row enriched with direction and catalog validation.
type Entry struct {
	ID          int    `json:"id"`
	Type        string `json:"type"`
	Class       string `json:"class,omitempty"`
	Name        string `json:"name"`
	CatalogName string `json:"catalog_name,omitempty"`
	Direction   string `json:"direction,omitempty"`
	Confidence  int    `json:"confidence"`
	Provenance  string `json:"provenance"`
	Conflict    string `json:"conflict,omitempty"`
}

// Map is a packet map and its source metadata.
type Map struct {
	Source  string        `json:"source"`
	Format  string        `json:"format"`
	Entries map[int]Entry `json:"-"`
}

// SortedEntries returns entries ordered by numeric ID.
func (m Map) SortedEntries() []Entry {
	out := make([]Entry, 0, len(m.Entries))
	for _, entry := range m.Entries {
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ResolvePath accepts packet-map.ts, a realmlib root directory, or an empty
// path. Empty paths check REALMLIB_PACKET_MAP and nearby sibling checkouts.
func ResolvePath(path string) (string, error) {
	if path != "" {
		return normalizePath(path)
	}
	if env := os.Getenv("REALMLIB_PACKET_MAP"); env != "" {
		return normalizePath(env)
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	root := wd
	for range 6 {
		candidates := []string{
			filepath.Join(root, "realmlib", "src", "packet-map.ts"),
			filepath.Join(root, "node_modules", "realmlib", "src", "packet-map.ts"),
			filepath.Join(root, "exalt-proxy", "node_modules", "realmlib", "src", "packet-map.ts"),
		}
		for _, candidate := range candidates {
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				return filepath.Abs(candidate)
			}
		}
		parent := filepath.Dir(root)
		if parent == root {
			break
		}
		root = parent
	}
	return "", os.ErrNotExist
}

func normalizePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		for _, candidate := range []string{filepath.Join(abs, "src", "packet-map.ts"), filepath.Join(abs, "packet-map.ts")} {
			if candidateInfo, statErr := os.Stat(candidate); statErr == nil && !candidateInfo.IsDir() {
				return candidate, nil
			}
		}
		return "", fmt.Errorf("could not find src/packet-map.ts under %s", abs)
	}
	return abs, nil
}

// Load imports a TypeScript or JSON packet map and reconciles its names with
// metadata's embedded packet type catalog.
func Load(path string, catalog []metadata.Type) (Map, error) {
	resolved, err := ResolvePath(path)
	if err != nil {
		return Map{}, err
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return Map{}, err
	}
	m := Map{Source: resolved, Entries: map[int]Entry{}}
	switch strings.ToLower(filepath.Ext(resolved)) {
	case ".json":
		m.Format = "json"
		if err := parseJSON(data, m.Entries); err != nil {
			return Map{}, err
		}
	default:
		m.Format = "realmlib-typescript"
		if err := parseTypeScript(data, m.Entries); err != nil {
			return Map{}, err
		}
		loadFactories(filepath.Join(filepath.Dir(resolved), "create-packet.ts"), m.Entries)
	}
	reconcile(m.Entries, catalog)
	return m, nil
}

func parseTypeScript(data []byte, entries map[int]Entry) error {
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		match := typeScriptEntry.FindStringSubmatch(scanner.Text())
		if match == nil {
			continue
		}
		id, _ := strconv.Atoi(match[1])
		entries[id] = Entry{ID: id, Type: match[2], Name: titlePacketType(match[2]), Confidence: 70, Provenance: "realmlib packet-map.ts"}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if len(entries) == 0 {
		return fmt.Errorf("no PacketType entries found in TypeScript packet map")
	}
	return nil
}

func loadFactories(path string, entries map[int]Entry) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	byType := map[string]struct{ direction, class string }{}
	for _, match := range factoryEntry.FindAllStringSubmatch(string(data), -1) {
		direction := "incoming"
		if match[2] == "OutgoingPackets" {
			direction = "outgoing"
		}
		byType[match[1]] = struct{ direction, class string }{direction, match[3]}
	}
	for id, entry := range entries {
		if factory, ok := byType[entry.Type]; ok {
			entry.Direction, entry.Class = factory.direction, factory.class
			entry.Name = stripPacketSuffix(factory.class)
			entry.Confidence = 80
			entry.Provenance = "realmlib packet-map.ts + create-packet.ts"
			entries[id] = entry
		}
	}
}

func parseJSON(data []byte, entries map[int]Entry) error {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for key, value := range raw {
		if id, err := strconv.Atoi(key); err == nil {
			if name, ok := value.(string); ok {
				entries[id] = Entry{ID: id, Type: name, Name: titlePacketType(name), Confidence: 70, Provenance: "JSON packet map"}
			}
			continue
		}
		switch number := value.(type) {
		case float64:
			id := int(number)
			entries[id] = Entry{ID: id, Type: key, Name: titlePacketType(key), Confidence: 70, Provenance: "JSON packet map"}
		}
	}
	if len(entries) == 0 {
		return fmt.Errorf("JSON packet map contains no id/name entries")
	}
	return nil
}

func reconcile(entries map[int]Entry, catalog []metadata.Type) {
	incoming := metadata.NamesInNamespace(catalog, incomingNamespace)
	outgoing := metadata.NamesInNamespace(catalog, outgoingNamespace)
	for id, entry := range entries {
		name, direction, matched := matchCatalog(entry, incoming, outgoing)
		if matched {
			entry.CatalogName = name
			if entry.Direction != "" && entry.Direction != direction {
				entry.Conflict = fmt.Sprintf("realmlib says %s but metadata catalog says %s", entry.Direction, direction)
				entry.Confidence = 40
				entry.Provenance += "; metadata direction conflict"
			} else {
				entry.Direction = direction
				entry.Name = name
				entry.Confidence = 85
				entry.Provenance += "; Exalt embedded catalog match"
			}
		}
		entries[id] = entry
	}
}

func matchCatalog(entry Entry, incoming, outgoing []string) (string, string, bool) {
	keys := map[string]bool{}
	for _, value := range []string{entry.Type, entry.Class, entry.Name} {
		if value != "" {
			keys[canonical(value)] = true
			keys[canonical(stripPacketSuffix(value))] = true
		}
	}
	groups := []struct {
		direction string
		names     []string
	}{{"incoming", incoming}, {"outgoing", outgoing}}
	for _, group := range groups {
		for _, name := range group.names {
			if keys[canonical(name)] || keys[canonical(stripPacketSuffix(name))] {
				return name, group.direction, true
			}
		}
	}
	return "", "", false
}

func stripPacketSuffix(value string) string {
	for _, suffix := range []string{"Packet", "Message", "Msg"} {
		value = strings.TrimSuffix(value, suffix)
	}
	return value
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

func titlePacketType(value string) string {
	parts := strings.FieldsFunc(strings.ToLower(value), func(r rune) bool { return r == '_' || r == '-' || r == ' ' })
	if len(parts) == 1 && !strings.ContainsAny(value, "_- ") {
		return value
	}
	var b strings.Builder
	for _, part := range parts {
		if part == "" {
			continue
		}
		b.WriteString(strings.ToUpper(part[:1]))
		b.WriteString(part[1:])
	}
	return b.String()
}
