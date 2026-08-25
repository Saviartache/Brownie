// The IL2CPP runtime, reached only through the C API it exports.
//
// **This is the load-bearing decision of the whole game layer.** `GameAssembly.dll`
// exports 240 `il2cpp_*` functions by name. Everything the module needs — find a
// class, find a field, read its offset, find a method, walk an image, attach a
// thread — is one of them.
//
// The reference implementation instead carried six generated headers describing
// IL2CPP's internal structs and walked those structs by hand. That cost:
//
//   * The headers had to be regenerated for every Unity version, from metadata
//     that this game ships encrypted — a build step that could not be run
//     without first defeating the encryption.
//   * A struct field at a wrong offset reads whatever is there. One such walk
//     iterated the runtime's class table and dereferenced entries the runtime
//     had not initialised yet, which crashed inside GameAssembly with nothing in
//     the dump to say why.
//
// Both disappear here. The types below are declared and never defined: they are
// incomplete on purpose, so a pointer to one cannot be dereferenced and no
// layout assumption can be written even by accident. The single place that must
// read raw memory is quarantined in `Il2CppRuntime`, documented, and verified
// against the image before the value is used.

#pragma once

#include <cstddef>
#include <cstdint>

#include <Windows.h>

#include "core/Result.h"

namespace brownie::game {

// Opaque by design — see the file comment. Never define these.
struct Il2CppDomain;
struct Il2CppAssembly;
struct Il2CppImage;
struct Il2CppClass;
struct Il2CppType;
struct Il2CppThread;
struct Il2CppObject;
struct FieldInfo;
struct MethodInfo;

/// The subset of the exported API this module calls.
///
/// Every member is named exactly like the export it holds, so the loader can
/// bind them by stringising the member name — a name and its function cannot
/// drift apart, because they are the same token.
struct Il2CppApi {
    Il2CppDomain* (*il2cpp_domain_get)() = nullptr;
    const Il2CppAssembly* (*il2cpp_domain_assembly_open)(Il2CppDomain*, const char*) = nullptr;
    const Il2CppImage* (*il2cpp_assembly_get_image)(const Il2CppAssembly*) = nullptr;

    Il2CppClass* (*il2cpp_class_from_name)(const Il2CppImage*, const char*, const char*) = nullptr;
    std::size_t (*il2cpp_image_get_class_count)(const Il2CppImage*) = nullptr;
    const Il2CppClass* (*il2cpp_image_get_class)(const Il2CppImage*, std::size_t) = nullptr;

    /// Visits every class the runtime knows, in every assembly.
    ///
    /// The only way to reach a class outside the one image this module opens —
    /// and some of what the game needs is outside it. The runtime's own
    /// iterator, over classes it has itself prepared, which is what makes it
    /// safe where walking the metadata tables by hand is not.
    void (*il2cpp_class_for_each)(void (*)(Il2CppClass*, void*), void*) = nullptr;

    const char* (*il2cpp_class_get_name)(Il2CppClass*) = nullptr;
    const char* (*il2cpp_class_get_namespace)(Il2CppClass*) = nullptr;
    // **`il2cpp_runtime_class_init` is deliberately absent, and this paragraph
    // is why.**
    //
    // Its name says "finish preparing this class"; what it does is *run the
    // class's static constructor* — the game's own code, on whichever thread
    // asked, at a moment the game did not choose. One class in this game
    // answers that by building a singleton:
    //
    //     FKALGHJIADI..cctor -> OKJDOKPEMAB..cctor -> MonoSingleton.get_instance
    //       -> GameObject..ctor -> ApplicationManager.Init
    //       -> NullReferenceException, one per frame, then abort
    //
    // The game did not start, and nothing in the crash pointed at the module —
    // adding a single new class query was the whole of the change. Asking about
    // a class must not change the game, so the module waits for the game to
    // build one and never builds one itself; `il2cpp_class_is_inited` below is
    // how that is asked. Not binding it at all is what makes calling it a
    // compile error rather than a comment somebody may not read.

    /// The base class, or null at the root. What a name says nothing about,
    /// this often does: an unreadable class deriving from a readable one has
    /// already told you most of what it is.
    Il2CppClass* (*il2cpp_class_get_parent)(Il2CppClass*) = nullptr;

    /// Whether the runtime has finished preparing this class.
    ///
    /// The gate on any sweep across every class in the image. Asking one for
    /// its name is safe; asking an unprepared one for its members is how the
    /// reference implementation crashed inside `GameAssembly` with nothing in
    /// the dump to say why.
    bool (*il2cpp_class_is_inited)(const Il2CppClass*) = nullptr;

    FieldInfo* (*il2cpp_class_get_fields)(Il2CppClass*, void**) = nullptr;
    const char* (*il2cpp_field_get_name)(FieldInfo*) = nullptr;
    const Il2CppType* (*il2cpp_field_get_type)(FieldInfo*) = nullptr;
    std::size_t (*il2cpp_field_get_offset)(FieldInfo*) = nullptr;
    int (*il2cpp_field_get_flags)(FieldInfo*) = nullptr;

    /// Reads a static field into `out`, which must be large enough for the
    /// field's type. How a singleton is reached without a scan of the scene.
    void (*il2cpp_field_static_get_value)(FieldInfo*, void* out) = nullptr;

    /// Puts `value` back, reading the same number of bytes the type occupies.
    ///
    /// The counterpart of the read above, and the only way to change a static
    /// whose type is a *struct*: it has no object to reach through, so its
    /// storage cannot be written the way a field of a live object can.
    void (*il2cpp_field_static_set_value)(FieldInfo*, void* value) = nullptr;

    /// How large one value of a class is, and how large a boxed one is.
    ///
    /// **Both, because the difference between them is the answer.** IL2CPP
    /// reports a value type's field offsets against its *boxed* layout, so
    /// using one to index the bare value overshoots by whatever the box puts in
    /// front of it. Subtracting one size from the other says how much that is,
    /// on this runtime, without a constant to be wrong about.
    std::int32_t (*il2cpp_class_value_size)(Il2CppClass*, std::uint32_t* align) = nullptr;
    std::int32_t (*il2cpp_class_instance_size)(Il2CppClass*) = nullptr;

    const MethodInfo* (*il2cpp_class_get_methods)(Il2CppClass*, void**) = nullptr;
    const char* (*il2cpp_method_get_name)(const MethodInfo*) = nullptr;
    const Il2CppType* (*il2cpp_method_get_return_type)(const MethodInfo*) = nullptr;
    const Il2CppType* (*il2cpp_method_get_param)(const MethodInfo*, std::uint32_t) = nullptr;
    std::uint32_t (*il2cpp_method_get_param_count)(const MethodInfo*) = nullptr;

    /// Returns a string the caller owns; free it with `il2cpp_free`.
    char* (*il2cpp_type_get_name)(const Il2CppType*) = nullptr;
    void (*il2cpp_free)(void*) = nullptr;

    /// The class of a live object, which is not always the class its field was
    /// declared with.
    ///
    /// **The alternative is reading the first word of the object**, which is
    /// where the pointer happens to be — and a layout assumption this project
    /// does not make anywhere else. One export removes it.
    Il2CppClass* (*il2cpp_object_get_class)(Il2CppObject*) = nullptr;

    /// The two halves of "a `System.Type` for this class", which is what
    /// Unity's `GetComponent` wants. The runtime keeps the object it builds, so
    /// asking twice costs a lookup rather than an allocation.
    const Il2CppType* (*il2cpp_class_get_type)(Il2CppClass*) = nullptr;
    Il2CppObject* (*il2cpp_type_get_object)(const Il2CppType*) = nullptr;

    /// The class behind a type, which is how a field's declared type is sized.
    Il2CppClass* (*il2cpp_class_from_type)(const Il2CppType*) = nullptr;

    /// A managed string, for the methods that take one.
    ///
    /// Garbage-collected like anything else the runtime allocates, so it is
    /// made on the thread that is about to pass it and never kept: a reference
    /// held in native memory is a reference the collector cannot see.
    Il2CppObject* (*il2cpp_string_new)(const char*) = nullptr;
    std::int32_t (*il2cpp_string_length)(Il2CppObject*) = nullptr;
    const std::uint16_t* (*il2cpp_string_chars)(Il2CppObject*) = nullptr;

    Il2CppObject* (*il2cpp_runtime_invoke)(const MethodInfo*, void*, void**, Il2CppObject**) =
        nullptr;
    void* (*il2cpp_object_unbox)(Il2CppObject*) = nullptr;

    Il2CppThread* (*il2cpp_thread_attach)(Il2CppDomain*) = nullptr;
    void (*il2cpp_thread_detach)(Il2CppThread*) = nullptr;
    Il2CppThread* (*il2cpp_thread_current)() = nullptr;

    /// Binds every member above from an already-loaded `GameAssembly.dll`.
    ///
    /// All-or-nothing: a partially bound table would let a feature run until it
    /// reached the one function that is missing, which is the failure mode this
    /// module exists to not have. A missing export means the game changed in a
    /// way worth stopping for.
    static Result<Il2CppApi> Load(HMODULE game_assembly);
};

/// A string the IL2CPP allocator owns, freed on the way out.
///
/// `il2cpp_type_get_name` hands back memory the caller must release with
/// `il2cpp_free` — a pairing that resolution code does across early returns,
/// which is exactly where a hand-written free gets skipped.
class ApiString {
  public:
    ApiString() noexcept = default;
    ApiString(const Il2CppApi& api, char* owned) noexcept : api_{&api}, text_{owned} {}

    ApiString(const ApiString&) = delete;
    ApiString& operator=(const ApiString&) = delete;

    ApiString(ApiString&& other) noexcept
        : api_{other.api_}, text_{other.text_} {
        other.text_ = nullptr;
    }

    ApiString& operator=(ApiString&& other) noexcept {
        if (this != &other) {
            Release();
            api_ = other.api_;
            text_ = other.text_;
            other.text_ = nullptr;
        }
        return *this;
    }

    ~ApiString() { Release(); }

    /// Never null: a caller comparing names should not have to guard first, and
    /// an empty name matches nothing, which is the right outcome anyway.
    [[nodiscard]] const char* c_str() const noexcept { return text_ != nullptr ? text_ : ""; }

  private:
    void Release() noexcept {
        if (api_ != nullptr && text_ != nullptr) {
            api_->il2cpp_free(text_);
        }
        text_ = nullptr;
    }

    const Il2CppApi* api_ = nullptr;
    char* text_ = nullptr;
};

}  // namespace brownie::game
