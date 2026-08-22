#include "app/Inspection.h"

#include <cstdint>
#include <cstdio>
#include <cstring>

namespace brownie::app {
namespace {

/// How many words of an object to show per line.
constexpr std::size_t kDumpStride = 4;

[[nodiscard]] std::string Hex(std::uint32_t value) {
    char text[16]{};
    std::snprintf(text, sizeof(text), "0x%04X", value);
    return text;
}

/// Whether a type name says nothing about what a class is for.
///
/// Every class has integers and strings in it. Listing them as evidence of a
/// class's purpose would bury the one or two types that actually identify it.
[[nodiscard]] bool IsUninformativeType(std::string_view type) noexcept {
    static constexpr std::string_view kNoise[] = {
        "System.Int32",   "System.Single", "System.Boolean", "System.String", "System.Void",
        "System.Byte",    "System.Int16",  "System.Int64",   "System.UInt32", "System.UInt16",
        "System.UInt64",  "System.Double", "System.Object",  "System.Char",   "System.SByte",
    };
    for (const std::string_view noise : kNoise) {
        if (type == noise) {
            return true;
        }
    }
    return false;
}

/// Takes a printed name apart the way `FindClass` wants it.
///
/// Names are printed as `Namespace.Name` and the lookup takes the two
/// separately, so a name clicked straight out of the list would otherwise never
/// be found — which is most of the reason to have a list.
void SplitName(const std::string& full_name, std::string_view& name_space,
               std::string_view& name) noexcept {
    name_space = {};
    name = full_name;
    if (const std::size_t dot = full_name.rfind('.'); dot != std::string::npos) {
        name_space = std::string_view{full_name}.substr(0, dot);
        name = std::string_view{full_name}.substr(dot + 1);
    }
}

/// One member, as it is written in both the log and the dump.
[[nodiscard]] std::string MemberLine(const overlay::MemberRow& member) {
    std::string line = "  ";
    if (member.is_method) {
        line += "method ";
    } else if (member.is_static) {
        line += "static ";
    } else {
        line += member.offset + " ";
    }
    line += member.name + " : " + member.detail;
    return line;
}

[[nodiscard]] std::string ClassLine(const overlay::ClassDetail& detail) {
    return "class " + detail.name + (detail.base.empty() ? std::string{} : " : " + detail.base);
}

}  // namespace

bool LooksUnsafeToWalk(std::string_view full_name) noexcept {
    return full_name.find_first_of("`<>[]") != std::string_view::npos;
}

overlay::ClassDetail Describe(const game::ClassCatalog& catalog, const std::string& full_name) {
    overlay::ClassDetail detail;
    detail.name = full_name;

    std::string_view name_space;
    std::string_view name;
    SplitName(full_name, name_space, name);

    auto klass = catalog.FindClass(name_space, name);
    if (!klass.has_value()) {
        // The list shows one image; the game is several assemblies. A name
        // typed in from elsewhere is still worth finding, and by bare name is
        // the only way to reach it.
        klass = catalog.FindClassAnywhere(name);
    }
    if (!klass.has_value()) {
        // Not proof of absence: IL2CPP registers classes lazily, so one the
        // game has not used yet is missing exactly like one that never existed.
        detail.base = "not built yet, in this image or any other";
        return detail;
    }

    detail.base = catalog.BaseClassName(*klass);

    // Readable type names, deduplicated in order of first sight. This is what
    // stands in for a name the obfuscator took away: the class cannot say what
    // it is, but what it stores and returns can.
    const auto note = [&detail](const std::string& type) {
        if (!overlay::LooksReadable(type) || IsUninformativeType(type)) {
            return;
        }
        for (const std::string& seen : detail.touches) {
            if (seen == type) {
                return;
            }
        }
        detail.touches.push_back(type);
    };
    if (!detail.base.empty()) {
        note(detail.base);
    }

    for (const auto& field : catalog.Fields(*klass)) {
        overlay::MemberRow row;
        row.name = field.name;
        row.detail = field.type_name;
        row.is_static = field.is_static;
        if (!field.is_static) {
            row.offset = Hex(field.offset);
        }
        note(field.type_name);
        detail.members.push_back(std::move(row));
    }

    for (const auto& method : catalog.Methods(*klass)) {
        overlay::MemberRow row;
        row.name = method.name;
        row.is_method = true;
        row.detail = method.return_type;
        row.detail.append(" (");
        for (std::size_t i = 0; i < method.parameter_types.size(); ++i) {
            if (i != 0) {
                row.detail.append(", ");
            }
            row.detail.append(method.parameter_types[i]);
            note(method.parameter_types[i]);
        }
        row.detail.append(")");
        // The runtime entry point, so a method found by "what writes this
        // address" in a debugger can be named here: whichever method's entry is
        // the greatest one below that instruction is the function it sits in.
        if (method.address != nullptr) {
            char address[24]{};
            std::snprintf(address, sizeof(address), " @ 0x%llX",
                          reinterpret_cast<unsigned long long>(method.address));
            row.detail.append(address);
        }
        note(method.return_type);
        detail.members.push_back(std::move(row));
    }
    return detail;
}

void WriteClass(const overlay::ClassDetail& detail, const LineSink& say) {
    say(ClassLine(detail));
    for (const auto& member : detail.members) {
        say(MemberLine(member));
    }
}

ExportSummary ExportClasses(const game::ClassCatalog& catalog, std::size_t chunk_bytes,
                            const ChunkSink& send) {
    ExportSummary summary;
    std::string chunk;

    const auto flush = [&chunk, &send] {
        if (chunk.empty()) {
            return;
        }
        send(chunk);
        chunk.clear();
    };

    for (const std::string& full_name : catalog.ClassNames()) {
        std::string_view name_space;
        std::string_view name;
        SplitName(full_name, name_space, name);
        const auto klass = catalog.FindClass(name_space, name);

        // **The gate on the whole sweep.** Asking a class its name is safe
        // whatever state it is in; asking an unprepared one for its members is
        // not, and is how the reference implementation crashed inside
        // GameAssembly with nothing in the dump to say why. Skipped ones are
        // counted, not hidden.
        if (!klass.has_value() || !catalog.IsPrepared(*klass) || LooksUnsafeToWalk(full_name)) {
            ++summary.skipped;
            continue;
        }

        const auto detail = Describe(catalog, full_name);
        WriteClass(detail, [&chunk](std::string_view line) {
            chunk.append(line).push_back('\n');
        });
        chunk.push_back('\n');
        ++summary.written;

        if (chunk.size() >= chunk_bytes) {
            flush();
        }
    }
    flush();
    return summary;
}

void DumpObject(std::span<const std::byte> object, const LineSink& say) {
    char line[192]{};
    constexpr std::size_t kRow = kDumpStride * sizeof(std::int32_t);

    for (std::size_t at = 0; at + kRow <= object.size(); at += kRow) {
        int written = std::snprintf(line, sizeof(line), "%04zX ", at);
        for (std::size_t word = 0; word < kDumpStride; ++word) {
            std::int32_t value = 0;
            std::memcpy(&value, object.data() + at + word * sizeof(value), sizeof(value));
            float as_float = 0.0F;
            std::memcpy(&as_float, &value, sizeof(as_float));
            written +=
                std::snprintf(line + written, sizeof(line) - static_cast<std::size_t>(written),
                              "%11d %11.3g ", value, static_cast<double>(as_float));
        }
        say(line);
    }
}

}  // namespace brownie::app
