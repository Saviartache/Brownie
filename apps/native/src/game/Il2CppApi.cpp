#include "game/Il2CppApi.h"

namespace brownie::game {
namespace {

/// Resolves one export into the member that holds it.
///
/// Templated on the member's own type so the cast cannot silently accept a
/// function of the wrong shape: change a signature in the header and this stops
/// compiling, rather than mis-calling at runtime.
template <typename Fn>
Status Bind(HMODULE module, const char* name, Fn& out) noexcept {
    // The double cast is what Win32 requires to go from an object pointer to a
    // function pointer; it is well defined on Windows, which is the only
    // platform this module targets.
    auto* proc = ::GetProcAddress(module, name);
    if (proc == nullptr) {
        return Error{ErrorCode::kNotFound, "GameAssembly is missing an IL2CPP export",
                     ::GetLastError()};
    }
    out = reinterpret_cast<Fn>(reinterpret_cast<void*>(proc));
    return {};
}

}  // namespace

// Binds `api.<name>` from the export literally called "<name>". Stringising the
// member is the point: the pair cannot be mismatched, because there is only one
// token to get right.
#define BROWNIE_BIND(fn)                                          \
    if (auto bound = Bind(game_assembly, #fn, api.fn); !bound) {  \
        return bound.error();                                     \
    }

Result<Il2CppApi> Il2CppApi::Load(HMODULE game_assembly) {
    if (game_assembly == nullptr) {
        return Error{ErrorCode::kNotReady, "GameAssembly.dll is not loaded yet"};
    }

    Il2CppApi api;
    BROWNIE_BIND(il2cpp_domain_get)
    BROWNIE_BIND(il2cpp_domain_assembly_open)
    BROWNIE_BIND(il2cpp_assembly_get_image)
    BROWNIE_BIND(il2cpp_class_from_name)
    BROWNIE_BIND(il2cpp_image_get_class_count)
    BROWNIE_BIND(il2cpp_image_get_class)
    BROWNIE_BIND(il2cpp_class_for_each)
    BROWNIE_BIND(il2cpp_class_get_name)
    BROWNIE_BIND(il2cpp_class_get_namespace)
    BROWNIE_BIND(il2cpp_class_get_parent)
    BROWNIE_BIND(il2cpp_class_is_inited)
    BROWNIE_BIND(il2cpp_class_get_fields)
    BROWNIE_BIND(il2cpp_field_get_name)
    BROWNIE_BIND(il2cpp_field_get_type)
    BROWNIE_BIND(il2cpp_field_get_offset)
    BROWNIE_BIND(il2cpp_field_get_flags)
    BROWNIE_BIND(il2cpp_field_static_get_value)
    BROWNIE_BIND(il2cpp_class_get_methods)
    BROWNIE_BIND(il2cpp_method_get_name)
    BROWNIE_BIND(il2cpp_method_get_return_type)
    BROWNIE_BIND(il2cpp_method_get_param)
    BROWNIE_BIND(il2cpp_method_get_param_count)
    BROWNIE_BIND(il2cpp_type_get_name)
    BROWNIE_BIND(il2cpp_free)
    BROWNIE_BIND(il2cpp_object_get_class)
    BROWNIE_BIND(il2cpp_class_get_type)
    BROWNIE_BIND(il2cpp_type_get_object)
    BROWNIE_BIND(il2cpp_string_new)
    BROWNIE_BIND(il2cpp_string_length)
    BROWNIE_BIND(il2cpp_string_chars)
    BROWNIE_BIND(il2cpp_runtime_invoke)
    BROWNIE_BIND(il2cpp_object_unbox)
    BROWNIE_BIND(il2cpp_thread_attach)
    BROWNIE_BIND(il2cpp_thread_detach)
    BROWNIE_BIND(il2cpp_thread_current)
    return api;
}

#undef BROWNIE_BIND

}  // namespace brownie::game
