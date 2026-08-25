#include "app/GameBinding.h"

#include "game/GlowFields.h"
#include "game/MapFields.h"
#include "game/PlayerFields.h"
#include "game/ProjectileFields.h"
#include "game/SceneFields.h"

namespace brownie::app {

void GameBinding::TryBind() {
    if (game_ != nullptr) {
        return;
    }
    // **The gate that was missing.** The first live run bound one second into
    // startup, while `il2cpp_init` was still running on the game's main thread,
    // and crashed it there. A non-null domain is not a started runtime; this is.
    if (!ready_.ready()) {
        return;
    }
    if (auto runtime = game::Il2CppRuntime::Attach("Assembly-CSharp"); runtime.ok()) {
        game_ = std::move(runtime).value();
        // Constructed here rather than at startup: the table holds a pointer to
        // the metadata source, and there is no source until this succeeds.
        offsets_.emplace(*game_);
    }
}

bool GameBinding::TryResolve() {
    if (!offsets_.has_value()) {
        return false;
    }
    // Every turn of the loop until they are all found, which is what makes this
    // self-healing rather than a one-shot at startup. The class holding the
    // player's stats does not exist until the game has made a player, so an
    // empty report during the menu is the ordinary case and not a failure.
    // Both are asked every turn: a field that is still missing says nothing
    // about whether a method has appeared.
    const bool fields = game::ResolvePlayerFields(*offsets_) != 0;
    const bool methods = game::ResolvePlayerMethods(*offsets_) != 0;
    // The scene's, asked for on the same turns and under the same rules.
    // Resolving is a read: nothing here goes into the game until a feature is
    // switched on, and the report is worth having either way — an operator
    // needs to see that `Graphic::set_color` moved *before* switching on the
    // feature that detours it.
    const bool scene_fields = game::ResolveSceneFields(*offsets_) != 0;
    const bool scene_methods = game::ResolveSceneMethods(*offsets_) != 0;
    // The projectile's, which appear last of all: IL2CPP does not build a
    // projectile class until the game needs one, and it does not need one until
    // something shoots. An empty report for these before the first shot is the
    // ordinary case, not a rename.
    const bool shot_fields = game::ResolveProjectileFields(*offsets_) != 0;
    const bool shot_methods = game::ResolveProjectileMethods(*offsets_) != 0;
    // The glow styles, which appear once the game has drawn a character that
    // has one to pick — earlier than a projectile and later than the player.
    const bool glow_fields = game::ResolveGlowFields(*offsets_) != 0;
    // **The walkability predicates are not resolved here**, unlike everything
    // above. Finding them enumerates a class rather than asking it for one
    // named member, and nothing needs them until player noclip is switched on —
    // so they are found on demand, once, by `WalkabilityPredicates`.
    return fields || methods || scene_fields || scene_methods || shot_fields || shot_methods ||
           glow_fields;
}

std::span<const game::OffsetTable::Entry> GameBinding::offsets() const noexcept {
    if (!offsets_.has_value()) {
        return {};
    }
    return offsets_->entries();
}

std::optional<void*> GameBinding::MethodAddress(std::string_view key) const {
    if (!offsets_.has_value()) {
        return std::nullopt;
    }
    return offsets_->MethodAddress(key);
}

std::optional<std::uint32_t> GameBinding::FieldOffset(std::string_view key) const {
    if (!offsets_.has_value()) {
        return std::nullopt;
    }
    return offsets_->FieldOffset(key);
}

const game::OffsetTable* GameBinding::table() const noexcept {
    return offsets_.has_value() ? &*offsets_ : nullptr;
}

std::optional<game::PlayerRoute> GameBinding::Route() const { return player_.Route(); }

std::span<const game::WalkabilityPredicate> GameBinding::WalkabilityPredicates() {
    if (walkability_.empty() && game_ != nullptr && offsets_.has_value()) {
        walkability_ = game::ResolveWalkabilityPredicates(*game_, *offsets_);
    }
    return walkability_;
}

bool GameBinding::ReadPlayer(const overlay::WorldStatus& world) {
    overlay::MemoryReading reading;
    if (game_ == nullptr || !offsets_.has_value()) {
        reading.trouble = "the game is not bound yet";
    } else {
        // What the server said, handed over so the reader can check itself
        // against it — and work out where the anti-tamper moved the stat block.
        const game::KnownFromServer known{world.hp, world.max_hp, world.defense_known,
                                          world.defense};
        const auto read = player_.Read(*game_, *offsets_, known);
        reading.known = read.known;
        reading.hp = read.hp;
        reading.max_hp = read.max_hp;
        reading.defense_known = read.defense_known;
        reading.defense = read.defense;
        reading.x = read.x;
        reading.y = read.y;
        reading.calibrated = player_.shift().has_value();
        reading.shift = player_.shift().value_or(0);
        reading.trouble = player_.trouble();
    }

    if (reading.known == reading_.known && reading.hp == reading_.hp &&
        reading.max_hp == reading_.max_hp && reading.defense == reading_.defense &&
        reading.defense_known == reading_.defense_known && reading.x == reading_.x &&
        reading.y == reading_.y && reading.calibrated == reading_.calibrated &&
        reading.shift == reading_.shift && reading.trouble == reading_.trouble) {
        return false;
    }
    reading_ = std::move(reading);
    return true;
}

std::vector<std::byte> GameBinding::SnapshotPlayer() {
    if (game_ == nullptr || !offsets_.has_value()) {
        return {};
    }
    return player_.Snapshot(*game_, *offsets_);
}

}  // namespace brownie::app
