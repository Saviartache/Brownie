#include "app/ScenePatches.h"

#include <array>

#include "game/SceneFields.h"

namespace brownie::app {
namespace {

/// The panel the local player's own bars are drawn in, and the way down to the
/// one node that is the health bar's fill.
///
/// Scene node names, so this is how they are spelled in the game's own
/// hierarchy — trailing space and all. Nothing here is obfuscated and nothing
/// here can be recovered by shape: a scene object has a name and no type, so a
/// build that renames one of these makes the tint go quiet, which is the right
/// outcome for a change nobody has looked at yet.
constexpr const char* kPlayerPanel = "Player_Details_GUI";
constexpr std::array<const char*, 5> kFillPath{
    "Player Stats Container", "Player Stats ", "HP Container", "Fill Area", "Fill",
};

}  // namespace

void ScenePatches::Want(const ScenePatchWants& wants) noexcept {
    tint_wanted_.store(wants.health_bar_tint, std::memory_order_relaxed);
    hitbox_wanted_.store(wants.no_hitbox, std::memory_order_relaxed);

    // Compared packed, which is the form the detour reads: two colours that
    // differ by less than the game can render are the same colour, and
    // repainting for one would be a call into the game on every frame of a drag.
    const std::uint32_t asked = game::PackColour(wants.tint_colour);
    if (asked == colour_) {
        return;
    }
    colour_ = asked;
    tint_.SetColour(wants.tint_colour);
    // The detour will use it on the game's next paint of that element, which
    // for a bar nobody is damaging is never. `Apply` shows it instead.
    repaint_ = true;
}

void ScenePatches::BindClasses(const game::Il2CppRuntime& game, const game::OffsetTable& table) {
    if (image_class_.load(std::memory_order_relaxed) == nullptr) {
        if (const auto found = game::ResolveClass(game, game::ImageClass()); found.ok()) {
            image_class_.store(found.value().first, std::memory_order_release);
        }
    }

    if (!text_.bound()) {
        // Two field offsets and no class: the walk starts from the local player
        // pointer rather than from the scene. Bound on its own so that a build
        // which renames either leaves the collision write working.
        const auto handler_at = table.FieldOffset(game::kMapObjectViewHandler);
        const auto manager_at = table.FieldOffset(game::kViewHandlerUiManager);
        if (handler_at.has_value() && manager_at.has_value()) {
            text_.Bind(*handler_at, *manager_at);
        }
    }

    if (collision_.bound()) {
        return;
    }
    const auto handler = game::ResolveClass(game, game::ViewHandlerClass());
    const auto properties = game::ResolveClass(game, game::ObjectPropertiesClass());
    if (!handler.ok() || !properties.ok()) {
        return;
    }
    const auto entity_at = table.FieldOffset(game::kViewHandlerEntity);
    const auto is_player_at = table.FieldOffset(game::kPropertiesIsPlayer);
    const auto collision_at = table.FieldOffset(game::kPropertiesCollisionRadius);
    if (!entity_at.has_value() || !is_player_at.has_value() || !collision_at.has_value()) {
        return;
    }

    // The type name comes from the class the runtime just handed over rather
    // than from a literal: a field's declared type comes back fully qualified,
    // so a bare "ObjectProperties" would never match one.
    collision_.Bind(handler.value().first, game.ClassName(properties.value().first), *entity_at,
                    *is_player_at, *collision_at);
}

void ScenePatches::AdvanceSetup(const game::Il2CppRuntime& game, const game::OffsetTable& table) {
    if (released_.load(std::memory_order_acquire)) {
        return;
    }

    scene_.Bind(game, table);
    BindClasses(game, table);

    // **The detour goes in only once somebody has asked for the tint.** Unlike
    // a resolved offset, which costs nothing until something reads it, this one
    // is in the way of every coloured element the game paints — and it is never
    // taken out again, because removing a hook suspends every thread in the
    // game and a switch the operator may flick twice is not worth that. With
    // nothing watched it forwards each call unchanged.
    if (tint_wanted_.load(std::memory_order_relaxed) && !tint_.installed()) {
        (void)tint_.Install(table.MethodAddress(game::kGraphicSetColor).value_or(nullptr));
    }

    // **These go in whether or not anybody has asked for anything**, which is
    // the opposite of the rule above and follows from what they are for: they
    // do not change the calls they stand in front of, they read them — and what
    // they read is the only way to learn the style the game draws with. A
    // detour that waited for the first message would have nothing to read when
    // it arrived. Both forward every call unchanged.
    if (!text_.installed()) {
        (void)text_.Install(table.MethodAddress(game::kShowFloatingText).value_or(nullptr),
                            table.MethodAddress(game::kShowFloatingNumber).value_or(nullptr));
    }

    // Last, and with a release: a pass that sees the runtime sees everything
    // bound above it.
    game_.store(&game, std::memory_order_release);
}

void ScenePatches::TrackHealthBar() {
    game::ClassRef klass = image_class_.load(std::memory_order_acquire);
    if (klass == nullptr || !tint_.installed()) {
        return;
    }

    void* const fill = scene_.Descend(scene_.TransformOf(scene_.FindObject(kPlayerPanel)),
                                      {kFillPath.data(), kFillPath.size()});
    void* const element = scene_.ComponentOf(scene_.GameObjectOf(fill), klass);
    if (element == nullptr) {
        // No panel right now — the login screen, a realm change, a rebuilt
        // interface. Whatever was being tinted no longer exists, and holding
        // its address would mean substituting a colour for whatever the
        // allocator puts there next.
        tint_.Forget();
        return;
    }
    if (element == tint_.watched()) {
        return;
    }

    tint_.Watch(element);
    // Painted now rather than waited for: the game sets this colour when the
    // player's health changes, so a bar found while standing still would stay
    // untinted for as long as nothing happened.
    tint_.Paint();
}

void ScenePatches::BindPlayer(const game::PlayerRoute& route) noexcept {
    if (route_ready_.load(std::memory_order_relaxed)) {
        return;
    }
    route_ = route;
    // Released after the route is in place, so a pass that sees the flag sees
    // every field of it.
    route_ready_.store(true, std::memory_order_release);
}

void ScenePatches::Apply(std::uint64_t now_ms) {
    if (released_.load(std::memory_order_acquire)) {
        return;
    }
    const auto* runtime = game_.load(std::memory_order_acquire);
    if (runtime == nullptr || !scene_.bound()) {
        return;
    }

    const bool tint = tint_wanted_.load(std::memory_order_relaxed);
    const bool hitbox = hitbox_wanted_.load(std::memory_order_relaxed);
    if (!tint) {
        // Switched off. The bar goes back to the game's own colour the next
        // time the game paints it, which is the next time it changes.
        tint_.Forget();
    }
    // A message waiting is its own reason to walk the scene, and it does not go
    // through the cadence: a counter that ticks once a second and is drawn up to
    // half a second late reads as a counter that skips.
    const bool text = text_.pending() && text_.installed() &&
                      route_ready_.load(std::memory_order_acquire);
    if (!tint && !hitbox && !text) {
        return;
    }
    // Asked only when one of the two switches wants it, because asking advances
    // it — a frame that walked the scene for a message would otherwise consume
    // the tick the switches were waiting for.
    const bool due = (tint || hitbox) && pass_.Due(now_ms);
    // A colour that has just changed is shown now rather than on the next pass:
    // half a second between a picker moving and the bar following it is long
    // enough to be read as the picker not working.
    const bool repaint = tint && repaint_;
    if (!due && !repaint && !text) {
        return;
    }

    // **A thread that calls into IL2CPP must be known to its collector.** This
    // is the game's own render thread and is attached already — `PlayerMover`
    // relies on exactly that — so this costs one comparison and detaches
    // nothing. It is here because the pass below *allocates* managed objects,
    // strings and types, which is the case where being wrong about that is not
    // survivable. Twice a second, on a path that is about to walk the scene.
    const game::ThreadScope scope{runtime->api(), runtime->domain()};
    if (!scope.attached()) {
        return;
    }

    if (tint && due) {
        TrackHealthBar();
    }
    if (repaint) {
        // Unconditionally, even where `TrackHealthBar` has just painted a newly
        // found element: it paints only what it did not have before, so this is
        // the path that answers a colour changed on a bar already watched. One
        // extra call into the game, on the frame a picker moved.
        tint_.Paint();
        repaint_ = false;
    }
    if (hitbox && due) {
        (void)collision_.Apply(*runtime, scene_);
    }
    if (text) {
        // From the player pointer, not from the scene — see `FloatingText.h`.
        // Located here rather than kept, because it is freed between realms and
        // this pass is the only thing that dereferences it.
        (void)text_.Apply(*runtime, game::FindPlayer(*runtime, route_));
    }
}

void ScenePatches::Release() noexcept {
    released_.store(true, std::memory_order_release);
    tint_.Forget();
}

}  // namespace brownie::app
