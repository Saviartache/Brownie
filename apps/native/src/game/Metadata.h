// What offset resolution needs to know about the game, and nothing else.
//
// An interface rather than a direct dependency on IL2CPP, for one reason: the
// resolution rules — which alias to try, when a fingerprint is trustworthy
// enough to trust an offset to — are the part that decides whether a feature
// reads the right memory. They cannot be exercised inside a running game
// without risking exactly the corruption they exist to prevent, so they are
// written against this interface and tested against a fake.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace brownie::game {

/// An opaque handle to a class in whatever metadata the source describes.
/// Callers pass it back; they never look inside it.
using ClassRef = const void*;
using MethodRef = const void*;

struct FieldDescription {
    std::string name;
    /// The declared type, spelled the way the runtime spells it. This is the
    /// fingerprint a rename is recovered from, so it must be the runtime's own
    /// rendering, not a reconstruction.
    std::string type_name;
    std::uint32_t offset = 0;
    bool is_static = false;
};

struct MethodDescription {
    std::string name;
    std::string return_type;
    std::vector<std::string> parameter_types;
    /// The native entry point, already verified to be code inside the game
    /// image — or null when it could not be verified. Verification happens in
    /// the source, so nothing downstream ever holds an unchecked pointer.
    void* address = nullptr;
    /// The runtime's opaque method handle, for calls that require generic
    /// context and therefore cannot safely use the entry point alone.
    MethodRef reference = nullptr;
};

class MetadataSource {
  public:
    MetadataSource() = default;
    virtual ~MetadataSource() = default;

    MetadataSource(const MetadataSource&) = delete;
    MetadataSource& operator=(const MetadataSource&) = delete;
    MetadataSource(MetadataSource&&) = delete;
    MetadataSource& operator=(MetadataSource&&) = delete;

    [[nodiscard]] virtual std::optional<ClassRef> FindClass(std::string_view name_space,
                                                            std::string_view name) const = 0;

    /// Finds a class in a *named assembly* rather than the one image the source
    /// opened.
    ///
    /// The game's own code is one assembly; Unity's is several more, and the
    /// module has to reach into them the moment it wants anything from the
    /// engine itself — `UnityEngine.GameObject` is not in `Assembly-CSharp` and
    /// never will be. Asking for it by namespace and name alone finds nothing,
    /// and asking by bare name finds whichever class happens to carry it.
    ///
    /// The default finds nothing, for the same reason `FindClassAnywhere`'s
    /// does: a source that can only describe one image should say so rather
    /// than answer from the wrong one.
    [[nodiscard]] virtual std::optional<ClassRef> FindClassIn(std::string_view assembly,
                                                              std::string_view name_space,
                                                              std::string_view name) const {
        (void)assembly;
        (void)name_space;
        (void)name;
        return std::nullopt;
    }

    /// Finds a class by its bare name, whatever namespace it is in.
    ///
    /// For when the namespace is not known. `ApplicationManager` forced this:
    /// it looked absent for as long as it was asked for in the global
    /// namespace, and is in fact `DecaGames.RotMG.Managers.ApplicationManager`.
    /// Roughly a third of this game's classes keep a real namespace, so being
    /// wrong about one is the ordinary way to fail to find a class that is
    /// sitting right there.
    ///
    /// **Refuses when more than one class carries the name.** A bare name
    /// shared by two classes identifies neither, and picking whichever the
    /// runtime happened to list first is the guess this whole layer exists to
    /// avoid. It proves less than an exact match in a known image, so a
    /// resolution through it is reported as no better than an alias.
    ///
    /// The default finds nothing: a source that cannot search past its own
    /// image should say so rather than pretend the class is absent.
    [[nodiscard]] virtual std::optional<ClassRef> FindClassAnywhere(std::string_view name) const {
        (void)name;
        return std::nullopt;
    }

    /// Whether the runtime has finished building this class.
    ///
    /// **The gate on asking a class anything about its members.** Asking a
    /// class its name is safe whatever state it is in; asking an unprepared one
    /// for its fields or methods is not, and is how the reference
    /// implementation crashed inside `GameAssembly` with nothing in the dump to
    /// point at the cause. A class the game has not used yet is registered and
    /// unbuilt, which early in a run is most of them.
    ///
    /// The default says yes, for a source that has nothing to prepare — a test
    /// double describes classes that are simply there.
    [[nodiscard]] virtual bool IsPrepared(ClassRef klass) const noexcept {
        (void)klass;
        return true;
    }

    /// Every field of the class, in declaration order.
    ///
    /// Returns owned copies rather than views into runtime memory: resolution
    /// runs once per feature at startup and again after a reconnect, never on a
    /// frame, and a view into a structure the garbage collector may move is a
    /// bug waiting for the wrong moment.
    [[nodiscard]] virtual std::vector<FieldDescription> Fields(ClassRef klass) const = 0;

    [[nodiscard]] virtual std::vector<MethodDescription> Methods(ClassRef klass) const = 0;
};

}  // namespace brownie::game
