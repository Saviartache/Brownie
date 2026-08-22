#include "game/Il2CppRuntime.h"

#include <cstring>

namespace brownie::game {
namespace {

/// `FIELD_ATTRIBUTE_STATIC` from ECMA-335. A static field's offset is into the
/// class's static storage, not into an instance, so telling the two apart is
/// the difference between reading a player's HP and reading whatever sits at
/// that offset in an unrelated block.
constexpr int kFieldAttributeStatic = 0x0010;

// **Everything below is a bound on a number that came out of the game's own
// memory, and this module is built without exceptions — so a `throw` inside the
// standard library is an `abort` of the game.** A count read from a structure
// the runtime has not finished writing is whatever those bytes happened to
// hold; reserving for it, or appending until an iterator that is walking
// garbage says stop, ends the process. None of these limits is a number anybody
// is expected to reach.

/// The most parameters a method this module will describe may have. The widest
/// method in a Unity image is a dozen or so.
constexpr std::uint32_t kMaxParameters = 64;

/// The most fields or methods it will list for one class. The largest classes
/// in this game are a few hundred members.
constexpr std::size_t kMaxMembers = 4096;

/// The longest a name or a type name may be. Obfuscated names are eleven
/// characters; a generic instantiation spelled out in full is the long case.
constexpr std::size_t kMaxNameBytes = 1024;

/// A string from the runtime, bounded.
///
/// A `const char*` out of a half-built structure may not be terminated inside
/// anything sane, and `std::string`'s constructor walks it until it is. This
/// stops at a length no real name reaches, so the worst case is a truncated
/// name that matches nothing rather than an allocation that ends the game.
[[nodiscard]] std::string Bounded(const char* text) {
    if (text == nullptr) {
        return {};
    }
    return std::string{text, ::strnlen(text, kMaxNameBytes)};
}

/// The IL2CPP C API is not const-correct: it takes `Il2CppClass*` even for
/// operations that only read. The objects are not const — the runtime owns and
/// mutates them — so this restores what the API's own signature asserts, and it
/// happens in one place rather than at every call site.
[[nodiscard]] Il2CppClass* AsClass(ClassRef klass) noexcept {
    return const_cast<Il2CppClass*>(static_cast<const Il2CppClass*>(klass));
}

}  // namespace

ThreadScope::ThreadScope(const Il2CppApi& api, Il2CppDomain* domain) noexcept : api_{&api} {
    if (api.il2cpp_thread_current() != nullptr) {
        // Already known to the runtime — a hook body on the game's own thread,
        // or a nested scope. Detaching it later would take the thread out from
        // under whoever attached it.
        attached_ = true;
        return;
    }
    owned_ = api.il2cpp_thread_attach(domain);
    attached_ = owned_ != nullptr;
}

ThreadScope::~ThreadScope() {
    if (owned_ != nullptr) {
        api_->il2cpp_thread_detach(owned_);
    }
}

Result<std::unique_ptr<Il2CppRuntime>> Il2CppRuntime::Attach(std::string_view assembly_name) {
    const HMODULE module = ::GetModuleHandleW(L"GameAssembly.dll");
    if (module == nullptr) {
        return Error{ErrorCode::kNotReady, "GameAssembly.dll is not loaded yet"};
    }

    auto api = Il2CppApi::Load(module);
    if (!api.ok()) {
        return api.error();
    }
    auto image = ModuleImage::Of(module);
    if (!image.ok()) {
        return image.error();
    }

    Il2CppDomain* domain = api.value().il2cpp_domain_get();
    if (domain == nullptr) {
        // The module is loaded before IL2CPP initialises itself, so this is the
        // ordinary state at injection time and a reason to retry.
        return Error{ErrorCode::kNotReady, "the IL2CPP runtime has not started yet"};
    }

    const ThreadScope scope{api.value(), domain};
    if (!scope.attached()) {
        return Error{ErrorCode::kNotReady, "the runtime refused to attach this thread"};
    }

    // `string_view` is not null-terminated; the C API needs one.
    const std::string name{assembly_name};
    const Il2CppAssembly* assembly = api.value().il2cpp_domain_assembly_open(domain, name.c_str());
    if (assembly == nullptr) {
        return Error{ErrorCode::kNotFound, "no assembly of that name in the domain"};
    }

    const Il2CppImage* assembly_image = api.value().il2cpp_assembly_get_image(assembly);
    if (assembly_image == nullptr) {
        return Error{ErrorCode::kInternal, "the assembly has no image"};
    }

    return std::make_unique<Il2CppRuntime>(Key{}, api.value(), image.value(), domain,
                                           assembly_image);
}

std::optional<ClassRef> Il2CppRuntime::FindClass(std::string_view name_space,
                                                 std::string_view name) const {
    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return std::nullopt;
    }

    const std::string owned_namespace{name_space};
    const std::string owned_name{name};
    Il2CppClass* found =
        api_.il2cpp_class_from_name(assembly_image_, owned_namespace.c_str(), owned_name.c_str());
    if (found == nullptr) {
        return std::nullopt;
    }

    // Found, and nothing more done to it. **Asking about a class must not
    // change the game** — see the paragraph in `Il2CppApi.h` about the export
    // this deliberately does not bind. Everything that needs a *built* class
    // waits until the game has built one; `IsPrepared` is that question, and
    // the offset table gates every resolution on it.
    return static_cast<ClassRef>(found);
}

namespace {

/// What the visitor below collects. A count as well as a hit, because finding
/// two is a different answer from finding one.
struct BareNameSearch {
    const Il2CppApi* api;
    std::string_view wanted;
    Il2CppClass* found;
    std::size_t matches;
};

}  // namespace

std::optional<ClassRef> Il2CppRuntime::FindClassAnywhere(std::string_view name) const {
    if (name.empty()) {
        return std::nullopt;
    }
    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return std::nullopt;
    }

    BareNameSearch search{&api_, name, nullptr, 0};
    api_.il2cpp_class_for_each(
        [](Il2CppClass* klass, void* state) {
            auto* search_state = static_cast<BareNameSearch*>(state);
            if (klass == nullptr) {
                return;
            }
            const char* found_name = search_state->api->il2cpp_class_get_name(klass);
            if (found_name == nullptr || search_state->wanted != found_name) {
                return;
            }
            ++search_state->matches;
            if (search_state->found == nullptr) {
                search_state->found = klass;
            }
        },
        &search);

    // Two classes sharing a bare name identify neither, and taking whichever
    // the runtime listed first is exactly the guess this layer exists to avoid.
    if (search.matches != 1 || search.found == nullptr) {
        return std::nullopt;
    }
    // Not initialised either, for the reason `FindClass` gives.
    return static_cast<ClassRef>(search.found);
}

const Il2CppImage* Il2CppRuntime::ImageOf(std::string_view assembly) const {
    if (assembly.empty()) {
        return assembly_image_;
    }
    for (const auto& [name, image] : images_) {
        if (name == assembly) {
            // Remembered even when it is null: an assembly this game does not
            // ship is asked for on every turn of the loop otherwise, and the
            // answer cannot change.
            return image;
        }
    }

    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        // Not remembered: the runtime refused the attach, which says nothing
        // about whether the assembly is there.
        return nullptr;
    }

    const std::string owned{assembly};
    const Il2CppAssembly* found = api_.il2cpp_domain_assembly_open(domain_, owned.c_str());
    const Il2CppImage* image =
        found != nullptr ? api_.il2cpp_assembly_get_image(found) : nullptr;
    images_.emplace_back(owned, image);
    return image;
}

std::optional<ClassRef> Il2CppRuntime::FindClassIn(std::string_view assembly,
                                                   std::string_view name_space,
                                                   std::string_view name) const {
    const Il2CppImage* image = ImageOf(assembly);
    if (image == nullptr) {
        return std::nullopt;
    }

    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return std::nullopt;
    }

    const std::string owned_namespace{name_space};
    const std::string owned_name{name};
    Il2CppClass* found =
        api_.il2cpp_class_from_name(image, owned_namespace.c_str(), owned_name.c_str());
    if (found == nullptr) {
        return std::nullopt;
    }
    // Found, and nothing more done to it — see `FindClass` for why asking about
    // a class must not build one.
    return static_cast<ClassRef>(found);
}

std::optional<ClassRef> Il2CppRuntime::ClassOf(void* object) const {
    if (object == nullptr) {
        return std::nullopt;
    }
    Il2CppClass* klass = api_.il2cpp_object_get_class(static_cast<Il2CppObject*>(object));
    if (klass == nullptr) {
        return std::nullopt;
    }
    return static_cast<ClassRef>(klass);
}

void* Il2CppRuntime::TypeObject(ClassRef klass) const {
    if (klass == nullptr) {
        return nullptr;
    }
    const Il2CppType* type = api_.il2cpp_class_get_type(AsClass(klass));
    if (type == nullptr) {
        return nullptr;
    }
    return api_.il2cpp_type_get_object(type);
}

void* Il2CppRuntime::NewString(const char* text) const {
    if (text == nullptr) {
        return nullptr;
    }
    return api_.il2cpp_string_new(text);
}

std::vector<FieldDescription> Il2CppRuntime::Fields(ClassRef klass) const {
    std::vector<FieldDescription> fields;
    if (klass == nullptr) {
        return fields;
    }
    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return fields;
    }

    Il2CppClass* target = AsClass(klass);
    void* iterator = nullptr;
    while (FieldInfo* field = api_.il2cpp_class_get_fields(target, &iterator)) {
        if (fields.size() >= kMaxMembers) {
            break;
        }
        FieldDescription description;
        description.name = Bounded(api_.il2cpp_field_get_name(field));
        description.type_name = TypeName(api_.il2cpp_field_get_type(field));
        description.offset = static_cast<std::uint32_t>(api_.il2cpp_field_get_offset(field));
        description.is_static = (api_.il2cpp_field_get_flags(field) & kFieldAttributeStatic) != 0;
        fields.push_back(std::move(description));
    }
    return fields;
}

std::string Il2CppRuntime::ClassName(ClassRef klass) const {
    if (klass == nullptr) {
        return {};
    }
    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return {};
    }

    Il2CppClass* target = AsClass(klass);
    const char* name_space = api_.il2cpp_class_get_namespace(target);
    const char* name = api_.il2cpp_class_get_name(target);
    if (name == nullptr) {
        return {};
    }

    std::string full;
    if (name_space != nullptr && *name_space != '\0') {
        full.append(Bounded(name_space)).append(".");
    }
    full.append(Bounded(name));
    return full;
}

std::string Il2CppRuntime::BaseClassName(ClassRef klass) const {
    const auto parent = BaseClass(klass);
    return parent.has_value() ? ClassName(*parent) : std::string{};
}

std::optional<Il2CppRuntime::StaticFieldRef> Il2CppRuntime::FindStaticField(
    ClassRef klass, std::string_view field_name) const {
    if (klass == nullptr || field_name.empty()) {
        return std::nullopt;
    }
    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return std::nullopt;
    }

    Il2CppClass* target = AsClass(klass);
    // The class must have run its static constructor, or the storage the field
    // lives in has not been written yet and a read returns whatever was there.
    //
    // **Waited for, not caused.** Running it ourselves means running the game's
    // own code on our thread at a moment it did not choose, and this game
    // answers one such constructor by building a singleton that is not ready to
    // be built — see `FindClass`. A singleton the game has not made yet is one
    // to ask about again next turn.
    if (!api_.il2cpp_class_is_inited(target)) {
        return std::nullopt;
    }

    void* iterator = nullptr;
    while (FieldInfo* field = api_.il2cpp_class_get_fields(target, &iterator)) {
        const char* name = api_.il2cpp_field_get_name(field);
        if (name == nullptr || field_name != name) {
            continue;
        }
        if ((api_.il2cpp_field_get_flags(field) & kFieldAttributeStatic) == 0) {
            // Reading an instance field as a static would hand back a number
            // from unrelated storage, which is worse than nothing.
            return std::nullopt;
        }
        return static_cast<StaticFieldRef>(field);
    }
    return std::nullopt;
}

void* Il2CppRuntime::ReadStaticReference(StaticFieldRef field) const {
    if (field == nullptr) {
        return nullptr;
    }
    void* value = nullptr;
    // No thread scope: this reads storage the runtime has already written, it
    // allocates nothing, and it runs on a loop. Attaching and detaching around
    // it would cost more than the read.
    api_.il2cpp_field_static_get_value(
        const_cast<FieldInfo*>(static_cast<const FieldInfo*>(field)), &value);
    return value;
}

std::optional<ClassRef> Il2CppRuntime::BaseClass(ClassRef klass) const {
    if (klass == nullptr) {
        return std::nullopt;
    }
    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return std::nullopt;
    }
    Il2CppClass* parent = api_.il2cpp_class_get_parent(AsClass(klass));
    if (parent == nullptr) {
        return std::nullopt;
    }
    return static_cast<ClassRef>(parent);
}

bool Il2CppRuntime::IsPrepared(ClassRef klass) const noexcept {
    if (klass == nullptr) {
        return false;
    }
    // No thread scope here: this reads a flag the runtime has already written,
    // and it is called once per class across the whole image — attaching and
    // detaching around each one would cost more than the sweep it guards.
    return api_.il2cpp_class_is_inited(static_cast<const Il2CppClass*>(klass));
}

std::vector<MethodDescription> Il2CppRuntime::Methods(ClassRef klass) const {
    std::vector<MethodDescription> methods;
    if (klass == nullptr) {
        return methods;
    }
    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return methods;
    }

    Il2CppClass* target = AsClass(klass);
    void* iterator = nullptr;
    while (const MethodInfo* method = api_.il2cpp_class_get_methods(target, &iterator)) {
        if (methods.size() >= kMaxMembers) {
            break;
        }
        MethodDescription description;
        description.name = Bounded(api_.il2cpp_method_get_name(method));
        description.return_type = TypeName(api_.il2cpp_method_get_return_type(method));

        // **Bounded, because this number comes from the game.** A count read
        // out of a structure the runtime has not finished building is whatever
        // was in that memory, and reserving it throws — out of a thread with no
        // catch, which ends the process the module is a guest in. No managed
        // method has anything like this many parameters, so a count past it is
        // a method to skip rather than describe.
        const std::uint32_t parameters = api_.il2cpp_method_get_param_count(method);
        if (parameters > kMaxParameters) {
            continue;
        }
        description.parameter_types.reserve(parameters);
        for (std::uint32_t i = 0; i < parameters; ++i) {
            description.parameter_types.push_back(TypeName(api_.il2cpp_method_get_param(method, i)));
        }

        description.address = EntryPointOf(method);
        methods.push_back(std::move(description));
    }
    return methods;
}

std::vector<std::string> Il2CppRuntime::ClassNames() const {
    std::vector<std::string> names;
    const ThreadScope scope{api_, domain_};
    if (!scope.attached()) {
        return names;
    }

    const std::size_t count = api_.il2cpp_image_get_class_count(assembly_image_);
    names.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
        const Il2CppClass* klass = api_.il2cpp_image_get_class(assembly_image_, i);
        if (klass == nullptr) {
            continue;
        }
        Il2CppClass* target = AsClass(klass);
        const char* name_space = api_.il2cpp_class_get_namespace(target);
        const char* name = api_.il2cpp_class_get_name(target);
        if (name == nullptr) {
            continue;
        }
        std::string full;
        if (name_space != nullptr && *name_space != '\0') {
            full.append(Bounded(name_space)).append(".");
        }
        full.append(Bounded(name));
        names.push_back(std::move(full));
    }
    return names;
}

std::string Il2CppRuntime::TypeName(const Il2CppType* type) const {
    if (type == nullptr) {
        return {};
    }
    const ApiString name{api_, api_.il2cpp_type_get_name(type)};
    return Bounded(name.c_str());
}

void* Il2CppRuntime::EntryPointOf(const MethodInfo* method) const noexcept {
    if (method == nullptr) {
        return nullptr;
    }

    // **The one struct assumption in this project.** `MethodInfo::methodPointer`
    // is the first member, at offset zero, and has been in every IL2CPP version
    // Unity has shipped. It cannot be avoided: no exported function returns a
    // method's native address. `il2cpp_runtime_invoke` can *call* a method
    // without knowing it, which is why calling needs no assumption — but a hook
    // needs the address itself.
    //
    // What makes this safe is the check below, not the paragraph above. If the
    // layout ever shifts, the first word is a metadata pointer, a token, or
    // padding — and none of those land in an executable section of
    // GameAssembly. A failed check yields null, which makes the method
    // unresolvable; the feature that wanted it goes quiet instead of hooking
    // into data.
    //
    // `memcpy` rather than a cast: `MethodInfo` is an incomplete type here by
    // design, so there is no way to name a member and no way for this to grow
    // into a second assumption.
    void* entry = nullptr;
    std::memcpy(&entry, method, sizeof(entry));
    return image_.ContainsCode(entry) ? entry : nullptr;
}

}  // namespace brownie::game
