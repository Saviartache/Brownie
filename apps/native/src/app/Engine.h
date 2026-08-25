// The module's lifetime, as one object.
//
// The reference implementation's startup was a sequence of free functions with
// an ordering that existed only as the order somebody had written the calls in,
// and a hard six-second sleep in the middle to let the game "settle". Nothing
// could be started twice, nothing could be stopped and restarted, and the sleep
// was load-bearing without saying what it was waiting for.
//
// Here, starting is a method, stopping is a method, and stopping is what the
// destructor does — so an unload that arrives at a bad moment is a scope exit
// rather than a race. Nothing is a process-lifetime global: an injected module
// can be unloaded, which makes process lifetime a lie.
//
// **What is left here is the loop and the wiring.** Reaching the game lives in
// `GameBinding`, acting on the game lives in `PlayerControl`, and describing the
// game lives in `Inspection` — each of them a piece with one owner and one
// thread. This owns the thread, the link, and the decision about when each of
// them is asked to do anything.

#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "app/Cadence.h"
#include "app/GameBinding.h"
#include "app/PlayerControl.h"
#include "app/PlayerCosmetics.h"
#include "app/ScenePatches.h"
#include "core/Result.h"
#include "core/Snapshot.h"
#include "game/PlayerNoclip.h"
#include "game/ProjectileNoclip.h"
#include "game/QuitWatch.h"
#include "game/ScreenProjection.h"
#include "hooks/Hook.h"
#include "ipc/Session.h"
#include "net/ConnectHook.h"
#include "overlay/ActionQueue.h"
#include "overlay/ControlRecord.h"
#include "overlay/Overlay.h"
#include "overlay/DodgePicture.h"
#include "overlay/WorldMarkers.h"
#include "overlay/Ui.h"

namespace brownie::app {

struct EngineOptions {
    /// Pipe name without the `\\.\pipe\` prefix. Also names the session key
    /// file, so both sides find the same secret from this one value.
    std::wstring pipe_name = L"brownie-bridge";
    /// The port the game dials to reach a server. The redirect keeps it and
    /// changes only the address, so the proxy answers on the same one.
    std::uint16_t game_port = 2050;
    /// How long to wait before trying the runtime again. The game is often
    /// started first, so "not listening" is the ordinary case, not a failure.
    std::uint32_t reconnect_delay_ms = 1000;
};

class Engine {
  public:
    /// How often the loop looks for what it has not found yet.
    static constexpr std::uint32_t kSetupIntervalMs = 500;
    /// How often the player is read out of the game's memory.
    static constexpr std::uint32_t kReadIntervalMs = 250;
    /// How often the place under the cursor is passed on, while anything is
    /// watching it.
    ///
    /// Faster than the memory read and slower than a frame: a hand moves a
    /// mouse, and twenty readings a second is past what anybody can tell from
    /// forty. Costs nothing when nobody is watching — nothing is measured and
    /// nothing is sent.
    static constexpr std::uint32_t kCursorPointIntervalMs = 50;
    /// The longest the loop may wait while anything is watching the cursor.
    ///
    /// What the render thread queues is sent by the loop, so the loop's wait is
    /// the delay between moving the mouse and the runtime knowing. The rest of
    /// the time this costs nothing, because the wait is only shortened while
    /// somebody is asking.
    static constexpr std::uint32_t kCursorPollMs = 50;
    /// How often which way the player is steering is restated while they are.
    ///
    /// A key going down or coming up is reported the frame it happens, so this
    /// is only the heartbeat: it exists because the *camera* can turn under a
    /// held key, and because the reading on the other side expires on purpose.
    /// Slower than the cursor's, because a hand changes direction far less often
    /// than it moves a mouse.
    static constexpr std::uint32_t kSteerIntervalMs = 100;

    explicit Engine(EngineOptions options) noexcept : options_{std::move(options)} {}

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    /// Stops, always. An unload arriving mid-frame is then a scope exit.
    ~Engine() { Stop(); }

    /// Starts the IPC thread. Fails only if already running.
    Status Start();

    /// Stops and joins. Safe to call more than once, and from any thread.
    ///
    /// Ordering matters and is fixed here: the session is cancelled *before*
    /// the thread is joined, because a thread blocked in a read cannot notice a
    /// flag — which is the deadlock the reference implementation shipped.
    void Stop() noexcept;

    [[nodiscard]] bool running() const noexcept { return running_.load(std::memory_order_acquire); }

    /// Whether the runtime is connected and authenticated, for the overlay to
    /// show and for features to gate on.
    [[nodiscard]] bool connected() const noexcept {
        return connected_.load(std::memory_order_acquire);
    }

    /// The session, for the render thread to send telemetry through.
    ///
    /// Valid only while `running()`. Sending from another thread is safe in the
    /// sense the pipe makes it safe — one writer at a time — which is why the
    /// render thread and the connect reporter may both reach it.
    [[nodiscard]] ipc::Session& session() noexcept { return session_; }

  private:
    void Run();

    /// One turn of the loop: look for what is missing, read what is there,
    /// publish what changed, and wait for the runtime to say something.
    ///
    /// **Nothing here may throw, and that is a property of the build rather
    /// than a habit.** The module is compiled without exceptions, so a `throw`
    /// inside the standard library is an `abort` — of the *game*. Everything
    /// this reads comes out of the game's own memory, which means every count
    /// and length it acts on is bounded before it is used.
    void Turn();

    /// How long a runtime's claim on player noclip is good for without being
    /// restated.
    ///
    /// Three restatements' worth of the one-second tick that draws the
    /// countdown, so a late turn of the runtime's loop does not switch the
    /// feature off under somebody who is using it — and the game is walking
    /// normally again within a few seconds of the runtime going quiet, however
    /// it went quiet.
    static constexpr std::uint64_t kWalkNoclipLeaseMs = 3000;

    /// The same, for the runtime's claim on the cursor reading, and the same
    /// three restatements of the second the plugin restates it on.
    static constexpr std::uint64_t kCursorTrackLeaseMs = 3000;

    /// The same again, for the runtime's claim on the player's collision
    /// circle. A lapsed one is not merely a feature that stops: the module puts
    /// the game's own multiplier back, so three seconds is how long a killed
    /// runtime leaves the player smaller than the game built them.
    static constexpr std::uint64_t kColliderLeaseMs = 3000;

    /// The same again, for the runtime's claim on the health bar's colour and
    /// for its claim on letting shots through walls. Nothing dangerous is left
    /// behind by either lapsing — one repaints a bar the game repaints itself,
    /// the other stops a detour substituting — but a claim that outlives its
    /// claimant is a claim nobody can revoke.
    static constexpr std::uint64_t kTintLeaseMs = 3000;
    static constexpr std::uint64_t kShotNoclipLeaseMs = 3000;
    static constexpr std::uint64_t kArcaneStyleLeaseMs = 3000;
    static constexpr std::uint64_t kSkinLeaseMs = 3000;

    /// How long the next poll may wait: until the soonest job is due, and no
    /// longer than one poll's worth.
    [[nodiscard]] std::uint32_t PollBudgetMs(std::uint64_t now_ms) const noexcept;

    /// Stores one record from the runtime. IPC thread, from the session's
    /// handler: it only stores, because acting means calling into the game and
    /// this is not the thread that may.
    void AcceptRecord(std::string_view record);

    /// Stores one feature switch from the runtime. IPC thread, and a store for
    /// the same reason `AcceptRecord` is one.
    ///
    /// **The first consumer of this message**, which had been carried end to
    /// end and dropped here. Everything the module does to the game so far is
    /// switched on in the overlay, because it acts through this process alone
    /// and a switch that needed the link to be up would be one nobody could use
    /// to find out why the link is down. Player noclip is the first that is not
    /// like that: half of it is the runtime holding packets, the two halves
    /// have to go on and off together, and so the switch belongs to whichever
    /// side cannot be given the other's half — which is this one.
    void AcceptFeature(std::string_view key, std::string_view value);

    /// Looks for the game, and hands over anything newly found. IPC thread.
    void AdvanceSetup();

    /// Puts the aim detours in place, and says in the runtime's log which ones
    /// went in. Only called once the runtime has asked to aim.
    void InstallAimHook();

    /// The player and the camera, as this frame found them.
    struct FrameScreen {
        game::PlayerLocation player;
        game::ScreenBasis basis;
    };

    /// Asks the camera where the world is, once for everything in the frame
    /// that needs it. **Render thread**, and three calls into managed code — so
    /// it is asked only while something is actually using the answer.
    [[nodiscard]] std::optional<FrameScreen> MeasureScreen() const;

    /// Where the cursor is pointing, in tiles, or nothing when it is nowhere
    /// believable. **Render thread.**
    [[nodiscard]] std::optional<game::WorldPoint> CursorTarget(const FrameScreen& screen) const;

    /// Draws where the module is walking, over the map. **Render thread**, and
    /// after `PlayerControl::Apply`, which is what settles the place drawn.
    void DrawMovement(const std::optional<FrameScreen>& screen,
                      const std::optional<game::WorldPoint>& pointed) const;

    /// Draws where the module is pointing the player's shots, with the numbers
    /// behind it. **Render thread.**
    void DrawAim(std::uint64_t now_ms, const std::optional<FrameScreen>& screen) const;

    /// Draws what the dodge planner is thinking over the map. **Render thread.**
    ///
    /// The runtime says where the shots are going and which distances it is
    /// keeping, because that is its motion model, its game data and its
    /// settings; this projects the answer and hands it to the overlay.
    /// @returns how many shot paths were drawn, for the panel's own line.
    [[nodiscard]] int DrawDodgePicture(std::uint64_t now_ms,
                                       const std::optional<FrameScreen>& screen);

    /// Tells the runtime whether the dodge picture is wanted, when that changes.
    /// **IPC thread**, from the loop.
    ///
    /// Restated whenever the link comes back rather than only on the tick it is
    /// clicked: a runtime that has just started knows nothing about a box that
    /// was ticked before it existed.
    void PublishDodgeView();

    /// Reports the walk-to-cursor chord going down and coming up. **Render
    /// thread**, once a frame, and only on the frames it changes.
    ///
    /// **The module says what the player did, and the runtime decides what it
    /// means.** Walking anywhere needs the character's speed, which is a stat
    /// off the wire and therefore the runtime's — so the answer comes back as
    /// an ordinary move target, the same one the dodge planner produces, from
    /// the same plugin, so that the module's move target keeps having exactly
    /// one writer.
    void ObserveCursorWalk(bool held);

    /// Passes on a Shift+left-click, so auto-follow can pick the ally under the
    /// cursor. **Render thread**, once a frame, and only on the frame the chord
    /// goes down.
    ///
    /// **Only the down edge, and no release.** Unlike the walk chord, this is a
    /// one-shot: the runtime takes the ally standing under the last cursor point
    /// once — or cancels the follow when none is there — and needs nothing on
    /// the way up. Left-click is the game's own shoot button, so the press is
    /// read, never swallowed — the shot still fires, and where the cursor points
    /// travels as its own record the same as ever.
    void ObservePick(bool held);

    /// Passes on the place under the cursor, on its own cadence. **Render
    /// thread.**
    ///
    /// Its own record rather than a field of the chord's, because the two have
    /// different readers: the chord is a person asking to be walked somewhere,
    /// and the point is also what cursor aim ranks enemies against while nobody
    /// is holding anything.
    void SendCursorPoint(std::uint64_t now_ms, const std::optional<game::WorldPoint>& pointed);

    /// Passes on which way the player is walking under their own power.
    /// **Render thread**, once a frame.
    ///
    /// **A world direction, and working one out is the whole reason this is
    /// here.** The keys say "towards the top of the screen"; the game maps that
    /// through the camera, so a rotated camera turns the same key into any
    /// heading at all. Only this side can ask the camera, so only this side can
    /// answer — and the runtime gets tiles rather than keys.
    ///
    /// **What it is for is the runtime deciding when *not* to act.** A dodge
    /// that knows the player is already walking somewhere safe can say nothing
    /// and leave them to it; one that has to take the wheel can subtract what
    /// they are contributing instead of adding to it. See `dodgePlugin.ts`.
    ///
    /// @param due Whether a record is wanted this frame — decided by the caller
    ///   before the camera is measured, because measuring is the expensive part
    ///   and the keys are free to read.
    void ObserveSteer(bool steering, float right, float up,
                      const std::optional<FrameScreen>& screen, bool due);

    /// Whether the runtime's claim on the cursor reading is still good.
    ///
    /// A lease for the same reason player noclip's is: the plugin that asks can
    /// be disabled, can fail and can be unloaded, and none of those say so. It
    /// restates the claim while it wants it; this expires on its own.
    [[nodiscard]] bool CursorTrackWanted(std::uint64_t now_ms) const noexcept {
        return now_ms < cursor_track_until_ms_.load(std::memory_order_relaxed);
    }

    /// Puts the projectile collision detours in place, and says so in the
    /// runtime's log. Only called once the operator has switched the feature
    /// on, and asked again until the game has built a projectile.
    void InstallProjectileNoclip();

    /// Puts the walkability detours in place, and says so in the runtime's log.
    /// Only called while the runtime's claim is live, and asked again until
    /// both are in.
    void InstallPlayerNoclip();

    /// Whether the runtime's claim on player noclip is still good at `now_ms`.
    [[nodiscard]] bool WalkNoclipWanted(std::uint64_t now_ms) const noexcept {
        return now_ms < walk_noclip_until_ms_.load(std::memory_order_relaxed);
    }

    /// What the player's collision circle should be scaled by at `now_ms`, or
    /// nothing to leave the game's own value alone.
    ///
    /// One asker now that the overlay's "no hitbox" switch has moved into the
    /// plugin that owns this field: the whole circle gone is that plugin asking
    /// for a multiplier of nought, which is a value this already carries.
    [[nodiscard]] std::optional<float> ColliderWanted(std::uint64_t now_ms) const noexcept {
        if (now_ms >= collider_until_ms_.load(std::memory_order_relaxed)) {
            return std::nullopt;
        }
        return collider_multiplier_.load(std::memory_order_relaxed);
    }

    /// Whether the runtime's claim on the health bar's colour is still good at
    /// `now_ms`, and what colour it asked for as `0xRRGGBBAA`.
    ///
    /// The colour is read whether or not the claim is live, for the reason the
    /// collider's multiplier is: it arrives ahead of the claim and only when it
    /// has moved, so a value refused for arriving first would leave the claim
    /// painting with the colour before it.
    [[nodiscard]] bool TintWanted(std::uint64_t now_ms) const noexcept {
        return now_ms < tint_until_ms_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] std::uint32_t TintColour() const noexcept {
        return tint_colour_.load(std::memory_order_relaxed);
    }

    /// Whether the runtime's claim on letting shots through walls is still good
    /// at `now_ms`.
    [[nodiscard]] bool ShotNoclipWanted(std::uint64_t now_ms) const noexcept {
        return now_ms < shot_noclip_until_ms_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] bool ArcaneStyleWanted(std::uint64_t now_ms) const noexcept {
        return now_ms < arcane_style_until_ms_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] bool SkinWanted(std::uint64_t now_ms) const noexcept {
        return now_ms < skin_until_ms_.load(std::memory_order_relaxed);
    }

    /// Installs the connect redirect once Winsock is loaded. Ordinary to be too
    /// early — the loop is the retry.
    void TryRedirect();

    /// Lets go of the game, once it has said it is quitting.
    ///
    /// **The only shutdown path that runs while the game is still there.**
    /// `DllMain` cannot tear anything down and `BrownieShutdown` only happens
    /// when somebody calls it, so without this the module is still drawing into
    /// a swap chain and reading through a runtime that are being destroyed.
    /// Idempotent, and the loop's own thread's: removing the overlay's detour
    /// suspends every other thread in the game, which is not something to do
    /// from inside one of them.
    void LetGo() noexcept;

    /// One overlay frame, on the render thread. Reads a snapshot and nothing
    /// else — a frame is not a place to wait for a lock the IPC thread holds.
    void DrawFrame();

    /// Rebuilds and publishes what the overlay shows. IPC thread only.
    void PublishModel();

    /// Deals with whatever the render thread queued. IPC thread only, because
    /// the sequence number the pipe carries has exactly one owner.
    ///
    /// Most interactions are the runtime's to answer and go straight out. The
    /// inspector's are not: they ask about metadata only this side can see.
    void HandlePendingActions();

    /// Answers one inspector request into the runtime's log or the overlay's
    /// own report.
    ///
    /// @returns false when the action was not an inspector request, and so is
    ///   the runtime's to answer.
    [[nodiscard]] bool AnswerLocally(const std::string& action);

    /// Sends one line of an answer back to the runtime, which logs it.
    void Say(std::string_view line);

    /// Prints the player object word by word, beside what the server says the
    /// player's stats are. A diagnostic for the case where a field resolves and
    /// does not hold what its name claims.
    void DumpPlayerObject();

    /// Sends every prepared class, with its members, in chunks for the Node
    /// side to write out.
    void ExportImage();

    /// Prints one named class's members to the log. The safe counterpart to
    /// `ExportImage`: it describes a single class — one already inspected
    /// without fault — so it never walks the whole image.
    void ExportClass(const std::string& full_name);

    EngineOptions options_;
    ipc::Session session_{::GetCurrentProcessId()};

    /// Declared before everything that holds a hook, so that it is destroyed
    /// *after* all of them. Every hook has to be removed while MinHook is still
    /// initialised, and member destruction order is what guarantees that rather
    /// than a comment somewhere asking for it.
    std::optional<hooks::HookEngine> hook_engine_;
    overlay::Overlay overlay_;
    /// All three hold hooks — the readiness watcher inside the binding, the aim
    /// detours inside the control — so they are declared after the engine that
    /// owns MinHook and destroyed before it.
    GameBinding binding_;
    PlayerControl control_;
    net::ConnectHook redirect_;
    /// All three hold detours, so all three are declared after the engine that
    /// owns MinHook and destroyed before it.
    ScenePatches patches_;
    PlayerCosmetics cosmetics_;
    game::ProjectileNoclip shot_noclip_;
    game::PlayerNoclip walk_noclip_;
    game::QuitWatch quit_;
    /// Holds no hook — three method addresses and nothing else — so it needs no
    /// place in the ordering above.
    game::ScreenProjection projection_;

    /// When the runtime's claim on player noclip runs out.
    ///
    /// **A lease rather than a flag**, which is what every switch the runtime
    /// owns is and for the reason this one made plainest: it is a plugin, and a
    /// plugin can be disabled, can fail, can be unloaded, and the runtime behind
    /// it can be killed — and every one of those leaves the game with a player
    /// who walks through walls and no way to say stop. So the runtime restates
    /// it while it wants it and the claim expires on its own; see
    /// `kWalkNoclipLeaseMs`.
    ///
    /// Written by the IPC thread, read by the game's on every frame and by the
    /// setup pass.
    std::atomic<std::uint64_t> walk_noclip_until_ms_{0};

    /// Published on the IPC thread, read on the render thread.
    Snapshot<overlay::OverlayModel> model_;
    /// The render thread's own copy, and how far it has caught up.
    overlay::OverlayModel frame_model_;
    std::uint64_t frame_model_version_ = 0;
    /// What the overlay itself holds. Render thread only.
    overlay::UiState frame_ui_;

    /// The inspector's report, shared by pointer rather than carried in the
    /// model: it is large, it changes only when a button is pressed, and the
    /// model is republished four times a second. Null until asked for, and null
    /// again once cleared — which is what actually returns the memory.
    Snapshot<std::shared_ptr<const overlay::InspectorReport>> inspector_;
    /// The IPC thread's own handle on it, so a change can be built from the
    /// last one without reading what the render thread is drawing.
    std::shared_ptr<const overlay::InspectorReport> inspector_report_;
    /// The render thread's, and how far it has caught up.
    std::shared_ptr<const overlay::InspectorReport> frame_inspector_;
    std::uint64_t frame_inspector_version_ = 0;
    /// Interactions on their way back, filled by the render thread and drained
    /// by the IPC one.
    overlay::ActionQueue actions_;

    /// The latest world the runtime described, and whether it is newer than
    /// what has been published.
    overlay::WorldStatus world_;
    /// Sent when the player swaps an item, so it lives beside the world status
    /// and rides the same dirty flag rather than owning one of its own.
    overlay::WeaponStatus weapon_;
    bool world_dirty_ = false;
    /// The runtime's plugin list, mirrored, and the same question about it.
    overlay::ControlMirror controls_;
    bool controls_dirty_ = false;
    bool offsets_dirty_ = false;
    bool memory_dirty_ = false;
    bool redirect_installed_ = false;
    /// Whether the game has been let go of. IPC thread only.
    bool released_ = false;
    bool published_connected_ = false;
    bool published_bound_ = false;
    std::uint32_t published_redirected_ = 0;
    std::uint32_t published_seen_ = 0;

    /// Looking for things that are not there yet: the swap chain's readiness,
    /// the connect redirect, the IL2CPP runtime, the offsets. All of it is a
    /// handful of comparisons once found, and none of it can be found sooner by
    /// asking more often.
    Cadence setup_{kSetupIntervalMs};
    /// Reading the player out of the game's memory. The overlay shows it, and
    /// nobody reads a number faster than this.
    Cadence read_{kReadIntervalMs};
    /// Whether the walk-to-cursor chord is down. Written by the render thread
    /// on the frame it changes, read by the IPC thread — which shortens its
    /// wait while it is true, so that a person steering is not steering into a
    /// quarter-second of latency.
    std::atomic<bool> cursor_walk_held_{false};
    /// The state last reported. Render thread only, which is what makes the
    /// chord an edge rather than a record per frame.
    bool frame_cursor_walk_ = false;
    /// Whether the pick chord was down last frame. Render thread only, so a held
    /// Shift+left-click fires one pick on the way down rather than one a frame.
    bool frame_pick_ = false;
    /// How often the point under the cursor is passed on. Render thread only,
    /// because that is the only thread that may ask the camera.
    Cadence cursor_point_{kCursorPointIntervalMs};

    /// Whether a movement key is down. Written by the render thread on the frame
    /// it changes, read by the IPC thread — which shortens its wait while it is
    /// true, for the same reason the chord does: a direction that reaches the
    /// planner a quarter of a second late is a direction it plans around wrong.
    std::atomic<bool> steer_held_{false};
    /// The state last reported, and the key vector it was reported from. Render
    /// thread only, which is what makes a key going down an edge rather than a
    /// record per frame.
    bool frame_steer_ = false;
    float frame_key_right_ = 0.0F;
    float frame_key_up_ = 0.0F;
    /// The heartbeat under that, so a camera turning under a held key is not
    /// missed. Render thread only.
    Cadence steer_{kSteerIntervalMs};

    /// What the dodge planner is thinking, as the runtime last described it.
    /// Written on the IPC thread by the record handler, read by the frame that
    /// draws it — one writer, one reader, and a set only ever swapped whole.
    overlay::DodgePicture picture_;
    /// Projected into every frame that draws them, and kept so that a frame
    /// with fifty shots on it allocates nothing.
    std::vector<overlay::ScreenPoint> trail_points_;
    std::vector<int> trail_lengths_;
    std::vector<float> trail_lives_;
    std::vector<overlay::RingMark> ring_marks_;
    /// What was last said to the runtime about wanting them, and whether
    /// anything has been said at all on this connection.
    bool sent_dodge_view_ = false;
    bool dodge_view_stated_ = false;

    /// When the runtime's claim on the cursor reading runs out.
    ///
    /// A lease, and for the second half of the reason the one above it is: the
    /// plugin that asks can be disabled, can fail and can be unloaded, and none
    /// of those say so. Nothing dangerous is left behind by one that lapses —
    /// only three calls a frame into a camera nobody is reading — but a claim
    /// that outlives its claimant is a claim nobody can revoke.
    ///
    /// Written by the IPC thread, read by the game's on every frame.
    std::atomic<std::uint64_t> cursor_track_until_ms_{0};

    /// When the runtime's claim on the player's collision circle runs out, and
    /// what it asked the circle to be scaled by.
    ///
    /// A lease, for the first half of noclip's reason: what lapses here is a
    /// number written into the game, and the module puts the game's own value
    /// back when it does — see `game/PlayerCollision.h`. One means "leave it
    /// alone", so a claim that arrives before any number does nothing rather
    /// than something drastic.
    ///
    /// Written by the IPC thread, read by the game's on every frame.
    std::atomic<std::uint64_t> collider_until_ms_{0};
    std::atomic<float> collider_multiplier_{1.0F};

    /// When the runtime's claim on the health bar's colour runs out, and what
    /// colour it asked for, packed as `0xRRGGBBAA`.
    ///
    /// Packed rather than four floats for the reason `game::PackColour` gives:
    /// one word is one load, so a colour changing cannot be observed half-done
    /// by the thread reading it.
    ///
    /// Written by the IPC thread, read by the game's on every frame.
    std::atomic<std::uint64_t> tint_until_ms_{0};
    std::atomic<std::uint32_t> tint_colour_{game::PackColour(game::HealthBarTint::kDefaultColour)};

    /// When the runtime's claim on letting shots through walls runs out.
    ///
    /// Written by the IPC thread, read by the game's on every frame.
    std::atomic<std::uint64_t> shot_noclip_until_ms_{0};

    /// The selected ShaderProperties id and the lease that owns the override.
    /// The IPC thread publishes it only when a claim arrives; the render thread
    /// keeps its own copy and passes an empty view once the claim expires.
    Snapshot<std::string> arcane_style_;
    std::string frame_arcane_style_;
    std::uint64_t frame_arcane_style_version_ = 0;
    std::atomic<std::uint64_t> arcane_style_until_ms_{0};

    std::atomic<std::int32_t> skin_{0};
    std::atomic<std::uint64_t> skin_until_ms_{0};

    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};
    /// Set once, never cleared: a stop that has been asked for stays asked for,
    /// so a loop that checks it after the request still sees it.
    std::atomic<bool> stopping_{false};
};

}  // namespace brownie::app
