// The running game, described through the IL2CPP C API.
//
// This is the only file in the project that reads memory the runtime did not
// hand it, and it does so in exactly one place — `MethodDescription::address`.
// See `Il2CppRuntime::EntryPointOf` for the assumption, why it cannot be
// avoided, and what verifies it before the value escapes.

#pragma once

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include "core/ModuleImage.h"
#include "core/Result.h"
#include "game/ClassCatalog.h"
#include "game/Il2CppApi.h"
#include "game/Metadata.h"

namespace brownie::game {

/// Attaches the calling thread to the IL2CPP runtime for as long as it lives.
///
/// Any thread that calls into IL2CPP must be known to its garbage collector; a
/// thread that is not can be running while the collector moves the objects it
/// is reading. Our threads are ours — created by us, unknown to the runtime —
/// so every one of them needs this before it touches a class.
///
/// Detaches only if it attached: a hook body runs on the game's own thread,
/// which is attached already, and detaching that would take the game's thread
/// out from under it.
class ThreadScope {
  public:
    ThreadScope(const Il2CppApi& api, Il2CppDomain* domain) noexcept;

    ThreadScope(const ThreadScope&) = delete;
    ThreadScope& operator=(const ThreadScope&) = delete;
    ThreadScope(ThreadScope&&) = delete;
    ThreadScope& operator=(ThreadScope&&) = delete;

    ~ThreadScope();

    /// False when the runtime refused the attach, in which case the caller must
    /// not go on to call into IL2CPP.
    [[nodiscard]] bool attached() const noexcept { return attached_; }

  private:
    const Il2CppApi* api_;
    Il2CppThread* owned_ = nullptr;
    bool attached_ = false;
};

class Il2CppRuntime final : public ClassCatalog {
    /// Passkey. The constructor below is public so `std::make_unique` can reach
    /// it — nothing here allocates with a bare `new` — but only `Attach` can
    /// name this type, so the only way to obtain a runtime is through the
    /// checks `Attach` performs.
    struct Key {};

  public:
    Il2CppRuntime(Key /*unused*/, Il2CppApi api, ModuleImage image, Il2CppDomain* domain,
                  const Il2CppImage* assembly_image) noexcept
        : api_{api}, image_{image}, domain_{domain}, assembly_image_{assembly_image} {}

    /// Binds to `GameAssembly.dll` in this process and opens one assembly's
    /// image — the game's own, "Assembly-CSharp" by default.
    ///
    /// **Only call this once `Il2CppReady()` says so.** A non-null domain is
    /// not the same as a started runtime: `il2cpp_domain_get` returns one early
    /// inside `il2cpp_init`, and attaching a thread to its garbage collector or
    /// opening an assembly while that call is still running crashes the game on
    /// its main thread. Observed, not theorised — see `Il2CppReady`.
    ///
    /// Fails with `kNotReady` while the module is not loaded or the runtime has
    /// not finished starting. That is the ordinary case at injection time and a
    /// reason to retry, not to give up: the module is loaded before IL2CPP
    /// initialises itself.
    static Result<std::unique_ptr<Il2CppRuntime>> Attach(std::string_view assembly_name);

    [[nodiscard]] std::optional<ClassRef> FindClass(std::string_view name_space,
                                                    std::string_view name) const override;
    [[nodiscard]] std::optional<ClassRef> FindClassAnywhere(std::string_view name) const override;
    [[nodiscard]] std::optional<ClassRef> FindClassIn(std::string_view assembly,
                                                      std::string_view name_space,
                                                      std::string_view name) const override;
    [[nodiscard]] std::vector<FieldDescription> Fields(ClassRef klass) const override;
    [[nodiscard]] std::vector<MethodDescription> Methods(ClassRef klass) const override;

    /// Every class in the opened image, as "Namespace.Name".
    ///
    /// Enumeration goes through `il2cpp_image_get_class`, which returns classes
    /// the runtime has prepared. The reference implementation walked the class
    /// table out of the metadata itself and dereferenced entries the runtime had
    /// not initialised, which crashed inside GameAssembly with nothing in the
    /// dump to point at the cause.
    [[nodiscard]] std::vector<std::string> ClassNames() const override;

    /// One class's name, as `Namespace.Name`.
    [[nodiscard]] std::string ClassName(ClassRef klass) const;

    [[nodiscard]] std::string BaseClassName(ClassRef klass) const override;

    /// The class this one derives from, or nothing at the root.
    ///
    /// Needed because `Fields` returns a class's *own* fields: anything
    /// inherited is reached by walking up, one class at a time.
    [[nodiscard]] std::optional<ClassRef> BaseClass(ClassRef klass) const;

    /// Whether the runtime has finished preparing this class.
    ///
    /// **The gate on any sweep across the whole image.** Asking a class its
    /// name is safe whatever state it is in; asking an unprepared one for its
    /// members is not, and is how the reference implementation crashed inside
    /// `GameAssembly` with nothing in the dump to point at the cause.
    [[nodiscard]] bool IsPrepared(ClassRef klass) const noexcept override;

    /// An opaque handle to one static field, resolved once and read many times.
    using StaticFieldRef = const void*;

    /// Finds a static field by name. **Expensive**: it walks every field the
    /// class declares, so do it once and keep the handle.
    [[nodiscard]] std::optional<StaticFieldRef> FindStaticField(ClassRef klass,
                                                                std::string_view name) const;

    /// Reads a reference out of a static field found earlier.
    ///
    /// How a singleton is reached without asking Unity to walk every object in
    /// the scene, and cheap enough to do on a loop — no lookup, no allocation,
    /// one call into the runtime. Null when the field simply holds nothing yet,
    /// which for a singleton is the ordinary state before the game builds one.
    [[nodiscard]] void* ReadStaticReference(StaticFieldRef field) const;

    /// The class of a live object, or nothing when it cannot be asked.
    ///
    /// **Not the same as the class the field holding it was declared with**,
    /// which is the whole reason it is here: a field of type `Entity` holds
    /// whatever derives from `Entity`, and the members the module is looking
    /// for may be on the subclass.
    [[nodiscard]] std::optional<ClassRef> ClassOf(void* object) const;

    /// A `System.Type` for a class, as a managed object.
    ///
    /// What Unity's `GetComponent(Type)` takes. Null when the runtime will not
    /// build one, which makes the call impossible rather than wrong.
    ///
    /// **Game thread only**, like everything below: this reaches into the
    /// runtime's own allocator.
    [[nodiscard]] void* TypeObject(ClassRef klass) const;

    /// A managed copy of `text`, for a method that takes a string.
    ///
    /// Not kept: a managed reference held in native memory is one the collector
    /// cannot see, so it is made where it is passed and forgotten after.
    [[nodiscard]] void* NewString(const char* text) const;

    [[nodiscard]] const Il2CppApi& api() const noexcept { return api_; }
    [[nodiscard]] Il2CppDomain* domain() const noexcept { return domain_; }

  private:
    /// The image of one assembly by name, opened once and remembered.
    ///
    /// Opening is a lookup in the domain, not a load — every assembly the
    /// module asks for is one the game has already loaded — but it is a lookup
    /// per class query otherwise, and class queries run on the loop.
    ///
    /// **The cache is the IPC thread's**, because finding a class is: every
    /// caller of `FindClass*` resolves offsets, and resolution happens on the
    /// loop. What the game's thread reaches for is the class it was handed
    /// earlier, which touches none of this.
    [[nodiscard]] const Il2CppImage* ImageOf(std::string_view assembly) const;

    /// The type's name as the runtime spells it, or empty when it cannot say.
    [[nodiscard]] std::string TypeName(const Il2CppType* type) const;

    /// The native entry point of a method, verified to be code in the game
    /// image. Null when it is not — which makes the method unresolvable rather
    /// than dangerous.
    [[nodiscard]] void* EntryPointOf(const MethodInfo* method) const noexcept;

    Il2CppApi api_;
    ModuleImage image_;
    Il2CppDomain* domain_;
    const Il2CppImage* assembly_image_;

    /// Assemblies opened besides the game's own, by the name they were asked
    /// for. A handful of entries scanned linearly — a map would be more code
    /// and more allocation to search five strings.
    ///
    /// `mutable` because opening one is caching, not a change of state: the
    /// same question asked twice gives the same answer, and the alternative is
    /// a non-const lookup on a const runtime for the sake of a bookkeeping
    /// detail.
    mutable std::vector<std::pair<std::string, const Il2CppImage*>> images_;
};

}  // namespace brownie::game
