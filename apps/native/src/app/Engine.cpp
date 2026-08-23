#include "app/Engine.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>

#include <Windows.h>

#include "app/Inspection.h"
#include "core/Clock.h"
#include "game/FloatingText.h"
#include "game/MapFields.h"
#include "game/PlayerFields.h"
#include "game/ProjectileFields.h"
#include "game/SceneFields.h"
#include "ipc/SessionKey.h"
#include "overlay/WorldMarkers.h"
#include "overlay/WorldRecord.h"

namespace brownie::app {
namespace {

/// The longest a poll may wait.
///
/// A ceiling, not the interval: what a poll actually waits for is whichever of
/// the loop's jobs is due soonest — see `Cadence`. The wait is cancellable, so
/// this bounds nothing about how promptly a stop is noticed; it is the point
/// past which waiting longer stops being worth the arithmetic.
constexpr std::uint32_t kPollTimeoutMs = 500;

/// The record kind an inspector answer travels back under. The runtime logs
/// these; `docs/ipc.md` calls unknown kinds ignorable, so an older runtime
/// simply says nothing rather than breaking.
constexpr std::string_view kInspectAction = "inspect";

/// A chunk of the class dump, and the record that closes it. Kept apart from
/// `inspect` because these are for a file, not for the log: a few thousand
/// names in a console is not an answer to anything.
constexpr std::string_view kDumpChunkAction = "dump";
constexpr std::string_view kDumpEndAction = "dump-end";

/// The place under the cursor, in tiles. See `Engine::SendCursorPoint`.
///
/// **Not `cursor`, which is what this used to be called when it carried an
/// angle.** A runtime of that vintage would read a coordinate as milliradians
/// and aim somewhere arbitrary; under a name it does not know, it ignores the
/// record instead — which is what `docs/ipc.md` promises about unknown kinds.
constexpr std::string_view kCursorPointAction = "cursor-at";

/// The walk-to-cursor chord going down and coming up. See
/// `Engine::ObserveCursorWalk`.
constexpr std::string_view kCursorWalkAction = "unstick";

/// Which way the player is walking under their own power. See
/// `Engine::ObserveSteer`.
constexpr std::string_view kSteerAction = "steer";

/// Whether the dodge picture is wanted. See `Engine::PublishDodgeView`.
constexpr std::string_view kDodgeViewAction = "dodge-view";

/// A unit vector as thousandths, which fits either component in four digits and
/// needs no decoder on either side — the same reason a position travels as
/// hundredths of a tile.
constexpr float kMilliUnits = 1000.0F;

/// The furthest from the player a cursor may be said to point.
///
/// A screen is a dozen tiles across, so anything past this is not a place
/// somebody clicked — it is a camera answering nonsense, or a basis solved from
/// a projection that had already been torn down. Dropped rather than clamped: a
/// clamped nonsense reading is a walk in a direction nobody chose.
constexpr float kMaxCursorWalkTiles = 30.0F;

/// Whether a window of this process is the one being typed into.
///
/// `GetAsyncKeyState` reports the physical keyboard whatever has focus, so this
/// is what keeps every chord below the *game's* chord rather than a key the
/// player pressed in another application.
[[nodiscard]] bool GameHasFocus() noexcept {
    DWORD pid = 0;
    (void)::GetWindowThreadProcessId(::GetForegroundWindow(), &pid);
    return pid == ::GetCurrentProcessId();
}

/// Whether Ctrl and the middle button are both down, in a window of this
/// process.
///
/// **Polled rather than taken from the window procedure**, which is what the
/// module does with input generally. A chord is a state, not an event: what the
/// runtime needs to know is whether it is held *now*, and asking once a frame
/// answers that in one place without a message filter that has to reconstruct
/// it from four kinds of message and get focus loss right as well.
///
/// **The middle button, which the game does nothing with**, so holding it fires
/// nothing and costs nothing. Where it points is a separate record and does not
/// depend on the player shooting — see `Engine::SendCursorPoint`.
[[nodiscard]] bool CursorWalkChordHeld() noexcept {
    constexpr int kDown = 0x8000;
    if ((::GetAsyncKeyState(VK_CONTROL) & kDown) == 0) {
        return false;
    }
    if ((::GetAsyncKeyState(VK_MBUTTON) & kDown) == 0) {
        return false;
    }
    return GameHasFocus();
}

/// Which way the movement keys are pointing, in the screen's own terms.
///
/// **Screen terms, not world ones, because the keys have no world meaning on
/// their own.** The game maps movement through the camera, so which world
/// direction `W` is depends on how far the camera has been rotated. What the
/// keys unambiguously say is "towards the top of the screen"; turning that into
/// tiles is what the projection is for — see `Engine::ObserveSteer`.
///
/// Polled, foreground-gated, and read from the OS rather than from the game's
/// own "is moving" field. The reference implementation tried the field and
/// documented what happened: the planner's own movement sets it, so the planner
/// sees itself steering, stops, sees the field clear, resumes — a thirty-hertz
/// stutter with no cause visible anywhere in the planner.
[[nodiscard]] bool MovementKeysHeld(float& right, float& up) noexcept {
    constexpr int kDown = 0x8000;
    const auto down = [](int key) { return (::GetAsyncKeyState(key) & kDown) != 0; };

    right = 0.0F;
    up = 0.0F;
    if (!GameHasFocus()) {
        return false;
    }
    if (down('W') || down(VK_UP)) up += 1.0F;
    if (down('S') || down(VK_DOWN)) up -= 1.0F;
    if (down('D') || down(VK_RIGHT)) right += 1.0F;
    if (down('A') || down(VK_LEFT)) right -= 1.0F;
    // Opposite keys held together are the player asking to stand still, which
    // the game obeys — so this must report it as standing still and not as a
    // direction of length zero that something downstream normalises.
    return right != 0.0F || up != 0.0F;
}

/// The feature keys this module listens for, and the value that turns one on.
///
/// `true` rather than `1` or `on`, because that is what a boolean handed to the
/// runtime's `setFeature` arrives as — the wire carries JSON and this side reads
/// the token. See `Engine::AcceptFeature`.
constexpr std::string_view kPlayerNoclipFeature = "player.noclip";
constexpr std::string_view kCursorTrackFeature = "cursor.track";
constexpr std::string_view kColliderFeature = "player.collider";
constexpr std::string_view kColliderMultiplierFeature = "player.colliderMultiplier";
constexpr std::string_view kTintFeature = "scene.healthBarTint";
constexpr std::string_view kTintColourFeature = "scene.healthBarTintColour";
constexpr std::string_view kShotNoclipFeature = "shots.noclip";
constexpr std::string_view kFeatureOn = "true";

/// The number a feature value carries, or nothing when it does not carry one.
///
/// **Copied before it is parsed, because a view off the wire has no
/// terminator** and `strtof` needs one. The buffer is longer than any number
/// this reads and shorter than anything worth scanning: a value that does not
/// fit is a value that is not a number.
///
/// A trailing character is a refusal rather than a prefix accepted — "0.5x" is
/// not 0.5 — and so is anything the parse could not make finite.
[[nodiscard]] std::optional<float> FeatureNumber(std::string_view value) noexcept {
    constexpr std::size_t kMaxDigits = 31;
    if (value.empty() || value.size() > kMaxDigits) {
        return std::nullopt;
    }
    std::array<char, kMaxDigits + 1> text{};
    std::memcpy(text.data(), value.data(), value.size());

    char* end = nullptr;
    const float parsed = std::strtof(text.data(), &end);
    if (end != text.data() + value.size() || !std::isfinite(parsed)) {
        return std::nullopt;
    }
    return parsed;
}

/// The colour a feature value carries as `0xRRGGBBAA`, or nothing when it does
/// not carry one.
///
/// `#rrggbbaa` is the one spelling a claimant sends, so that is the one this
/// reads. Everything else is refused rather than guessed at from a short form:
/// a colour read as black because a digit was missing looks like a feature that
/// worked, which is the opposite of what a sign is for.
[[nodiscard]] std::optional<std::uint32_t> FeatureColour(std::string_view value) noexcept {
    constexpr std::size_t kDigits = 8;
    if (value.size() != kDigits + 1 || value.front() != '#') {
        return std::nullopt;
    }
    std::uint32_t packed = 0;
    for (const char digit : value.substr(1)) {
        const std::uint32_t nibble = digit >= '0' && digit <= '9'   ? std::uint32_t(digit - '0')
                                     : digit >= 'a' && digit <= 'f' ? std::uint32_t(digit - 'a' + 10)
                                     : digit >= 'A' && digit <= 'F' ? std::uint32_t(digit - 'A' + 10)
                                                                    : 16u;
        if (nibble > 15u) {
            return std::nullopt;
        }
        packed = (packed << 4u) | nibble;
    }
    return packed;
}

/// How much of a chunk to fill before sending it.
///
/// Well under the frame's 256 KB cap, and large enough that a whole image goes
/// in a few hundred frames rather than a few thousand. One name per record
/// would be the same bytes and a hundred times the round trips.
constexpr std::size_t kDumpChunkBytes = 48u * 1024u;

}  // namespace

Status Engine::Start() {
    if (running_.load(std::memory_order_acquire)) {
        return Error{ErrorCode::kInvalidArgument, "the engine is already running"};
    }
    stopping_.store(false, std::memory_order_release);
    running_.store(true, std::memory_order_release);

    // MinHook comes up first: the overlay is not the only thing that needs it —
    // the IL2CPP readiness watcher hooks on its own account.
    if (auto hooks = hooks::HookEngine::Create(); hooks.ok()) {
        hook_engine_.emplace(std::move(hooks).value());
    }
    if (hook_engine_.has_value()) {
        // A failure here is not the engine's: the link is the part that has to
        // work, and refusing to start because a machine has no usable Direct3D
        // would take away what works to protect what does not.
        if (auto installed = overlay_.Install([this] { DrawFrame(); }); !installed.ok()) {
            (void)installed;
        }
    }

    session_.SetHandlers({
        [this](std::string_view key, std::string_view value) { AcceptFeature(key, value); },
        [this](std::string_view record) { AcceptRecord(record); },
    });

    // Published before the thread starts, so the first frame has something to
    // draw rather than an empty window.
    PublishModel();

    thread_ = std::thread{[this] { Run(); }};
    return {};
}

void Engine::Stop() noexcept {
    stopping_.store(true, std::memory_order_release);

    // The overlay goes first: it removes the detour, so no further frame can
    // reach into this object while the rest is being taken apart.
    overlay_.Shutdown();

    // Cancel first, join second. A thread blocked in a read cannot notice a
    // flag, so joining before cancelling is a deadlock — and one that only
    // shows up when the peer happens to be quiet, which is most of the time.
    session_.Disconnect();

    if (thread_.joinable()) {
        thread_.join();
    }
    running_.store(false, std::memory_order_release);
    connected_.store(false, std::memory_order_release);
}

void Engine::AcceptRecord(std::string_view record) {
    // Records arrive on the IPC thread. This only stores — the overlay reads a
    // published snapshot on its own thread, and a handler that drew would be
    // drawing from the wrong one.
    if (overlay::ParseWorldRecord(record, world_)) {
        world_dirty_ = true;
        return;
    }
    if (overlay::ParseWeaponRecord(record, weapon_)) {
        world_dirty_ = true;
        return;
    }
    // Stored, not acted on. Acting means calling into the game, and this is not
    // the thread that may — see `PlayerControl::Apply`.
    if (overlay::MoveCommand move; overlay::ParseMoveRecord(record, move)) {
        control_.MoveTo(MoveTargetFrom(move, NowMs()));
        return;
    }
    if (overlay::AimCommand aim; overlay::ParseAimRecord(record, aim)) {
        control_.AimAt(AimTargetFrom(aim, NowMs()));
        // The detours go in on the setup pass, and the first aim is what asks
        // for them — so waiting out the rest of that pass's interval is half a
        // second of the player's shots going their own way, once per run. This
        // is the same thread the pass runs on, so it happens on the next turn.
        if (!control_.aim_complete()) {
            setup_.Trigger();
        }
        return;
    }
    if (overlay::TextCommand text; overlay::ParseTextRecord(record, text)) {
        // Queued, not shown: showing calls into the game, and this is not the
        // thread that may. The scene pass picks it up on the next frame.
        patches_.ShowText(text.text, game::PackColor32(static_cast<std::uint8_t>(text.red),
                                                      static_cast<std::uint8_t>(text.green),
                                                      static_cast<std::uint8_t>(text.blue)));
        return;
    }
    // Before the plugin mirror, and only because it is cheaper to ask: a set of
    // paths arrives fifty records at a time while the switch is on, and the
    // mirror would look at every one of them.
    if (picture_.Apply(record, NowMs())) {
        return;
    }
    if (controls_.Apply(record)) {
        controls_dirty_ = true;
    }
}

void Engine::AcceptFeature(std::string_view key, std::string_view value) {
    // "true" is what a boolean sent by a plugin arrives as. Anything else is
    // off, which is the safe answer for a switch nobody can see from here.
    //
    // Three of the four keys are *claims that expire*, and all three for the
    // same reason: on renews the lease, off ends it now, so switching the
    // plugin off is immediate and only the ways it can stop *without* saying so
    // wait the lease out. A key this build has never heard of is neither — the
    // runtime replays every key it holds whenever the link comes up.
    //
    // The fourth is not a claim but the number one of the claims applies, and
    // it is stored whether or not that claim is live: it arrives ahead of the
    // claim, and only when it has changed, so a value refused for arriving
    // first would leave the claim acting on the number before it.
    const bool on = value == kFeatureOn;
    const std::uint64_t now = NowMs();

    if (key == kPlayerNoclipFeature) {
        walk_noclip_until_ms_.store(on ? now + kWalkNoclipLeaseMs : 0, std::memory_order_relaxed);
        return;
    }
    if (key == kCursorTrackFeature) {
        cursor_track_until_ms_.store(on ? now + kCursorTrackLeaseMs : 0,
                                     std::memory_order_relaxed);
        return;
    }
    if (key == kColliderFeature) {
        collider_until_ms_.store(on ? now + kColliderLeaseMs : 0, std::memory_order_relaxed);
        return;
    }
    if (key == kColliderMultiplierFeature) {
        // Clamped rather than trusted. The plugin's slider cannot leave this
        // range, but the module is not the plugin's to believe: a value above
        // one is a *larger* collision circle than the game built, which is the
        // one outcome nobody could ask for on purpose.
        const auto parsed = FeatureNumber(value);
        if (parsed.has_value()) {
            collider_multiplier_.store(std::clamp(*parsed, 0.0F, 1.0F), std::memory_order_relaxed);
        }
        return;
    }
    if (key == kTintFeature) {
        tint_until_ms_.store(on ? now + kTintLeaseMs : 0, std::memory_order_relaxed);
        return;
    }
    if (key == kTintColourFeature) {
        // Kept whether or not the claim is live, like the multiplier above and
        // for the same reason: it arrives ahead of the claim. A value that is
        // not a colour is dropped, so the bar keeps the last one that was.
        const auto parsed = FeatureColour(value);
        if (parsed.has_value()) {
            tint_colour_.store(*parsed, std::memory_order_relaxed);
        }
        return;
    }
    if (key == kShotNoclipFeature) {
        shot_noclip_until_ms_.store(on ? now + kShotNoclipLeaseMs : 0, std::memory_order_relaxed);
    }
}

std::uint32_t Engine::PollBudgetMs(std::uint64_t now_ms) const noexcept {
    std::uint64_t budget = setup_.Remaining(now_ms);
    // Only while there is a game to read from: an unbound module has nothing to
    // wake up for, and shortening its wait would buy a reading it cannot take.
    if (binding_.bound()) {
        budget = std::min(budget, read_.Remaining(now_ms));
    }
    // Same rule, and the same reason it is conditional: a loop that woke up
    // twenty times a second to pass on an aim nobody asked for would be paying
    // for a feature that is switched off.
    // Not a job of this loop's but the render thread's: what it queued while
    // somebody was pointing at something waits here to be sent, and a walk that
    // starts a quarter of a second after the mouse moves is a walk nobody can
    // steer with. Only while anything is watching the cursor, so a session
    // using neither the chord nor cursor aim pays nothing for it.
    if (cursor_walk_held_.load(std::memory_order_relaxed) || CursorTrackWanted(now_ms) ||
        steer_held_.load(std::memory_order_relaxed)) {
        budget = std::min<std::uint64_t>(budget, kCursorPollMs);
    }
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(budget, kPollTimeoutMs));
}

void Engine::Run() {
    while (!stopping_.load(std::memory_order_acquire)) {
        Turn();
    }

    session_.Disconnect();
    connected_.store(false, std::memory_order_release);
}

void Engine::Turn() {
    const std::uint64_t now = NowMs();

    // Before anything that touches the game. Once the game has asked to quit,
    // its runtime is being taken apart, and reading a static field through it
    // or drawing into its swap chain is a call into code that is unmaking
    // itself.
    if (quit_.quitting()) {
        LetGo();
    }

    if (setup_.Due(now)) {
        AdvanceSetup();
    }
    // Reading is what a bound game is for, and there is nothing to read from
    // until it is bound — nor once it has started going away.
    if (binding_.bound() && !released_ && read_.Due(now) && binding_.ReadPlayer(world_)) {
        memory_dirty_ = true;
    }
    // Cheap unless something above changed: it compares what it published last
    // and returns.
    PublishModel();

    if (session_.state() == ipc::SessionState::kDisconnected) {
        connected_.store(false, std::memory_order_release);

        // Whatever the overlay is showing belongs to a runtime that is no
        // longer there. Kept until now rather than cleared the instant the link
        // dropped, so a reconnect within one turn of the loop does not blank
        // the window for a frame.
        if (!controls_.plugins().empty()) {
            controls_.Reset();
            controls_dirty_ = true;
        }
        // What was drawn belonged to a runtime that is no longer there, and the
        // next one has not been told the box is ticked.
        picture_.Reset();
        dodge_view_stated_ = false;

        // Read on every attempt, never cached. The runtime mints a fresh secret
        // each run, so a key held from a previous connection would authenticate
        // against a runtime that is no longer there — and the failure would look
        // like a protocol bug rather than a restart.
        const auto secret = ipc::ReadSessionKey(options_.pipe_name);
        if (!secret.ok()) {
            ::Sleep(options_.reconnect_delay_ms);
            return;
        }

        // The game is usually started before the runtime, so failing to connect
        // is the ordinary case and is not worth reporting as an error — it is
        // worth trying again.
        if (auto connected = session_.Connect(options_.pipe_name, secret.value());
            !connected.ok()) {
            ::Sleep(options_.reconnect_delay_ms);
            return;
        }
    }

    // Whether the dodge picture is wanted, said on the turn it changes and again
    // whenever a new runtime has to be told.
    PublishDodgeView();

    // Before the poll, so an interaction waits at most for the loop to come
    // round rather than for the timeout as well.
    HandlePendingActions();

    const auto polled = session_.Poll(PollBudgetMs(NowMs()));
    if (!polled.ok() && polled.error().code() != ErrorCode::kNotReady) {
        // The link is gone. The loop reconnects on its next turn; the runtime
        // replays every feature key when it does, so there is nothing here to
        // remember or restore.
        connected_.store(false, std::memory_order_release);
        return;
    }
    connected_.store(session_.ready(), std::memory_order_release);
}

void Engine::AdvanceSetup() {
    if (released_) {
        // The game is on its way out. Nothing left to look for in it, and
        // everything that could be found is something else to let go of.
        return;
    }

    binding_.Observe();
    TryRedirect();

    binding_.TryBind();
    if (binding_.TryResolve()) {
        offsets_dirty_ = true;
    }

    // The scene features, and the detour that notices the game leaving. Both
    // need the runtime bound and are asked again on every turn until they have
    // everything: IL2CPP registers the engine's own classes when it gets round
    // to them, exactly as it does the game's.
    if (const auto* table = binding_.table(); table != nullptr && binding_.runtime() != nullptr) {
        patches_.AdvanceSetup(*binding_.runtime(), *table);
        // Cheap once it has everything, and asked again until it does: the
        // engine's classes are registered when the runtime gets round to them.
        projection_.Bind(*table);
    }
    if (!quit_.installed()) {
        if (const auto address = binding_.MethodAddress(game::kApplicationQuit)) {
            (void)quit_.Install(*address);
        }
    }

    // Handing the route over is the last step, and it happens once: after this
    // the game's thread can reach the player without touching anything the loop
    // is still working on.
    if (!control_.bound()) {
        if (const auto route = binding_.Route()) {
            control_.Bind(*binding_.runtime(), *route);
            // The same route, and the scene pass needs it for the same reason:
            // the local player is where the game's own floating text is reached
            // from.
            patches_.BindPlayer(*route);
        }
    }

    // Each is bound on its own, so a method that is never found leaves the
    // others working.
    if (!control_.mover_bound()) {
        if (const auto address = binding_.MethodAddress(game::kPlayerMoveTo)) {
            control_.BindMover(*address);
        }
    }

    // **The aim detours go in only once the runtime has asked to aim**, which
    // it does by sending a record — and it only does that while auto-aim is
    // switched on. A detour is a write into the game's own code: unlike a
    // resolved offset, which costs nothing until something reads it, a hook
    // that nobody wanted is still in the way of every shot the player fires.
    //
    // Asked again until both are in place: IL2CPP builds the two classes
    // whenever it gets round to them, rarely on the same turn, and each install
    // is a no-op once its detour is live.
    if (control_.aim_wanted() && !control_.aim_complete()) {
        InstallAimHook();
    }

    // The same argument, and the same shape: the detours go in the first time
    // somebody switches the feature on, and not before. Asked again on every
    // turn until they are in, because the projectile class does not exist until
    // the game has built a projectile — which is until somebody has shot.
    if (shot_noclip_.enabled() && !shot_noclip_.installed()) {
        InstallProjectileNoclip();
    }

    // And again for the walkability predicates, with one difference: the world
    // manager exists as soon as the game builds a realm, so these resolve early
    // and the retry is for the case of switching the feature on at the login
    // screen.
    if (WalkNoclipWanted(NowMs()) && !walk_noclip_.installed()) {
        InstallPlayerNoclip();
    }
}

void Engine::TryRedirect() {
    if (redirect_installed_) {
        return;
    }

    net::ConnectHookOptions redirect;
    redirect.game_port = options_.game_port;

    // The reporter runs on whichever thread the game connects on, and the
    // game's `connect` is blocked behind it — so it does one send and returns.
    // A failed send is dropped rather than retried: the runtime refuses the
    // session it could not place, which is visible, and stalling the game to
    // fix that would be worse than the session being refused.
    auto installed = redirect_.Install(redirect, [this](const std::string& host,
                                                        std::uint16_t port) {
        if (session_.ready()) {
            (void)session_.SendServerTarget(host, port);
        }
    });

    // `ws2_32.dll` may not be loaded this early. Failing is the ordinary case
    // at startup and the loop is the retry; anything else is permanent and
    // there is nothing useful to do about it from here.
    if (installed.ok() || installed.error().code() != ErrorCode::kNotReady) {
        redirect_installed_ = true;
    }
}

void Engine::LetGo() noexcept {
    if (released_) {
        return;
    }
    released_ = true;

    // The scene pass first: it calls into managed code, and the frame that
    // would run it is about to be taken away.
    patches_.Release();

    // Then the overlay, which is what stops frames happening at all. Removing
    // the detour fixes up any thread standing inside the code it replaced, so
    // once this returns nothing of ours is on the game's render path.
    overlay_.Shutdown();

    // And last, once no frame can run: nothing more is written into a map that
    // is being torn down. **After the overlay and not before**, because the
    // switch is read from a frame and written from one — a frame drawn between
    // this and the shutdown would put it straight back, and there would then be
    // no frame left to turn it off again. The detours stay in place: taking one
    // out means suspending every thread in a game that is already quitting, and
    // with this off they forward every call, which is what they do when nobody
    // wants them.
    shot_noclip_.SetEnabled(false);

    // Deliberately not stopped here: the link is the module's own and outlives
    // the game, and the runtime is told the game went away by the connection
    // closing when the process does.
}

void Engine::InstallAimHook() {
    const auto added = control_.InstallAim(
        binding_.MethodAddress(game::kComputeShootAngle).value_or(nullptr),
        binding_.MethodAddress(game::kShootWithAngle).value_or(nullptr));

    // Said out loud, once per detour, into the runtime's log. A hook is the one
    // thing this module does that can take the game down with it, so which
    // methods it went onto is not a detail to leave to a panel somebody may not
    // open — and a game that stops starting is a game whose overlay nobody can
    // read.
    if (added.compute_added) {
        Say("aim hook: detoured " + std::string{game::kComputeShootAngle});
    }
    if (added.shoot_added) {
        Say("aim hook: detoured " + std::string{game::kShootWithAngle});
    }
}

void Engine::InstallProjectileNoclip() {
    game::ProjectileTileRoute route;
    route.active_at = binding_.FieldOffset(game::kShotActive).value_or(0);
    route.tile_at = binding_.FieldOffset(game::kMapObjectTile).value_or(0);
    route.layer_at = binding_.FieldOffset(game::kTileCollisionLayer).value_or(0);

    // Failure is the ordinary answer until the first shot of the session, and
    // the loop is the retry, so it stays out of the runtime's log.
    (void)shot_noclip_.Install(route, binding_.MethodAddress(game::kShotHitsWall).value_or(nullptr),
                               binding_.MethodAddress(game::kShotTileBlocks).value_or(nullptr));
}

void Engine::InstallPlayerNoclip() {
    // Enumerates a class the first time and is kept by the binding, which owns
    // the table the predicates are registered in. Empty is the ordinary answer
    // until the game has built a realm.
    const auto gates = binding_.WalkabilityPredicates();
    if (gates.empty() || !walk_noclip_.Install(gates).ok()) {
        // The loop is the retry, and saying so twice a second would fill the
        // runtime's log with the fact that nobody is in a map yet.
        return;
    }

    // Once, on the turn the detours go in. Which methods a hook went onto
    // belongs in the log for the reason the two above give — and here the names
    // are also the key to the counters the overlay shows, in this order.
    std::string line = "player noclip: detoured";
    for (const auto& gate : gates) {
        line += ' ';
        line += gate.name;
    }
    Say(line);
}

std::optional<Engine::FrameScreen> Engine::MeasureScreen() const {
    if (!projection_.bound()) {
        return std::nullopt;
    }
    HWND window = overlay_.window();
    RECT client{};
    if (window == nullptr || ::GetClientRect(window, &client) == FALSE) {
        return std::nullopt;
    }

    FrameScreen screen;
    // The anchor. Any world point the camera can be asked about would do — every
    // answer is that point plus an offset measured from its own place on the
    // screen — and the player's is the one guaranteed to be on it.
    if (!control_.Locate(screen.player)) {
        return std::nullopt;
    }

    const game::ViewSizes sizes{static_cast<float>(client.right - client.left),
                                static_cast<float>(client.bottom - client.top),
                                static_cast<float>(overlay_.render_width()),
                                static_cast<float>(overlay_.render_height())};
    const auto basis = projection_.Measure(game::WorldPoint{screen.player.x, screen.player.y},
                                           sizes);
    if (!basis.has_value()) {
        return std::nullopt;
    }
    screen.basis = *basis;
    return screen;
}

std::optional<game::WorldPoint> Engine::CursorTarget(const FrameScreen& screen) const {
    HWND window = overlay_.window();
    POINT cursor{};
    if (window == nullptr || ::GetCursorPos(&cursor) == FALSE ||
        ::ScreenToClient(window, &cursor) == FALSE) {
        return std::nullopt;
    }

    const game::WorldPoint point = game::ToWorld(screen.basis, static_cast<float>(cursor.x),
                                                 static_cast<float>(cursor.y));
    if (std::hypot(point.x - screen.player.x, point.y - screen.player.y) > kMaxCursorWalkTiles) {
        return std::nullopt;
    }
    return point;
}

void Engine::ObserveCursorWalk(bool held) {
    if (held == frame_cursor_walk_) {
        return;
    }
    frame_cursor_walk_ = held;
    // Read by the IPC loop, which shortens its wait while this is true.
    cursor_walk_held_.store(held, std::memory_order_relaxed);

    // An edge, and only an edge: where the chord points travels as its own
    // record, because auto-aim wants that whether or not anybody is holding
    // anything. Queued rather than sent — the pipe belongs to the IPC thread,
    // and a frame is not a place to wait on one.
    actions_.Push(overlay::BuildAction(kCursorWalkAction, {held ? "1" : "0"}));
}

void Engine::ObserveSteer(bool steering, float right, float up,
                          const std::optional<FrameScreen>& screen, bool due) {
    frame_key_right_ = steering ? right : 0.0F;
    frame_key_up_ = steering ? up : 0.0F;

    if (!steering) {
        if (frame_steer_) {
            frame_steer_ = false;
            steer_held_.store(false, std::memory_order_relaxed);
            // An edge, and the one that matters most: a runtime that believed a
            // key was still down would keep subtracting a movement nobody is
            // making. The freshness on the other side is the backstop; this is
            // what makes letting go immediate.
            actions_.Push(overlay::BuildAction(kSteerAction, {"0"}));
        }
        return;
    }

    frame_steer_ = true;
    steer_held_.store(true, std::memory_order_relaxed);
    // Nothing due, or no camera to ask — between realms, or while one is being
    // rebuilt. Saying nothing is right either way: the runtime lets go of a
    // direction it has not been told again, which is the safe reading.
    if (!due || !screen.has_value()) {
        return;
    }

    // **Measured against the camera, not derived from it.** One pixel up and one
    // pixel right, put back through the projection the frame already solved,
    // give the two world directions the keys mean. Camera rotation, zoom and a
    // render resolution that differs from the window's are all already inside
    // that answer — which is the same argument `ScreenProjection.h` makes for
    // never reading the camera's own fields.
    const game::WorldPoint anchor = screen->basis.anchor;
    const game::WorldPoint above =
        game::ToWorld(screen->basis, screen->basis.origin_x, screen->basis.origin_y - 1.0F);
    const game::WorldPoint beside =
        game::ToWorld(screen->basis, screen->basis.origin_x + 1.0F, screen->basis.origin_y);

    const float x = (above.x - anchor.x) * up + (beside.x - anchor.x) * right;
    const float y = (above.y - anchor.y) * up + (beside.y - anchor.y) * right;
    const float length = std::hypot(x, y);
    if (!(length > 0.0F) || !std::isfinite(length)) {
        return;
    }

    const std::string milli_x =
        std::to_string(static_cast<int>(std::lround((x / length) * kMilliUnits)));
    const std::string milli_y =
        std::to_string(static_cast<int>(std::lround((y / length) * kMilliUnits)));
    actions_.Push(overlay::BuildAction(kSteerAction, {"1", milli_x, milli_y}));
}

void Engine::SendCursorPoint(std::uint64_t now_ms,
                             const std::optional<game::WorldPoint>& pointed) {
    if (!pointed.has_value()) {
        return;
    }
    // A record per frame would be sixty a second of a number a hand cannot move
    // that fast.
    if (!cursor_point_.Due(now_ms)) {
        return;
    }

    // Hundredths of a tile, as every other position on this link travels.
    const std::string x = std::to_string(std::lround(pointed->x * 100.0F));
    const std::string y = std::to_string(std::lround(pointed->y * 100.0F));
    actions_.Push(overlay::BuildAction(kCursorPointAction, {x, y}));
}

void Engine::DrawMovement(const std::optional<FrameScreen>& screen,
                          const std::optional<game::WorldPoint>& pointed) const {
    if (!screen.has_value()) {
        return;
    }

    overlay::MovementMarkers markers;
    markers.has_player = true;
    game::ToScreen(screen->basis, game::WorldPoint{screen->player.x, screen->player.y},
                   markers.player.x, markers.player.y);

    // Where the frame is walking to, which is whatever the runtime last asked
    // for and has not let expire — the dodge planner's answer and the chord's
    // arrive through the same target, and that is the point of drawing it.
    float target_x = 0.0F;
    float target_y = 0.0F;
    if (control_.WalkTarget(target_x, target_y)) {
        markers.has_target = true;
        game::ToScreen(screen->basis, game::WorldPoint{target_x, target_y}, markers.target.x,
                       markers.target.y);
    }

    // Whenever anything is reading the cursor, not only while the chord is: a
    // ring where the runtime believes the mouse is, is the check on this whole
    // projection, and cursor aim wants it checked as much as walking does.
    if (pointed.has_value()) {
        markers.has_cursor = true;
        game::ToScreen(screen->basis, *pointed, markers.cursor.x, markers.cursor.y);
    }

    overlay::DrawMovement(markers);
}

int Engine::DrawDodgePicture(std::uint64_t now_ms, const std::optional<FrameScreen>& screen) {
    if (!screen.has_value() || !picture_.fresh(now_ms)) {
        return 0;
    }

    trail_points_.clear();
    trail_lengths_.clear();
    trail_lives_.clear();
    ring_marks_.clear();

    for (const overlay::ShotTrail& trail : picture_.trails()) {
        for (const overlay::TilePoint& point : trail.points) {
            overlay::ScreenPoint on_screen;
            game::ToScreen(screen->basis, game::WorldPoint{point.x, point.y}, on_screen.x,
                           on_screen.y);
            trail_points_.push_back(on_screen);
        }
        trail_lengths_.push_back(static_cast<int>(trail.points.size()));
        trail_lives_.push_back(trail.life);
    }

    // **A radius in tiles is a different number of pixels at every zoom**, and
    // the camera is the only thing that knows which — so the conversion happens
    // here, where the basis is, and the overlay is handed pixels like everything
    // else. Averaged over the two axes because a circle in the world stays a
    // circle on the screen only while the scale is even, and one that is not is
    // better drawn a hair wrong than not at all.
    const game::ScreenBasis& basis = screen->basis;
    const float east = std::hypot(basis.east_x, basis.east_y);
    const float south = std::hypot(basis.south_x, basis.south_y);
    const float pixels_per_tile = (east + south) * 0.5F;

    // **What the picture was published at, and how long ago that was.** A set
    // arrives twenty times a second against a frame that draws several times
    // faster, so a circle pinned to the tile it was stated at steps visibly
    // across whatever it belongs to. Carried forward by its own velocity
    // instead — bounded, because a runtime that has gone quiet must not send
    // circles flying off the map while the set is still counted as fresh.
    const std::uint64_t stated_ms = picture_.committed_at_ms();
    const std::uint64_t since_ms = now_ms > stated_ms ? now_ms - stated_ms : 0;
    const float carried_seconds =
        static_cast<float>(since_ms > overlay::kMaxMarkCarryMs ? overlay::kMaxMarkCarryMs
                                                              : since_ms) /
        1000.0F;

    for (const overlay::DodgeMark& mark : picture_.marks()) {
        overlay::RingMark ring;
        ring.role = static_cast<overlay::RingRole>(mark.kind);
        // The player's own three are drawn where the character actually is:
        // this side reads that every frame, and the runtime hears about it five
        // times a second. See `DodgeMark::follows_player`.
        const game::WorldPoint centre =
            mark.follows_player
                ? game::WorldPoint{screen->player.x, screen->player.y}
                : game::WorldPoint{mark.centre.x + mark.velocity_x * carried_seconds,
                                   mark.centre.y + mark.velocity_y * carried_seconds};
        game::ToScreen(basis, centre, ring.centre.x, ring.centre.y);
        ring.radius = mark.radius_tiles * pixels_per_tile;
        ring.ahead = mark.ahead;
        ring_marks_.push_back(ring);
    }

    // The circles under the paths: the paths are what moves, and a line lost
    // behind a ring is a line nobody can follow.
    overlay::DrawDodgeRings(ring_marks_.data(), static_cast<int>(ring_marks_.size()));

    const int count = static_cast<int>(trail_lengths_.size());
    overlay::TrailMarkers markers;
    markers.points = trail_points_.data();
    markers.lengths = trail_lengths_.data();
    markers.lives = trail_lives_.data();
    markers.count = count;
    overlay::DrawShotTrails(markers);
    return count;
}

void Engine::PublishDodgeView() {
    const bool wanted = frame_ui_.dodge_markers;
    if (dodge_view_stated_ && wanted == sent_dodge_view_) {
        return;
    }
    // Queued rather than sent: this runs on the IPC thread's loop, and the
    // switch it reports is written by the render thread. Either way what the
    // runtime does with it is start or stop answering.
    actions_.Push(overlay::BuildAction(kDodgeViewAction, {wanted ? "1" : "0"}));
    sent_dodge_view_ = wanted;
    dodge_view_stated_ = true;
}

void Engine::DrawAim(std::uint64_t now_ms, const std::optional<FrameScreen>& screen) const {
    if (!screen.has_value()) {
        return;
    }

    // **The point the frame is actually turning shots towards**, which is not
    // the enemy the runtime picked: what travels is where that enemy will *be*
    // when the shot arrives. Drawing the lead rather than the monster is the
    // point — a ring sitting on a monster that is walking would prove the
    // feature was doing nothing.
    float aim_x = 0.0F;
    float aim_y = 0.0F;
    if (!control_.AimTargetNow(now_ms, aim_x, aim_y)) {
        // Nothing is being aimed at, so nothing is drawn — the panel's own line
        // is what tells "off" apart from "nothing to aim at". Drawing a marker
        // on the player anyway would put a second ring under the movement
        // markers' one whenever both switches are on.
        return;
    }

    overlay::AimMarkers markers;
    markers.has_player = true;
    game::ToScreen(screen->basis, game::WorldPoint{screen->player.x, screen->player.y},
                   markers.player.x, markers.player.y);
    markers.has_target = true;
    game::ToScreen(screen->basis, game::WorldPoint{aim_x, aim_y}, markers.target.x,
                   markers.target.y);

    overlay::DrawAim(markers);
}

void Engine::Say(std::string_view line) {
    (void)session_.SendControlAction(overlay::BuildAction(kInspectAction, {line}));
}

void Engine::DumpPlayerObject() {
    const auto bytes = binding_.SnapshotPlayer();
    if (bytes.empty()) {
        Say("no player object right now");
        return;
    }

    // What the server says, first, so the numbers below have something to be
    // read against. Finding a value in an object is only useful when you know
    // which value you are looking for.
    Say("server says hp " + std::to_string(world_.hp) + " maxHp " +
        std::to_string(world_.max_hp) + " defense " +
        (world_.defense_known ? std::to_string(world_.defense) : std::string{"unknown"}));

    DumpObject(bytes, [this](std::string_view line) { Say(line); });
}

void Engine::ExportImage() {
    const auto summary =
        ExportClasses(*binding_.runtime(), kDumpChunkBytes, [this](const std::string& chunk) {
            (void)session_.SendControlAction(overlay::BuildAction(kDumpChunkAction, {chunk}));
        });

    (void)session_.SendControlAction(overlay::BuildAction(
        kDumpEndAction, {std::to_string(summary.written), std::to_string(summary.skipped)}));
}

void Engine::ExportClass(const std::string& full_name) {
    if (full_name.empty()) {
        Say("no class selected");
        return;
    }

    // One class, and one already described from a click without fault, so the
    // whole-image sweep's hazards do not apply — this walks nothing else. The
    // members go out as `inspect` lines, which the runtime logs, so the answer
    // lands where the player dump does rather than in a file that has to be
    // configured first.
    const auto detail = Describe(*binding_.runtime(), full_name);
    WriteClass(detail, [this](std::string_view line) { Say(line); });
    Say("end " + detail.name);
}

void Engine::HandlePendingActions() {
    for (const std::string& action : actions_.Drain()) {
        if (AnswerLocally(action)) {
            continue;
        }
        // A send that fails is dropped rather than retried. The runtime replays
        // the whole plugin list when the link comes back, so the overlay ends up
        // showing the truth either way — and a queue that survives a
        // disconnection would replay a click against a runtime that has since
        // been restarted with different plugins.
        (void)session_.SendControlAction(action);
    }
}

bool Engine::AnswerLocally(const std::string& action) {
    const auto fields = overlay::SplitRecord(action);
    const std::string& kind = fields.front();

    if (kind == overlay::kClearInspectorAction) {
        // Both sides let go, which is the whole of "clear": the report is
        // shared by pointer, so it lives exactly as long as someone holds it.
        inspector_report_.reset();
        inspector_.Publish(nullptr);
        return true;
    }

    const bool dump_player = kind == overlay::kDumpPlayerAction;
    const bool load = kind == overlay::kLoadClassesAction;
    const bool describe = kind == overlay::kDescribeClassAction;
    const bool export_all = kind == overlay::kExportClassesAction;
    const bool export_one = kind == overlay::kExportClassAction;
    const bool export_player = kind == overlay::kExportPlayerClassAction;
    if (!load && !describe && !export_all && !export_one && !export_player && !dump_player) {
        return false;
    }
    if (!binding_.bound()) {
        Say("the game is not bound yet");
        return true;
    }

    if (export_all) {
        ExportImage();
        return true;
    }

    if (export_one) {
        ExportClass(fields.size() > 1 ? fields[1] : std::string{});
        return true;
    }

    // The one class every unresolved player key is found in, without anyone
    // having to know what the obfuscator called it this build.
    if (export_player) {
        ExportClass(std::string{game::PlayerClassName()});
        return true;
    }

    if (dump_player) {
        DumpPlayerObject();
        return true;
    }

    // Copy-on-write: the published report is const and the render thread may be
    // reading it this instant, so a change builds a new one beside it.
    auto next = std::make_shared<overlay::InspectorReport>(
        inspector_report_ == nullptr ? overlay::InspectorReport{} : *inspector_report_);

    if (load) {
        next->classes = binding_.runtime()->ClassNames();
        next->selected = {};
    } else {
        next->selected = Describe(*binding_.runtime(), fields.size() > 1 ? fields[1]
                                                                         : std::string{});
    }

    inspector_report_ = std::move(next);
    inspector_.Publish(inspector_report_);
    return true;
}

void Engine::PublishModel() {
    const bool connected = connected_.load(std::memory_order_acquire);
    const bool bound = binding_.bound();
    const std::uint32_t redirected = redirect_.redirected();
    const std::uint32_t seen = redirect_.seen();

    // Only on change. The loop turns four times a second and the overlay reads
    // a version number; republishing an identical model would make every frame
    // copy a vector for nothing.
    if (published_connected_ == connected && published_bound_ == bound &&
        published_redirected_ == redirected && published_seen_ == seen && !world_dirty_ &&
        !controls_dirty_ && !offsets_dirty_ && !memory_dirty_ && model_.published()) {
        return;
    }
    published_connected_ = connected;
    published_bound_ = bound;
    published_redirected_ = redirected;
    published_seen_ = seen;
    world_dirty_ = false;
    controls_dirty_ = false;
    offsets_dirty_ = false;
    memory_dirty_ = false;

    overlay::OverlayModel model;
    model.world = world_;
    model.weapon = weapon_;
    model.memory = binding_.reading();
    model.plugins = controls_.plugins();
    model.controls_version = controls_.version();
    model.link_connected = connected;
    model.game_bound = bound;
    model.redirect_installed = redirect_installed_;
    model.redirected = redirected;
    model.connects_seen = seen;
    model.last_other_port = redirect_.last_other_port();
    if (!connected) {
        model.status = "waiting for the runtime";
    } else if (!bound) {
        model.status = binding_.state();
    }
    // Failures are carried across too, not filtered out: "we looked and it was
    // not there" is exactly what somebody needs to see after a game patch, and
    // a report that showed only successes would look healthy while a feature
    // sat silently switched off.
    for (const auto& entry : binding_.offsets()) {
        overlay::OffsetRow row;
        row.key = entry.key;
        row.resolved = entry.resolved;
        row.detail = entry.detail;
        row.offset = entry.offset;
        row.address = entry.address;
        row.is_method = entry.kind == game::OffsetTable::Kind::kMethod;
        model.offsets.push_back(std::move(row));
    }
    model_.Publish(std::move(model));
}

void Engine::DrawFrame() {
    // Before the overlay, and outside its visibility check: moving and shooting
    // are not things the user is looking at, and they must happen whether or
    // not a window is open. This is the game's own thread, which is the only
    // one that may call into it.
    const std::uint64_t now = NowMs();
    control_.Apply(now);

    // The same argument once more, for the chord that walks to the cursor: it
    // is held while the player is looking at the game, not at a panel over it.
    // Not while one is open, either — a click there is aimed at a widget.
    const bool chord = !overlay_.visible() && CursorWalkChordHeld();
    ObserveCursorWalk(chord);

    // And once more for the movement keys. Which way they point is free to ask;
    // what that means in tiles is not, so the decision to *say* it is taken here
    // — before the camera is measured — and only a change of keys or the cadence
    // elapsing makes it worth asking. A panel over the game takes the keys, so a
    // player typing into one is not steering.
    float key_right = 0.0F;
    float key_up = 0.0F;
    const bool steering = !overlay_.visible() && MovementKeysHeld(key_right, key_up);
    const bool steer_due =
        steering && (!frame_steer_ || key_right != frame_key_right_ ||
                     key_up != frame_key_up_ || steer_.Due(now));

    // Where the cursor is, for whoever asked: the chord walks there, and cursor
    // aim ranks enemies by how close they are to it. Both are off by default,
    // and the answer costs three calls into managed code — so nothing is
    // measured until one of them, the markers, or a steering record wants it.
    const bool tracking = chord || CursorTrackWanted(now);
    const std::optional<FrameScreen> screen =
        tracking || steer_due || frame_ui_.movement_markers || frame_ui_.aim_markers ||
                frame_ui_.dodge_markers
            ? MeasureScreen()
            : std::nullopt;
    const std::optional<game::WorldPoint> pointed =
        tracking && screen.has_value() ? CursorTarget(*screen) : std::nullopt;
    SendCursorPoint(now, pointed);
    ObserveSteer(steering, key_right, key_up, screen, steer_due);

    // What the scene pass acts on, and every part of it is the runtime's claim
    // read on this thread: a lease says whether it is still wanted, and a value
    // beside it says what it asked for. Both stop being true on their own if
    // the runtime stops saying them.
    const std::optional<float> collider = ColliderWanted(now);
    const bool tint = TintWanted(now);
    patches_.Want({tint, game::UnpackColour(TintColour()), collider});
    patches_.Apply(now);

    // A store rather than a claim acted on once: what the lease says is the
    // whole of what the detours read. Written every frame rather than on a
    // change, because that is one relaxed store against remembering what was
    // last sent — and it is what puts the feature back on after an install that
    // failed and switched itself off.
    const bool shots_pass_walls = ShotNoclipWanted(now);
    shot_noclip_.SetEnabled(shots_pass_walls);

    // The same store again, for the claim that made the pattern.
    const bool walk_wanted = WalkNoclipWanted(now);
    walk_noclip_.SetEnabled(walk_wanted);

    model_.Refresh(frame_model_, frame_model_version_);

    // Accumulated rather than assigned: the counter is zeroed by reading it, and
    // showing only what was lost since the last frame would make a real stall
    // flash past in one frame.
    frame_model_.dropped_input += overlay_.TakeDroppedInput();
    frame_model_.dropped_actions += actions_.TakeDropped();

    // Read straight off the objects rather than published with the rest of the
    // model: the counters move on every repaint the tint substitutes, and a
    // model republished for that would copy the whole offset report with it.
    // Every switch below is the runtime's, so what it says is shown here too:
    // without it a detour that is in and doing nothing is indistinguishable
    // from a plugin nobody enabled.
    frame_model_.tint_wanted = tint;
    frame_model_.tint_installed = patches_.tint_installed();
    frame_model_.tinted = patches_.tinted();
    frame_model_.collision_bound = patches_.collision_bound();
    frame_model_.collisions_written = patches_.collisions_written();
    // What is being asked for, not merely that something is: "on" without the
    // number says nothing about which end of the plugin's slider the panel is
    // describing.
    frame_model_.collision_scale = collider;
    frame_model_.shot_noclip_wanted = shots_pass_walls;
    frame_model_.shot_noclip_installed = shot_noclip_.installed();
    frame_model_.shots_passed = shot_noclip_.passed();
    frame_model_.walk_noclip_wanted = walk_wanted;
    frame_model_.walks_allowed = walk_noclip_.allowed();
    frame_model_.walk_gates = walk_noclip_.hooked();
    frame_model_.text_installed = patches_.text_installed();
    frame_model_.texts_shown = patches_.texts_shown();
    frame_model_.camera_bound = projection_.bound();
    // Only whether there is one: where it points is `DrawAim`'s business, and
    // the panel's line is about the state rather than the place.
    float aim_x = 0.0F;
    float aim_y = 0.0F;
    frame_model_.aim_live = control_.AimTargetNow(now, aim_x, aim_y);
    frame_model_.aim_installed = control_.aim_installed();
    frame_model_.aim_redirected = control_.redirected();

    // Over the map rather than in a panel, so both are drawn whether or not one
    // is open — which is also when they are worth seeing.
    // The shots first, so what the module is doing to the character is drawn
    // over them rather than under fifty lines. Zero while the switch is off,
    // which is also what the panel's line reads.
    frame_model_.trails_drawn = frame_ui_.dodge_markers ? DrawDodgePicture(now, screen) : 0;
    if (frame_ui_.movement_markers) {
        DrawMovement(screen, pointed);
    }
    if (frame_ui_.aim_markers) {
        DrawAim(now, screen);
    }

    if (!overlay_.visible()) {
        return;
    }
    // Refreshed by pointer: the common case is one atomic load and no copy at
    // all, which is why the report is not in the model.
    inspector_.Refresh(frame_inspector_, frame_inspector_version_);

    overlay::Draw(frame_model_, frame_inspector_, frame_ui_, [this](std::string action) {
        // Queued, not sent: the pipe belongs to the IPC thread, and a frame is
        // not a place to wait on one.
        actions_.Push(std::move(action));
    });
}

}  // namespace brownie::app
