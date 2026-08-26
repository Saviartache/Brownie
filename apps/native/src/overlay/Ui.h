// What the overlay draws.
//
// **Stock ImGui.** No theme, no colour, no font — the rule is stated in
// `Overlay.h` and this is where it has to be kept. Layout is fair game: padding,
// spacing, widths, table and window flags. Colour is not.
//
// A custom widget is allowed when ImGui has no equivalent, and `StatusDot` is
// the worked example: it draws with `ImDrawList`, takes every colour from
// `ImGuiCol_*` and every metric from the current font and style, and so it
// inherits whatever theme is active instead of drifting from the widgets beside
// it the moment anything changes.
//
// Drawing runs on the render thread, once per frame. The model is a snapshot the
// caller prepares — nothing here reaches back into the game or the link, because
// a frame is not a place to wait for anything.

#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "overlay/Inspector.h"

namespace brownie::overlay {

/// One row of the offset report. Mirrors `game::OffsetTable::Entry`, flattened:
/// the UI should not have to know how resolution works to display its outcome.
struct OffsetRow {
    std::string key;
    bool resolved = false;
    /// "exact name", "recovered by alias", "recovered by fingerprint", or why
    /// it failed. Already a sentence — the UI does not translate.
    std::string detail;
    std::uint32_t offset = 0;
    /// A method's entry point. Kept apart from `offset` because the two are not
    /// the same kind of number and showing one in place of the other made every
    /// resolved method read as `0x0` — a resolution that looked like a failure.
    void* address = nullptr;
    bool is_method = false;
};

/// What the runtime last said about the game world.
///
/// Integers, in the units the wire carries them: the record is numbers only so
/// that reading it is a split and a parse rather than a decoder. Positions
/// arrive as hundredths of a tile.
struct WorldStatus {
    bool known = false;
    int hp = 0;
    int max_hp = 0;
    int x_hundredths = 0;
    int y_hundredths = 0;
    int entities = 0;
    int shots = 0;
    /// Kept apart from the value, because a runtime older than this build sends
    /// no defence at all and "unknown" is not the same claim as "zero".
    bool defense_known = false;
    int defense = 0;
    /// Announced shots, and the two reasons one does not get tracked. A dodge
    /// with nothing in flight to avoid looks exactly like a broken dodge; these
    /// are what tells the two apart.
    bool shot_stats_known = false;
    int shots_announced = 0;
    int shots_no_owner = 0;
    int shots_no_definition = 0;
    /// Area effects on their way down, and how the telegraph that predicted
    /// them compared against the detonation that followed. The `SHOWEFFECT`
    /// body was recovered from the game's own metadata rather than stated by
    /// it, so confirmations are the only proof the decode is still right after
    /// a patch — see `overlay/WorldStatusStage.ts`.
    bool blast_stats_known = false;
    int blasts = 0;
    int blasts_confirmed = 0;
    int blasts_unmatched = 0;
};

/// The item in the weapon slot, as the game's own data describes it.
///
/// **Shown for checking, and nothing here decides anything.** The dodge planner
/// keeps the player inside their weapon's reach, and that reach is read out of a
/// 35 MB file nobody looks at — so a range that behaves oddly needs the name it
/// was read for beside it. `described` separates "the data files do not have
/// this item" from "the item's numbers are wrong", which look identical from
/// the outside and want opposite fixes.
struct WeaponStatus {
    bool known = false;
    /// False when the catalog has no entry: the type is still worth showing.
    bool described = false;
    std::string name;
    int object_type = -1;
    /// Tiles a second, in hundredths, like every other distance on this wire.
    int speed_hundredths = 0;
    int lifetime_ms = 0;
    /// How far one shot gets before it expires, in hundredths of a tile.
    int range_hundredths = 0;
};

/// What sort of control a setting is drawn as.
enum class SettingKind : std::uint8_t {
    kBoolean,
    kNumber,
    kRange,
    kSelect,
    kMultiSelect,
    kText,
    kColour,
    kButton,
};

/// One choice of a select or multi-select, as it is shown and as it is sent back.
struct SettingOption {
    std::string label;
    std::string value;
};

/// One setting of one plugin, exactly as the runtime described it.
///
/// Nothing here is interpreted beyond what drawing needs. The runtime owns
/// every value and every bound; this is a description of a control, not a
/// second copy of the setting.
struct SettingRow {
    std::string key;
    std::string label;
    SettingKind kind = SettingKind::kText;
    /// The type the runtime wants echoed back: `b`, `n` or `s`. Carried rather
    /// than derived from the kind, so it survives a kind this build predates.
    std::string value_type;
    /// The value as it arrived, and as it goes back.
    std::string value;
    /// The same value as a number, for the widgets that need one. Meaningful
    /// only for the numeric kinds, which are the only ones that read it.
    float number = 0.0F;
    bool has_min = false;
    float min = 0.0F;
    bool has_max = false;
    float max = 0.0F;
    float step = 0.0F;
    /// Drawn under a separate heading, so a busy plugin's everyday controls are
    /// not buried among the ones nobody changes.
    bool advanced = false;
    std::vector<SettingOption> options;
    std::string group;
    /// The setting this one depends on, and the values of it that reveal it.
    /// Empty when it is always shown.
    std::string visible_key;
    std::vector<std::string> visible_values;
};

/// One key a plugin offers, as the runtime described it.
struct BindRow {
    /// Which of the plugin's switches this key moves. Empty is its own, and it
    /// is what identifies the bind everywhere — stored, drawn and reported.
    std::string slot;
    /// What to call it on screen. The runtime names it; this build never has to
    /// know what a plugin's second key is for.
    std::string label;
    /// `toggle` or `hold`, as the runtime spells it. Carried rather than turned
    /// into an enum, so a mode this build predates travels back unchanged
    /// instead of being rewritten to one it happens to know.
    std::string mode;
    /// The key, as the module itself named it, or empty when nothing is bound.
    std::string key;
};

/// One plugin, as the runtime described it.
struct PluginRow {
    std::string id;
    std::string name;
    std::string category;
    /// What the host says it is: discovered, loaded, enabled, failed.
    std::string state;
    /// Why it failed, or empty.
    std::string error;
    bool enabled = false;
    /// Whether switching it on would do anything. False only for a plugin
    /// whose `setup` threw — one switched off for failing handlers is still
    /// worth offering a retry, and its toggle stays live.
    bool enableable = true;
    /// The keys the runtime offers for this plugin. Empty for most of them, and
    /// the difference between a bind nobody has set and a plugin that has no
    /// bind to set.
    std::vector<BindRow> binds;
    std::vector<SettingRow> settings;
};

/// What the module read out of the game's own memory.
///
/// Drawn beside {@link WorldStatus}, which came from the server. That is the
/// point of it: two independent sources of the same number, and an offset is
/// trustworthy exactly while they agree. A single source cannot tell you it is
/// reading the right address.
struct MemoryReading {
    bool known = false;
    std::int32_t hp = 0;
    std::int32_t max_hp = 0;
    /// Kept apart from the value: the field the metadata calls defence does not
    /// hold it, and until the real one is located there is nothing to say.
    bool defense_known = false;
    std::int32_t defense = 0;
    float x = 0.0F;
    float y = 0.0F;
    /// Whether the stat block's displacement has been measured, and by how
    /// much. Shown because a number read at a measured distance and one read
    /// where the metadata said are not equally well understood.
    bool calibrated = false;
    std::uint32_t shift = 0;
    /// Why there is nothing, when there is nothing. Already a sentence.
    std::string trouble;
};

/// Everything the overlay shows, as of the frame it was prepared for.
struct OverlayModel {
    WorldStatus world;
    WeaponStatus weapon;
    MemoryReading memory;
    std::vector<PluginRow> plugins;
    /// How many plugin syncs the runtime has published. The overlay watches it
    /// to know when an interaction it sent has been answered.
    std::uint64_t controls_version = 0;
    bool link_connected = false;
    bool game_bound = false;
    /// Whether the `connect` detour is in place, kept apart from how many
    /// connections it has caught: "installed but never fired" and "never
    /// installed" are different problems that look identical without both.
    bool redirect_installed = false;
    std::uint32_t redirected = 0;
    /// Every IPv4 connection the hook saw, and the port of the last one it let
    /// through. Together these say whether "0 redirected" means the game has
    /// not dialled yet or dialled somewhere else.
    std::uint32_t connects_seen = 0;
    std::uint16_t last_other_port = 0;
    /// The scene features: whether each has what it needs, and how much it has
    /// done. Filled by the frame rather than published with the rest of the
    /// model — the counters change on every repaint, and a model republished
    /// for them would copy a vector of offsets each time.
    ///
    /// Every one of them is switched on from the runtime, so what the switch
    /// says is shown here too: without it a detour that is in and doing nothing
    /// is indistinguishable from a plugin nobody enabled.
    bool tint_wanted = false;
    bool tint_installed = false;
    std::uint32_t tinted = 0;
    bool collision_bound = false;
    std::uint32_t collisions_written = 0;
    /// What the player's collision circle is being scaled by, or nothing while
    /// the game's own value is in place. The number rather than a flag: which
    /// end of the plugin's slider is in the game is what the panel is for.
    std::optional<float> collision_scale;
    /// Whether the projectile collision detours are in place, and how many
    /// shots have been let through a wall. A switch that is on and a feature
    /// that is working look identical without a count, and this one cannot be
    /// installed until the game has built a projectile — so "waiting" is a
    /// state worth telling apart from "broken".
    bool shot_noclip_wanted = false;
    bool shot_noclip_installed = false;
    std::uint32_t shots_passed = 0;
    bool walk_noclip_wanted = false;
    std::uint32_t walks_allowed = 0;
    /// How many walkability predicates are detoured.
    std::size_t walk_gates = 0;
    /// The game's own floating text: whether the detours are in, and how many
    /// lines of ours have gone out through them.
    bool text_installed = false;
    std::uint32_t texts_shown = 0;
    /// Whether the camera can be asked where things are, which is what the
    /// markers are drawn from. False until the engine's own classes turn up,
    /// and the difference between "nothing to draw" and "cannot draw".
    bool camera_bound = false;
    /// Whether the module is pointing the player's shots anywhere right now,
    /// and how many it has pointed. Filled by the frame rather than published
    /// with the rest of the model, for the reason the counters above give: an
    /// aim lasts a few hundred milliseconds and the model is republished four
    /// times a second.
    bool aim_live = false;
    bool aim_installed = false;
    std::uint32_t aim_redirected = 0;
    /// How many shot paths the runtime is currently describing. Zero while the
    /// switch is off, and also while nothing is in flight — which is why the
    /// line beside it says which of those it is.
    int trails_drawn = 0;
    std::string status;
    std::uint32_t dropped_input = 0;
    /// Interactions lost because the runtime stopped reading. Kept apart from
    /// dropped input: one means the render thread stalled, the other means the
    /// link did, and they are fixed in different places.
    std::uint32_t dropped_actions = 0;
    std::vector<OffsetRow> offsets;
};

/// One overlay interaction, on its way back to the runtime.
///
/// Taken as a sink rather than sent from here: drawing runs on the render
/// thread and the pipe belongs to the IPC thread, so a frame hands the action
/// over and returns. See `Engine::DrawFrame`.
using ActionSink = std::function<void(std::string action)>;

/// The one piece of state the overlay keeps, and only because it must.
///
/// The runtime owns every value and answers over a pipe, so between a click and
/// the sync that confirms it the model still holds the old value. Drawing that
/// would make every control flick back to where it was before settling there
/// again — and a slider would fight the cursor, because a world update
/// republishes the model four times a second while the drag is still going.
///
/// So the control being interacted with is held here until a sync newer than
/// the one it was sent against arrives. One at a time, because a person can
/// only touch one widget at a time.
struct PendingEdit {
    /// How much text a text setting may hold on screen. Longer values are
    /// shown and sent truncated rather than silently corrupted.
    static constexpr std::size_t kTextCapacity = 256;

    std::string plugin_id;
    std::string key;
    float number = 0.0F;
    std::array<char, kTextCapacity> text{};
    bool holding = false;
    /// The controls version this was sent against, once it has been sent.
    std::uint64_t sent_at_version = 0;
    bool sent = false;

    [[nodiscard]] bool Holds(std::string_view id, std::string_view setting_key) const noexcept {
        return holding && plugin_id == id && key == setting_key;
    }

    void Hold(std::string_view id, std::string_view setting_key);
    void SetText(std::string_view value) noexcept;
    [[nodiscard]] std::string_view TextView() const noexcept;
    void Sent(std::uint64_t version) noexcept;
    void Clear() noexcept;
};

/// What the user has typed into the inspector's filter, and which row they
/// picked.
///
/// The filtered index list is rebuilt only when the text changes, not once a
/// frame: three thousand substring searches per frame to draw thirty visible
/// rows is work nobody asked for.
struct InspectorInput {
    static constexpr std::size_t kCapacity = 128;
    /// Its own window, off by default. The list and its detail are taller than
    /// everything else put together, and a panel that pushes the world and the
    /// offsets off the bottom of the screen is in the way rather than to hand.
    bool open = false;
    std::array<char, kCapacity> filter{};
    /// Indices into the report's class list that match the filter.
    std::vector<int> matches;
    /// Which row is highlighted, by position rather than by name: the image
    /// holds dozens of classes all called `<>c`, so a name identifies nothing.
    int selected_index = -1;
    /// The filter the matches were built for, and the report they indexed —
    /// either changing invalidates them.
    std::string matched_filter;
    const void* matched_report = nullptr;
    bool matched = false;

    void Invalidate() noexcept {
        matched = false;
        selected_index = -1;
        matches.clear();
        matches.shrink_to_fit();
    }
};

/// A multi-select's search text, keyed by "pluginId\0settingKey".
///
/// View state, never a setting: it filters which options a long checklist shows
/// and changes nothing on the wire, so it is held here rather than sent to the
/// runtime — a search that reached across the link would be one that stopped
/// working the moment the link did. See `DrawMultiSelect`.
using MultiSelectFilters = std::unordered_map<std::string, std::string>;

/// A bind waiting for the player to press something.
///
/// View state, never a value: a prompt is not on the wire, and the runtime has
/// no opinion about one being open. It is also the one place the overlay reads
/// the keyboard directly rather than through ImGui — the point of a bind is the
/// *physical* key, and ImGui reports the character a layout made of it. See
/// `core/KeyChord.h`.
///
/// One at a time, like {@link PendingEdit}, because a person can only press one
/// key at a time.
struct BindCapture {
    std::string plugin_id;
    /// Which of that plugin's keys is being bound. A plugin can offer more than
    /// one, and a prompt that named only the plugin would settle whichever row
    /// was drawn last.
    std::string slot;
    /// The mode the bind was in when the prompt opened, so finishing it changes
    /// the key and nothing else.
    std::string mode;
    /// Whether a prompt is open at all. Its own flag because neither of the two
    /// above can be empty *and* absent: a plugin's own switch is the empty slot.
    bool open = false;

    [[nodiscard]] bool waiting(std::string_view id, std::string_view bind_slot) const noexcept {
        return open && plugin_id == id && slot == bind_slot;
    }

    void Begin(std::string_view id, std::string_view bind_slot, std::string_view bind_mode) {
        plugin_id.assign(id);
        slot.assign(bind_slot);
        mode.assign(bind_mode);
        open = true;
    }

    void Clear() noexcept {
        plugin_id.clear();
        slot.clear();
        mode.clear();
        open = false;
    }
};

/// The overlay's own state — everything it holds that the runtime does not.
struct UiState {
    PendingEdit edit;
    BindCapture capture;
    InspectorInput inspector;
    MultiSelectFilters multi_filters;

    /// Whether to draw where the module is walking, and where it is pointing
    /// the player's shots, over the map itself.
    ///
    /// **Held by the overlay rather than by the runtime**, unlike everything
    /// under Plugins: they change nothing on the wire, they do nothing to the
    /// game at all, and a switch that could only be reached over a link that
    /// has to be up would be one nobody could use to find out why the link is
    /// down. See `WorldMarkers.h`.
    bool movement_markers = false;
    bool aim_markers = false;
    /// Whether to draw what the dodge planner is thinking over the map: every
    /// shot's remaining path, and the distances it is reasoning about.
    ///
    /// **The one switch in this list the runtime hears about**, and it has to:
    /// what it turns on is a prediction only the runtime can make, so ticking
    /// the box asks for it and unticking it stops the traffic. See
    /// `Engine::PublishDodgeView` and `DodgePicture.h`.
    bool dodge_markers = false;
};

/// Draws the whole overlay. Call between `NewFrame` and `Render`.
///
/// `report` is null until the inspector has been asked for something, and
/// becomes null again when it is cleared. Passed beside the model rather than
/// inside it because it is large, changes rarely, and the model is republished
/// four times a second — see `Inspector.h`.
void Draw(const OverlayModel& model, const std::shared_ptr<const InspectorReport>& report,
          UiState& state, const ActionSink& emit);

}  // namespace brownie::overlay
