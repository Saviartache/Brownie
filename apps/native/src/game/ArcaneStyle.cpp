#include "game/ArcaneStyle.h"

#include "game/PlayerFields.h"
#include "game/SceneFields.h"

namespace brownie::game {
namespace {

constexpr std::string_view kInt32Type = "System.Int32";
constexpr std::int32_t kMaxLibraryItems = 4096;

[[nodiscard]] bool TakeField(const OffsetTable& table, std::string_view key,
                             std::uint32_t& out) {
    const auto value = table.FieldOffset(key);
    if (!value.has_value()) {
        return false;
    }
    out = *value;
    return true;
}

[[nodiscard]] bool TakeMethod(const OffsetTable& table, std::string_view key, void*& out) {
    const auto value = table.MethodAddress(key);
    if (!value.has_value()) {
        return false;
    }
    out = *value;
    return true;
}

}  // namespace

void ArcaneStyle::Bind(const Il2CppRuntime& game, const OffsetTable& table) {
    if (!static_bound_.load(std::memory_order_acquire)) {
        if (!TakeField(table, kPlayerShaderProperties, player_properties_at_) ||
            !TakeField(table, kShaderLibraryItems, library_items_at_) ||
            !TakeField(table, kShaderPropertiesId, properties_id_at_) ||
            !TakeMethod(table, kApplicationShaderEffects, get_shader_effects_) ||
            !TakeMethod(table, kShaderEffectLibrary, get_library_) ||
            !TakeMethod(table, kSetPlayerShader, set_player_properties_)) {
            return;
        }
        static_bound_.store(true, std::memory_order_release);
    }

    if (list_count_.load(std::memory_order_acquire) != nullptr &&
        list_item_.load(std::memory_order_acquire) != nullptr) {
        return;
    }
    const ClassRef klass = list_class_.load(std::memory_order_acquire);
    if (klass == nullptr || !game.IsPrepared(klass)) {
        return;
    }

    MethodRef count = nullptr;
    MethodRef item = nullptr;
    for (const auto& method : game.Methods(klass)) {
        if (method.name == "get_Count" && method.return_type == kInt32Type &&
            method.parameter_types.empty()) {
            count = method.reference;
        } else if (method.name == "get_Item" && method.parameter_types.size() == 1 &&
                   method.parameter_types.front() == kInt32Type) {
            // This is the closed List<ShaderProperties> class obtained from the
            // live library. IL2CPP still describes its generic method as
            // returning T on some builds, so requiring the concrete return
            // spelling keeps a valid get_Item permanently unbound.
            item = method.reference;
        }
    }
    if (count == nullptr || item == nullptr) {
        return;
    }
    list_count_.store(count, std::memory_order_release);
    list_item_.store(item, std::memory_order_release);
}

std::optional<std::string> ArcaneStyle::IdOf(const Il2CppRuntime& game,
                                             void* properties) const {
    if (properties == nullptr) {
        return std::string{};
    }
    void* id = nullptr;
    if (!ReadField(properties, properties_id_at_, id)) {
        return std::nullopt;
    }
    if (id == nullptr) {
        return std::string{};
    }
    return game.StringValue(id);
}

void* ArcaneStyle::Find(const Il2CppRuntime& game, void* manager, std::string_view id) {
    using GetShaderEffects = void* (*)(void*, void*);
    using GetLibrary = void* (*)(void*, void*);

    void* const effects = reinterpret_cast<GetShaderEffects>(get_shader_effects_)(manager, nullptr);
    if (effects == nullptr) {
        return nullptr;
    }
    void* const library = reinterpret_cast<GetLibrary>(get_library_)(effects, nullptr);
    if (library == nullptr) {
        return nullptr;
    }
    void* items = nullptr;
    if (!ReadField(library, library_items_at_, items) || items == nullptr) {
        return nullptr;
    }

    if (const auto klass = game.ClassOf(items); klass.has_value()) {
        list_class_.store(*klass, std::memory_order_release);
    }
    const MethodRef count_method = list_count_.load(std::memory_order_acquire);
    const MethodRef item_method = list_item_.load(std::memory_order_acquire);
    if (count_method == nullptr || item_method == nullptr) {
        return nullptr;
    }

    const auto count = game.InvokeInt32(count_method, items, nullptr);
    if (!count.has_value() || *count < 0 || *count > kMaxLibraryItems) {
        return nullptr;
    }
    for (std::int32_t index = 0; index < *count; ++index) {
        void* arguments[]{&index};
        void* properties = game.InvokeObject(item_method, items, arguments);
        const auto candidate = IdOf(game, properties);
        if (candidate.has_value() && *candidate == id) {
            return properties;
        }
    }
    return nullptr;
}

bool ArcaneStyle::Apply(const Il2CppRuntime& game, const PlayerRoute& route,
                        std::string_view wanted) {
    if (!static_bound_.load(std::memory_order_acquire)) {
        return false;
    }
    void* const player = FindPlayer(game, route);
    if (player == nullptr) {
        return false;
    }
    void* current_properties = nullptr;
    if (!ReadField(player, player_properties_at_, current_properties)) {
        return false;
    }
    const auto current = IdOf(game, current_properties);
    if (!current.has_value()) {
        return false;
    }

    using SetPlayerProperties = void (*)(void*, void*, void*);

    if (wanted.empty()) {
        if (applied_id_.empty()) {
            return false;
        }
        // The game replaced our value itself, usually while rebuilding the map.
        // In that case its new value wins and there is nothing of ours to undo.
        if (*current != applied_id_) {
            Forget();
            return false;
        }

        void* original = nullptr;
        if (!original_id_.empty()) {
            void* const manager = game.ReadStaticReference(route.singleton);
            original = manager == nullptr ? nullptr : Find(game, manager, original_id_);
            if (original == nullptr) {
                return false;
            }
        }
        reinterpret_cast<SetPlayerProperties>(set_player_properties_)(player, original, nullptr);
        Forget();
        return true;
    }

    if (applied_id_.empty() || *current != applied_id_) {
        original_id_ = *current;
    } else if (*current == wanted) {
        return false;
    }

    void* const manager = game.ReadStaticReference(route.singleton);
    void* const properties = manager == nullptr ? nullptr : Find(game, manager, wanted);
    if (properties == nullptr) {
        return false;
    }
    reinterpret_cast<SetPlayerProperties>(set_player_properties_)(player, properties, nullptr);
    applied_id_.assign(wanted);
    return true;
}

void ArcaneStyle::Forget() noexcept {
    original_id_.clear();
    applied_id_.clear();
}

}  // namespace brownie::game
