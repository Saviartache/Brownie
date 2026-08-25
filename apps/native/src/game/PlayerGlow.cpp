#include "game/PlayerGlow.h"

#include <array>
#include <cstring>
#include <span>

#include "game/GlowFields.h"
#include "game/PlayerFields.h"

namespace brownie::game {
namespace {

/// What the game puts in the flag for "this character does not glow".
///
/// Every other value means it does, and none of them says anything about the
/// colour — the client compares the field with this one number and nothing
/// else. So switching the glow on is writing anything but this, and `1` is
/// simply the least surprising choice of anything.
constexpr std::int32_t kNotGlowing = -1;
constexpr std::int32_t kGlowing = 1;

using SetGlow = void (*)(void*, std::int32_t, void*);

[[nodiscard]] bool TakeField(const OffsetTable& table, std::string_view key,
                             std::uint32_t& out) noexcept {
    const auto value = table.FieldOffset(key);
    if (!value.has_value()) {
        return false;
    }
    out = *value;
    return true;
}

[[nodiscard]] Il2CppRuntime::StaticFieldRef FindStyle(const Il2CppRuntime& game,
                                                      const ClassQuery& query,
                                                      std::string_view field_name) {
    const auto klass = ResolveClass(game, query);
    if (!klass.ok()) {
        return nullptr;
    }
    return game.FindStaticField(klass.value().first, field_name).value_or(nullptr);
}

}  // namespace

void PlayerGlow::Bind(const Il2CppRuntime& game, const OffsetTable& table) {
    if (bound_.load(std::memory_order_acquire)) {
        return;
    }

    std::uint32_t glow_at = 0;
    std::uint32_t aura_colour_at = 0;
    std::uint32_t boxed_outline_colour_at = 0;
    if (!TakeField(table, kPlayerGlow, glow_at) ||
        !TakeField(table, kGlowStyleColour, aura_colour_at) ||
        !TakeField(table, kOutlineStyleColour, boxed_outline_colour_at)) {
        return;
    }
    void* const set_glow = table.MethodAddress(kSetPlayerGlow).value_or(nullptr);
    if (set_glow == nullptr) {
        return;
    }

    const auto aura = FindStyle(game, GlowStyleClass(), GlowStyleStaticName());
    const auto outline = FindStyle(game, OutlineStyleClass(), OutlineStyleStaticName());
    if (aura == nullptr || outline == nullptr) {
        return;
    }

    // The outline style is a struct, so the offset above is into a *boxed* one
    // and overshoots the value by whatever the box carries in front of it.
    const auto layout = game.StaticValueLayout(outline);
    if (!layout.has_value() || layout->size > kMaxStyleBytes ||
        boxed_outline_colour_at < layout->header) {
        return;
    }
    const std::uint32_t outline_colour_at = boxed_outline_colour_at - layout->header;
    if (outline_colour_at + sizeof(UiColor) > layout->size) {
        return;
    }

    glow_at_ = glow_at;
    set_glow_ = set_glow;
    aura_style_ = aura;
    outline_style_ = outline;
    aura_colour_at_ = aura_colour_at;
    outline_colour_at_ = outline_colour_at;
    outline_bytes_ = layout->size;
    bound_.store(true, std::memory_order_release);
}

bool PlayerGlow::Apply(const Il2CppRuntime& game, const PlayerRoute& route,
                       std::optional<UiColor> wanted) {
    if (!bound_.load(std::memory_order_acquire)) {
        return false;
    }
    void* const player = FindPlayer(game, route);
    std::int32_t current = 0;
    if (player == nullptr || !ReadField(player, glow_at_, current)) {
        return false;
    }

    if (!wanted.has_value()) {
        if (!holding()) {
            return false;
        }
        // The colour first: putting the flag back is what stops the glow being
        // drawn, and repainting a style nothing is using is the cheaper order
        // to be interrupted in.
        const bool repainted = RestoreColour(game);
        const bool doused = RestoreFlag(player, current);
        // Putting the flag back rebuilds on its own. A glow this module did not
        // light — one the server gave this character — is still drawn in our
        // colour until something asks for the original back.
        if (repainted && !doused) {
            Rebuild(player, current);
        }
        return true;
    }

    const bool painted = HoldColour(game, *wanted);
    const bool lit = HoldFlag(player, current);
    // Lighting the glow is itself a rebuild, so only a repaint that found it
    // already lit has to ask for one.
    if (painted && !lit) {
        Rebuild(player, current);
    }
    return painted || lit;
}

void PlayerGlow::Rebuild(void* player, std::int32_t current) const {
    // Only ever with the value that is already there: this is asked for what
    // the setter does *after* the write, and a different value here would be a
    // second claim on a flag somebody else may own.
    reinterpret_cast<SetGlow>(set_glow_)(player, current, nullptr);
}

bool PlayerGlow::HoldFlag(void* player, std::int32_t current) {
    if (current != kNotGlowing) {
        // Already glowing, and the style is what decides the colour — so there
        // is nothing to write, whether the glow is ours or one the server gave
        // this character.
        if (applied_flag_.has_value() && current != *applied_flag_) {
            // Not ours any more: the game put a value of its own here, and its
            // value wins. Forgetting is what stops a later restore writing our
            // idea of "before" over it.
            applied_flag_.reset();
            original_flag_.reset();
        }
        return false;
    }

    original_flag_ = current;
    reinterpret_cast<SetGlow>(set_glow_)(player, kGlowing, nullptr);
    applied_flag_ = kGlowing;
    return true;
}

bool PlayerGlow::RestoreFlag(void* player, std::int32_t current) {
    const bool ours =
        applied_flag_.has_value() && original_flag_.has_value() && current == *applied_flag_;
    if (ours) {
        reinterpret_cast<SetGlow>(set_glow_)(player, *original_flag_, nullptr);
    }
    applied_flag_.reset();
    original_flag_.reset();
    return ours;
}

bool PlayerGlow::HoldColour(const Il2CppRuntime& game, const UiColor& colour) {
    bool changed = false;

    // The aura is an object, so its colour is a field to write.
    if (void* const aura = game.ReadStaticReference(aura_style_); aura != nullptr) {
        UiColor current{};
        if (ReadField(aura, aura_colour_at_, current) && !(current == colour)) {
            // **Captured on the first write and not revised after.** Unlike a
            // player's own fields, which the packet stream rewrites every tick,
            // a style is built once in a static constructor and never touched
            // again — so "what was here before we wrote" cannot go stale, and
            // anything else that changed it is a second writer we would not
            // help by leaving our colour behind.
            if (!original_aura_.has_value()) {
                original_aura_ = current;
            }
            changed = WriteField(aura, aura_colour_at_, colour) || changed;
        }
    }

    // The outline is a struct in the class's own storage, with no object to
    // reach through: the whole value is read, the colour replaced in the copy,
    // and the copy put back — which is what keeps its alpha, its strength and
    // its priority.
    std::array<std::byte, kMaxStyleBytes> style{};
    const std::span<std::byte> value{style.data(), outline_bytes_};
    if (game.ReadStaticValue(outline_style_, value)) {
        UiColor current{};
        std::memcpy(&current, style.data() + outline_colour_at_, sizeof(current));
        if (!(current == colour)) {
            if (!original_outline_.has_value()) {
                original_outline_ = current;
            }
            std::memcpy(style.data() + outline_colour_at_, &colour, sizeof(colour));
            changed = game.WriteStaticValue(outline_style_, value) || changed;
        }
    }
    return changed;
}

bool PlayerGlow::RestoreColour(const Il2CppRuntime& game) {
    bool changed = false;

    if (original_aura_.has_value()) {
        if (void* const aura = game.ReadStaticReference(aura_style_); aura != nullptr) {
            changed = WriteField(aura, aura_colour_at_, *original_aura_) || changed;
        }
        original_aura_.reset();
    }

    if (original_outline_.has_value()) {
        std::array<std::byte, kMaxStyleBytes> style{};
        const std::span<std::byte> value{style.data(), outline_bytes_};
        if (game.ReadStaticValue(outline_style_, value)) {
            std::memcpy(style.data() + outline_colour_at_, &original_outline_.value(),
                        sizeof(UiColor));
            changed = game.WriteStaticValue(outline_style_, value) || changed;
        }
        original_outline_.reset();
    }
    return changed;
}

}  // namespace brownie::game
