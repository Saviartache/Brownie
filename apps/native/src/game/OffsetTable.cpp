#include "game/OffsetTable.h"

#include <string>
#include <utility>

namespace brownie::game {
namespace {

/// Combines two provenances into the weaker one.
///
/// A field found by its exact name inside a class that was only found by alias
/// is an alias-grade result: a resolution is never more trustworthy than the
/// least trustworthy step that produced it.
[[nodiscard]] Provenance Weaker(Provenance left, Provenance right) noexcept {
    return static_cast<std::uint8_t>(left) >= static_cast<std::uint8_t>(right) ? left : right;
}

[[nodiscard]] const FieldDescription* FieldNamed(const std::vector<FieldDescription>& fields,
                                                 std::string_view name) noexcept {
    for (const auto& field : fields) {
        if (field.name == name) {
            return &field;
        }
    }
    return nullptr;
}

[[nodiscard]] bool SignatureMatches(const MethodDescription& method,
                                    const MethodQuery& query) noexcept {
    if (method.return_type != query.return_type) {
        return false;
    }
    if (method.parameter_types.size() != query.parameter_types.size()) {
        return false;
    }
    for (std::size_t i = 0; i < method.parameter_types.size(); ++i) {
        if (method.parameter_types[i] != query.parameter_types[i]) {
            return false;
        }
    }
    return true;
}

/// The one candidate matching `name`, or null when there is none — and null
/// with `ambiguous` set when there is more than one.
///
/// Overloads are refused rather than resolved to whichever the runtime happens
/// to list first. Two methods with the same name do different things, and
/// hooking the wrong one is not a smaller mistake than hooking none.
[[nodiscard]] const MethodDescription* MethodNamed(const std::vector<MethodDescription>& methods,
                                                   std::string_view name,
                                                   const MethodQuery& query,
                                                   bool& ambiguous) noexcept {
    const bool signature_given = !query.return_type.empty();
    // Only when there is no signature to check instead. A query carrying both
    // is answered by the stronger of the two.
    const bool arity_given = !signature_given && query.parameter_count != 0;
    const MethodDescription* found = nullptr;
    for (const auto& method : methods) {
        if (method.name != name) {
            continue;
        }
        if (signature_given && !SignatureMatches(method, query)) {
            continue;
        }
        if (arity_given && method.parameter_types.size() != query.parameter_count) {
            continue;
        }
        if (found != nullptr) {
            ambiguous = true;
            return nullptr;
        }
        found = &method;
    }
    return found;
}

}  // namespace

std::string_view Describe(Provenance provenance) noexcept {
    switch (provenance) {
        case Provenance::kExactName:
            return "exact name";
        case Provenance::kAlias:
            return "recovered by alias";
        case Provenance::kFingerprint:
            return "recovered by fingerprint";
    }
    return "unknown";
}

namespace {

/// A class the caller may ask about its members, or nothing.
///
/// **Found is not the same as built.** IL2CPP registers a class long before it
/// prepares one, and asking an unprepared class for its fields or methods
/// faults inside `GameAssembly` — the crash the reference implementation shipped
/// and the one this project's whole-image sweep already guards against. Every
/// resolution goes through here, so the guard is in one place rather than in
/// whichever caller remembered it.
[[nodiscard]] std::optional<std::pair<ClassRef, Provenance>> Built(const MetadataSource& source,
                                                                  std::optional<ClassRef> found,
                                                                  Provenance provenance) {
    if (!found.has_value() || !source.IsPrepared(*found)) {
        return std::nullopt;
    }
    return std::pair{*found, provenance};
}

}  // namespace

Result<std::pair<ClassRef, Provenance>> ResolveClass(const MetadataSource& source,
                                                    const ClassQuery& query) {
    // A class named with an assembly is looked for *only* there. Falling back
    // to the game's own image would answer a question about
    // `UnityEngine.GameObject` with whatever the game happens to call
    // `GameObject`, which is the sort of plausible wrong answer this layer
    // exists to refuse.
    if (!query.assemblies.empty()) {
        for (const auto assembly : query.assemblies) {
            if (const auto found =
                    Built(source, source.FindClassIn(assembly, query.name_space, query.name),
                          Provenance::kExactName)) {
                return *found;
            }
        }
        // The class's own aliases, in every assembly that might hold it. Both
        // lists are short and every entry is a lookup, so the order is: the
        // real name everywhere first, then the older names.
        for (const auto assembly : query.assemblies) {
            for (const auto alias : query.aliases) {
                if (const auto found =
                        Built(source, source.FindClassIn(assembly, query.name_space, alias),
                              Provenance::kAlias)) {
                    return *found;
                }
            }
        }
        return Error{ErrorCode::kNotReady,
                     "no class of that name built yet in any of its assemblies"};
    }

    if (const auto found = Built(source, source.FindClass(query.name_space, query.name),
                                 Provenance::kExactName)) {
        return *found;
    }
    for (const auto alias : query.aliases) {
        if (const auto found =
                Built(source, source.FindClass(query.name_space, alias), Provenance::kAlias)) {
            return *found;
        }
    }

    // Not where the query said to look. About a third of this game's classes
    // keep a real namespace, so naming the wrong one is the ordinary way to
    // miss a class that is sitting right there — `ApplicationManager` looked
    // absent for exactly that reason. Searching by bare name finds it, and
    // proves less while doing so: no namespace, and a refusal rather than a
    // choice when two classes share the name.
    if (const auto found =
            Built(source, source.FindClassAnywhere(query.name), Provenance::kAlias)) {
        return *found;
    }
    // There is deliberately no fingerprint layer for classes. A class matched by
    // shape rather than by name would make every field and method resolved
    // through it wrong at once, and the blast radius of that guess is not worth
    // what it buys — a renamed class with no known alias is a change worth
    // noticing by hand.
    //
    // **This failure is not proof of a rename.** IL2CPP registers classes
    // lazily, so a class the game has not instantiated yet is missing from
    // metadata in exactly the same way a renamed one is — the reference
    // implementation records projectile and throwable classes appearing only
    // once a shot is fired or a ground effect lands. `kNotReady` rather than
    // `kNotFound` says so: the caller should resolve again later, and only a
    // key still unresolved after the game has been played is a real rename.
    return Error{ErrorCode::kNotReady,
                 "no class of that name built yet, under any known alias"};
}

namespace {

/// Every instance field of a given type, in declaration order.
///
/// Instance fields only: a static field's "offset" is into a different block of
/// memory entirely, so counting them here would both break the count and, if one
/// were selected, hand back an offset into the wrong object.
[[nodiscard]] std::vector<const FieldDescription*> InstanceFieldsOfType(
    const std::vector<FieldDescription>& fields, std::string_view type_name) {
    std::vector<const FieldDescription*> shaped;
    for (const auto& field : fields) {
        if (!field.is_static && field.type_name == type_name) {
            shaped.push_back(&field);
        }
    }
    return shaped;
}

/// Fills in a resolution, including the fingerprint the live class gives it.
[[nodiscard]] FieldResolution Resolved(const FieldDescription& field,
                                       const std::vector<FieldDescription>& fields,
                                       Provenance provenance) {
    FieldResolution resolution{field.offset, provenance, {}, 0, 0};
    if (field.is_static) {
        return resolution;
    }

    const auto shaped = InstanceFieldsOfType(fields, field.type_name);
    for (std::size_t i = 0; i < shaped.size(); ++i) {
        if (shaped[i] == &field) {
            resolution.observed_type = field.type_name;
            resolution.observed_ordinal = static_cast<std::uint32_t>(i);
            resolution.observed_count = static_cast<std::uint32_t>(shaped.size());
            break;
        }
    }
    return resolution;
}

}  // namespace

Result<FieldResolution> OffsetTable::LookupField(const FieldQuery& query) const {
    const auto klass = ResolveClass(*source_, query.owner);
    if (!klass.ok()) {
        return klass.error();
    }
    const auto [reference, class_provenance] = klass.value();
    const auto fields = source_->Fields(reference);

    if (const auto* found = FieldNamed(fields, query.name)) {
        return Resolved(*found, fields, Weaker(class_provenance, Provenance::kExactName));
    }
    for (const auto alias : query.aliases) {
        if (const auto* found = FieldNamed(fields, alias)) {
            return Resolved(*found, fields, Weaker(class_provenance, Provenance::kAlias));
        }
    }

    if (query.type_count == 0 || query.type_name.empty()) {
        return Error{ErrorCode::kNotFound,
                     "no field of that name, and no fingerprint to fall back on"};
    }

    const auto shaped = InstanceFieldsOfType(fields, query.type_name);
    if (shaped.size() != query.type_count) {
        // The strictness is the feature. A field of this type was added or
        // removed, so the recorded ordinal now points somewhere else — and a
        // plausible wrong offset is worse than none.
        return Error{ErrorCode::kNotFound,
                     "the class no longer has the recorded number of fields of that type"};
    }
    if (query.type_ordinal >= shaped.size()) {
        return Error{ErrorCode::kInvalidArgument,
                     "the fingerprint's ordinal lies outside its own recorded count"};
    }
    return Resolved(*shaped[query.type_ordinal], fields, Provenance::kFingerprint);
}

Result<MethodResolution> OffsetTable::LookupMethod(const MethodQuery& query) const {
    const auto klass = ResolveClass(*source_, query.owner);
    if (!klass.ok()) {
        return klass.error();
    }
    const auto [reference, class_provenance] = klass.value();
    const auto methods = source_->Methods(reference);

    const MethodDescription* found = nullptr;
    auto provenance = Provenance::kExactName;

    bool ambiguous = false;
    found = MethodNamed(methods, query.name, query, ambiguous);
    if (ambiguous) {
        return Error{ErrorCode::kNotFound, "more than one method matches that name and signature"};
    }

    if (found == nullptr) {
        for (const auto alias : query.aliases) {
            found = MethodNamed(methods, alias, query, ambiguous);
            if (ambiguous) {
                return Error{ErrorCode::kNotFound,
                             "more than one method matches that alias and signature"};
            }
            if (found != nullptr) {
                provenance = Provenance::kAlias;
                break;
            }
        }
    }

    if (found == nullptr) {
        if (!query.fingerprint || query.return_type.empty()) {
            // No shape layer for this one. A method identified by a shape that
            // several methods share is a detour on whichever the runtime
            // happens to list first, and that is a crash rather than a wrong
            // number — see `MethodQuery::fingerprint`.
            return Error{ErrorCode::kNotFound,
                         "no method of that name, and its signature may not stand in for one"};
        }
        // Signature alone, and only when it picks out exactly one method. A
        // signature shared by two methods identifies neither.
        for (const auto& method : methods) {
            if (!SignatureMatches(method, query)) {
                continue;
            }
            if (found != nullptr) {
                return Error{ErrorCode::kNotFound,
                             "more than one method has that signature, so it identifies none"};
            }
            found = &method;
        }
        if (found == nullptr) {
            return Error{ErrorCode::kNotFound, "no method of that name or signature"};
        }
        provenance = Provenance::kFingerprint;
    }

    if (found->address == nullptr) {
        // The source could not verify the entry point against the game image.
        // Handing back an unverified address is how a hook jumps into data.
        return Error{ErrorCode::kNotFound, "the method has no verified native entry point"};
    }
    return MethodResolution{found->address, Weaker(class_provenance, provenance)};
}

Result<FieldResolution> OffsetTable::ResolveField(std::string_view key, const FieldQuery& query) {
    const auto outcome = LookupField(query);

    Entry entry;
    entry.key.assign(key);
    entry.kind = Kind::kField;
    if (outcome.ok()) {
        entry.resolved = true;
        entry.provenance = outcome.value().provenance;
        entry.offset = outcome.value().offset;
        entry.detail.assign(Describe(entry.provenance));

        // The live fingerprint, said out loud. Where the names are obfuscated —
        // which for this game is most of what a feature wants — a rebuild
        // renames everything and only the shape survives. Writing that shape
        // into a query from anything but a running game would be a guess, so
        // this is the one honest place to read it off.
        const auto& resolution = outcome.value();
        if (!resolution.observed_type.empty()) {
            entry.detail.append("; ")
                .append(resolution.observed_type)
                .append(" #")
                .append(std::to_string(resolution.observed_ordinal))
                .append(" of ")
                .append(std::to_string(resolution.observed_count));
        }
    } else {
        entry.detail.assign(outcome.error().message());
    }
    Record(std::move(entry));
    return outcome;
}

Result<MethodResolution> OffsetTable::ResolveMethod(std::string_view key,
                                                    const MethodQuery& query) {
    const auto outcome = LookupMethod(query);

    Entry entry;
    entry.key.assign(key);
    entry.kind = Kind::kMethod;
    if (outcome.ok()) {
        entry.resolved = true;
        entry.provenance = outcome.value().provenance;
        entry.address = outcome.value().address;
        entry.detail.assign(Describe(entry.provenance));
    } else {
        entry.detail.assign(outcome.error().message());
    }
    Record(std::move(entry));
    return outcome;
}

void OffsetTable::Record(Entry entry) {
    // Re-resolving replaces rather than appends: after a reconnect the table is
    // rebuilt, and a report listing the same key twice with different answers
    // would be worse than no report.
    for (auto& existing : entries_) {
        if (existing.key != entry.key || existing.kind != entry.kind) {
            continue;
        }
        existing = std::move(entry);
        return;
    }

    entries_.push_back(std::move(entry));
}

std::optional<std::uint32_t> OffsetTable::FieldOffset(std::string_view key) const noexcept {
    for (const auto& entry : entries_) {
        if (entry.kind == Kind::kField && entry.resolved && entry.key == key) {
            return entry.offset;
        }
    }
    return std::nullopt;
}

std::optional<void*> OffsetTable::MethodAddress(std::string_view key) const noexcept {
    for (const auto& entry : entries_) {
        if (entry.kind == Kind::kMethod && entry.resolved && entry.key == key) {
            return entry.address;
        }
    }
    return std::nullopt;
}

std::size_t OffsetTable::unresolved() const noexcept {
    std::size_t count = 0;
    for (const auto& entry : entries_) {
        if (!entry.resolved) {
            ++count;
        }
    }
    return count;
}

}  // namespace brownie::game
