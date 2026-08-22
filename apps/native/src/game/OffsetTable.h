// Offsets, resolved from the game that is actually running.
//
// **No offset in this project is ever a constant.** The reference implementation
// kept hard-coded numbers with a "fallback" path that used them when a lookup
// failed — so after a game patch, a feature did not stop, it read the wrong
// memory and wrote to it. That is the worst available outcome: a wrong offset
// is memory corruption, and corruption in someone else's process shows up
// somewhere unrelated, minutes later.
//
// The rule here is the opposite one: **an offset that cannot be verified does
// not exist, and the feature that needed it goes quiet.** A quiet feature is
// visible, reportable, and harmless.
//
// Recovery runs in three layers, in decreasing order of how much they prove:
//
//   1. **Exact name.** The class, field or method is where it was.
//   2. **Alias.** It was renamed, and this build's name is one we have seen. An
//      alias still proves identity by name, just an older one.
//   3. **Fingerprint.** Nothing matches by name, so identity is argued from
//      shape — a field's declared type, a method's signature. This layer is the
//      one that can be wrong, so it is deliberately the strictest: it accepts
//      only when the shape is unambiguous, and refuses rather than guess.
//
// Every resolution reports which layer answered, because a feature running on a
// fingerprint is a feature to look at before the next patch, not after it.

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/Result.h"
#include "game/Metadata.h"

namespace brownie::game {

/// Which layer answered. Ordered by how much it proves, so two provenances can
/// be combined by taking the weaker one — a field found by name inside a class
/// found by alias is only as trustworthy as the alias.
enum class Provenance : std::uint8_t {
    kExactName = 0,
    kAlias = 1,
    kFingerprint = 2,
};

[[nodiscard]] std::string_view Describe(Provenance provenance) noexcept;

struct ClassQuery {
    std::string_view name_space;
    std::string_view name;
    /// Names this class carried in earlier builds, newest first.
    std::span<const std::string_view> aliases{};

    /// Which assemblies to look in, in order, when the class is not in the
    /// game's own image. Empty — the usual case — means look there.
    ///
    /// A list rather than one name because Unity moves its own types between
    /// assemblies: the UI classes ship in `UnityEngine.UI` in one build and
    /// `Unity.ugui` in the next, and both are the same class under the same
    /// namespace. Trying each in turn is how a build change of that kind is
    /// survived without a rebuild — an alias for the *assembly* rather than for
    /// the class, and it proves exactly as much as one.
    std::span<const std::string_view> assemblies{};
};

struct FieldQuery {
    ClassQuery owner;
    std::string_view name;
    std::span<const std::string_view> aliases{};

    /// The fingerprint: the field's declared type, plus where it sits among the
    /// instance fields of that type and how many of them the class had when
    /// this query was written.
    ///
    /// `type_count` is not redundant with `type_ordinal`. Requiring the count to
    /// match is what makes the layer refuse instead of guess: if a field of the
    /// same type was added or removed, the ordinal now points at a different
    /// field, and matching only the ordinal would hand back a plausible,
    /// wrong offset. Leave `type_count` at 0 to disable fingerprint recovery
    /// for a field whose type is too common to identify it.
    std::string_view type_name{};
    std::uint32_t type_ordinal = 0;
    std::uint32_t type_count = 0;
};

struct MethodQuery {
    ClassQuery owner;
    std::string_view name;
    std::span<const std::string_view> aliases{};

    /// The signature. Always used to disambiguate overloads under the name
    /// layers; used as a fingerprint on its own only if {@link fingerprint}
    /// says so.
    std::string_view return_type{};
    std::span<const std::string_view> parameter_types{};

    /// Whether the signature alone may identify this method.
    ///
    /// **Off by default, which is the opposite of the field rule, and the
    /// asymmetry is the point.** A field matched by shape and got wrong reads
    /// the wrong number; a method matched by shape and got wrong is called — or
    /// detoured — through a prototype that does not describe it, and the
    /// arguments land in the wrong registers. Most signatures do not identify
    /// anything: a class has many a `void(float)`, and picking the only one is
    /// picking at random among the ones that happen to exist today.
    ///
    /// Turn it on only for a shape that is genuinely rare on its owner, and
    /// only having seen the live class say so.
    bool fingerprint = false;

    /// How many arguments the method takes, when its types cannot be written
    /// out. Zero means "not given", which is why a no-argument overload is
    /// disambiguated by a return type and an empty {@link parameter_types}
    /// instead — `Application.Quit` already is.
    ///
    /// **A weaker claim than a signature and a stronger one than a bare name**,
    /// and it exists for the case where the types are genuinely unwritable: a
    /// parameter whose type is obfuscator output changes its spelling with the
    /// build, and a spelling that is wrong refuses a method that is sitting
    /// right there. An argument count does not change with a rename.
    ///
    /// It never stands in for a name — it narrows the overloads of a name that
    /// was given — and two overloads of the same arity are still an ambiguity
    /// and still refused. It is only used when no signature is given; a query
    /// that has both is answered by the signature.
    std::size_t parameter_count = 0;
};

/// Finds the class a query names, under the rules above.
///
/// A free function rather than a step inside offset resolution, because a class
/// is also what a feature needs on its own: Unity's `GetComponent` takes a type,
/// not an offset. One implementation means the assembly list, the aliases, the
/// bare-name fallback and the "registered but not built" gate hold wherever a
/// class is named — rather than in the one caller that went through the table.
///
/// Fails with `kNotReady` when nothing matched: IL2CPP registers classes
/// lazily, so a class the game has not used yet is missing in exactly the way a
/// renamed one is, and only a query still failing after real play means
/// anything.
[[nodiscard]] Result<std::pair<ClassRef, Provenance>> ResolveClass(const MetadataSource& source,
                                                                   const ClassQuery& query);

struct FieldResolution {
    std::uint32_t offset;
    Provenance provenance;

    /// The fingerprint this field has in the game that is *running*: its
    /// declared type, which of that type's instance fields it is, and how many
    /// there are.
    ///
    /// Reported, not merely checked. A fingerprint written from anything but a
    /// live class is a guess, and the layer exists to stop guesses — so this is
    /// where a query's `type_ordinal` and `type_count` come from. Empty type
    /// name when the field is static, which has no instance-field ordinal.
    std::string observed_type;
    std::uint32_t observed_ordinal = 0;
    std::uint32_t observed_count = 0;
};

struct MethodResolution {
    void* address;
    Provenance provenance;
};

/// The resolved offsets for this run of the game.
///
/// Deliberately not a singleton and not global: it is built from a metadata
/// source, and when the game goes away so does everything in it. Lookups are a
/// linear scan over a few dozen entries, which is both faster than hashing at
/// this size and one less thing to get wrong.
class OffsetTable {
  public:
    explicit OffsetTable(const MetadataSource& source) noexcept : source_{&source} {}

    /// Resolves and remembers under `key`. `key` must outlive the table; in
    /// practice every one is a literal naming a feature's need, e.g.
    /// "self.hp" — which is what a report shows when it could not be found.
    ///
    /// **Call again for anything that failed with `kNotReady`.** IL2CPP builds
    /// classes lazily, so a class the game has not used yet is absent in
    /// exactly the way a renamed one is; only a key still unresolved after real
    /// play has proved anything.
    Result<FieldResolution> ResolveField(std::string_view key, const FieldQuery& query);
    Result<MethodResolution> ResolveMethod(std::string_view key, const MethodQuery& query);

    /// What a feature calls before it touches memory. `nullopt` means "go
    /// quiet" — never a default, never a guess.
    [[nodiscard]] std::optional<std::uint32_t> FieldOffset(std::string_view key) const noexcept;
    [[nodiscard]] std::optional<void*> MethodAddress(std::string_view key) const noexcept;

    enum class Kind : std::uint8_t { kField, kMethod };

    /// One line per attempted resolution, for the report the runtime shows.
    /// Failures are kept, not dropped: "we looked and it was not there" is the
    /// thing an operator needs to see after a patch.
    struct Entry {
        std::string key;
        Kind kind = Kind::kField;
        bool resolved = false;
        Provenance provenance = Provenance::kExactName;
        std::uint32_t offset = 0;
        void* address = nullptr;
        std::string detail;
    };

    [[nodiscard]] std::span<const Entry> entries() const noexcept { return entries_; }

    /// Number of entries that failed. Zero is the only good number, and the
    /// runtime says so out loud when it is not.
    [[nodiscard]] std::size_t unresolved() const noexcept;

    void Clear() noexcept { entries_.clear(); }

  private:
    /// The rules, with no bookkeeping. Split from `Resolve*` so that recording
    /// an outcome happens in exactly one place per kind — including the failing
    /// outcomes, which are the ones a report exists for.
    [[nodiscard]] Result<FieldResolution> LookupField(const FieldQuery& query) const;
    [[nodiscard]] Result<MethodResolution> LookupMethod(const MethodQuery& query) const;

    void Record(Entry entry);

    const MetadataSource* source_;
    std::vector<Entry> entries_;
};

}  // namespace brownie::game
