#include "overlay/Ui.h"

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>

#include <imgui.h>

#include "overlay/ControlRecord.h"

namespace brownie::overlay {
namespace {

// **Every string drawn here is ASCII.** The overlay uses ImGui's built-in font,
// which carries no glyph outside it, so an em dash or a typographic quote comes
// out as a question mark on screen. Comments may say what they like; anything
// that reaches `Text`, `TextUnformatted` or a format string may not.

/// A small filled circle showing an on/off state.
///
/// ImGui has no state indicator this size, so it is drawn — and drawn the way
/// the rule requires: the colour comes from `ImGuiCol_CheckMark` and
/// `ImGuiCol_TextDisabled`, the size from the current font. Change the theme and
/// this changes with it. A literal colour here would be the first thing to look
/// wrong under any theme but the one it was picked against.
void StatusDot(bool on) {
    const float extent = ImGui::GetTextLineHeight();
    const ImVec2 origin = ImGui::GetCursorScreenPos();
    const ImVec2 centre{origin.x + extent * 0.5F, origin.y + extent * 0.5F};

    ImGui::GetWindowDrawList()->AddCircleFilled(
        centre, extent * 0.25F,
        ImGui::GetColorU32(on ? ImGuiCol_CheckMark : ImGuiCol_TextDisabled));

    // Advances the cursor and registers the bounds, so the next item lays out
    // as it would after any other widget.
    ImGui::Dummy(ImVec2{extent, extent});
}

void DrawOffsets(const std::vector<OffsetRow>& offsets) {
    if (offsets.empty()) {
        ImGui::TextDisabled("nothing resolved yet");
        return;
    }

    // No count above the table. Each row already carries a dot saying whether
    // it resolved, and a summary of what the rows underneath it say is a second
    // thing to keep in step with the first.
    constexpr ImGuiTableFlags kFlags = ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg |
                                       ImGuiTableFlags_SizingStretchProp |
                                       ImGuiTableFlags_ScrollY;
    // Height for about ten rows; the rest scrolls rather than growing a window
    // over the game.
    const ImVec2 size{0.0F, ImGui::GetTextLineHeightWithSpacing() * 10.0F};
    if (!ImGui::BeginTable("offsets", 3, kFlags, size)) {
        return;
    }

    ImGui::TableSetupColumn("key", ImGuiTableColumnFlags_WidthStretch, 2.0F);
    ImGui::TableSetupColumn("offset", ImGuiTableColumnFlags_WidthStretch, 1.0F);
    ImGui::TableSetupColumn("how", ImGuiTableColumnFlags_WidthStretch, 3.0F);
    ImGui::TableSetupScrollFreeze(0, 1);
    ImGui::TableHeadersRow();

    for (const auto& row : offsets) {
        ImGui::TableNextRow();

        ImGui::TableNextColumn();
        StatusDot(row.resolved);
        ImGui::SameLine();
        ImGui::TextUnformatted(row.key.c_str());

        ImGui::TableNextColumn();
        if (!row.resolved) {
            ImGui::TextDisabled("-");
        } else if (row.is_method) {
            // An address, not an offset. The two are different kinds of number
            // and printing one as the other made every resolved method look
            // like a failure at `0x0`.
            ImGui::Text("%p", row.address);
        } else {
            ImGui::Text("0x%X", row.offset);
        }

        ImGui::TableNextColumn();
        ImGui::TextUnformatted(row.detail.c_str());
    }

    ImGui::EndTable();
}

/// Everything the World and Offsets panels show, as JSON, onto the clipboard.
///
/// It exists so that reporting what is on screen costs a paste rather than a
/// screenshot. Built by hand because the alternative is a JSON library in a
/// module that has no other use for one, and because the shape is fixed: every
/// value below is a number, a bool, or a string this file wrote itself, so
/// there is nothing here that needs escaping.
void CopyStateAsJson(const OverlayModel& model) {
    std::string out;
    out.reserve(1024);
    char line[256]{};

    const auto append = [&out, &line](const char* format, auto... value) {
        std::snprintf(line, sizeof(line), format, value...);
        out.append(line);
    };

    out.append("{\n  \"server\": ");
    if (!model.world.known) {
        out.append("null");
    } else {
        append(
            "{ \"hp\": %d, \"maxHp\": %d, \"defense\": %s, \"x\": %.2f, \"y\": %.2f,"
            " \"entities\": %d, \"shotsInFlight\": %d",
            model.world.hp, model.world.max_hp,
            model.world.defense_known ? std::to_string(model.world.defense).c_str() : "null",
            static_cast<double>(model.world.x_hundredths) / 100.0,
            static_cast<double>(model.world.y_hundredths) / 100.0, model.world.entities,
            model.world.shots);
        if (model.world.shot_stats_known) {
            append(", \"shotsAnnounced\": %d, \"shotsNoOwner\": %d, \"shotsNoDefinition\": %d",
                   model.world.shots_announced, model.world.shots_no_owner,
                   model.world.shots_no_definition);
        }
        out.append(" }");
    }

    out.append(",\n  \"client\": ");
    if (!model.memory.known) {
        // The reason, not just the absence. "Nothing here" and "nothing here
        // because there is no world right now" are different reports.
        append("{ \"trouble\": \"%s\" }", model.memory.trouble.c_str());
    } else {
        append("{ \"x\": %.2f, \"y\": %.2f, \"calibrated\": %s", static_cast<double>(model.memory.x),
               static_cast<double>(model.memory.y), model.memory.calibrated ? "true" : "false");
        if (model.memory.calibrated) {
            append(", \"hp\": %d, \"maxHp\": %d, \"statShift\": %u", model.memory.hp,
                   model.memory.max_hp, model.memory.shift);
        }
        if (model.memory.defense_known) {
            append(", \"defense\": %d", model.memory.defense);
        }
        out.append(" }");
    }

    // What each feature has actually done. On the clipboard as well as on
    // screen, for the same reason the offsets are: a report of what resolved
    // says nothing about whether the thing built on it moved, and those two
    // facts are read together or not at all.
    out.append(",\n  \"scene\": ");
    append(
        "{ \"tintInstalled\": %s, \"tinted\": %u, \"collisionBound\": %s, \"collisionsCleared\": %u,"
        " \"shotNoclipInstalled\": %s, \"shotsPassed\": %u, \"noclipWanted\": %s,"
        " \"walkGates\": %d, \"walksAllowed\": %u, \"textInstalled\": %s, \"textsShown\": %u }",
        model.tint_installed ? "true" : "false", model.tinted,
        model.collision_bound ? "true" : "false", model.collisions_cleared,
        model.shot_noclip_installed ? "true" : "false", model.shots_passed,
        model.walk_noclip_wanted ? "true" : "false", static_cast<int>(model.walk_gates),
        model.walks_allowed, model.text_installed ? "true" : "false", model.texts_shown);

    out.append(",\n  \"offsets\": [");
    for (std::size_t i = 0; i < model.offsets.size(); ++i) {
        const OffsetRow& row = model.offsets[i];
        out.append(i == 0 ? "\n    " : ",\n    ");
        append("{ \"key\": \"%s\", \"resolved\": %s, ", row.key.c_str(),
               row.resolved ? "true" : "false");
        if (!row.resolved) {
            out.append("\"at\": null, ");
        } else if (row.is_method) {
            append("\"at\": \"%p\", ", row.address);
        } else {
            append("\"at\": \"0x%X\", ", row.offset);
        }
        append("\"how\": \"%s\" }", row.detail.c_str());
    }
    out.append(model.offsets.empty() ? "]" : "\n  ]");
    out.append("\n}\n");

    ImGui::SetClipboardText(out.c_str());
}

/// The labels the scene panel puts in its left column.
///
/// Named once and used twice: to draw each line, and to work out where the
/// values start. A label written only at its call site would be laid out under
/// the widest of *these* — which is how a value ends up printed over the label
/// beside it, and it is not a thing a font size can be guessed around.
constexpr const char* kTintStatus = "Health bar tint";
constexpr const char* kHitboxStatus = "No hitbox";
constexpr const char* kShotWallStatus = "Shots pass walls";
constexpr const char* kMarkerStatus = "Show where we are walking";
constexpr const char* kAimMarkerStatus = "Show where we are aiming";
constexpr const char* kDodgeMarkerStatus = "Show where we are dodging";
constexpr const char* kNoclipStatus = "Player noclip";
constexpr const char* kTextStatus = "Floating text";

constexpr const char* kSceneStatuses[] = {kTintStatus,      kHitboxStatus,       kShotWallStatus,
                                          kMarkerStatus,    kAimMarkerStatus,    kDodgeMarkerStatus,
                                          kNoclipStatus,    kTextStatus};

/// Where the value column starts: past the longest label there is, and a
/// couple of characters clear of it.
///
/// Measured rather than declared, so it follows the theme's font instead of
/// being right for the one it was picked against.
[[nodiscard]] float StatusColumn() {
    float widest = 0.0F;
    for (const char* label : kSceneStatuses) {
        widest = std::max(widest, ImGui::CalcTextSize(label).x);
    }
    return widest + ImGui::GetFontSize() * 2.0F;
}

/// One "what this is - what it is doing" line, with the value at `column`.
void StatusLine(float column, const char* label, const char* format, ...) IM_FMTARGS(3);

void StatusLine(float column, const char* label, const char* format, ...) {
    ImGui::TextDisabled("%s", label);
    ImGui::SameLine(column);
    ImGui::TextDisabled("-");
    ImGui::SameLine();

    va_list args;
    va_start(args, format);
    ImGui::TextV(format, args);
    va_end(args);
}

/// What the module changes about the game, and what each change has done.
///
/// **Every switch first, then every count.** They are two different jobs: one
/// is done with the mouse and once, the other is read while playing — and
/// interleaving them puts the control you are looking for behind however many
/// lines of numbers happen to sit above it. A separator between the two, and
/// the counts as one column that can be read down.
///
/// The counts are the point of the panel. A switch that is on and a feature
/// that is working look identical without them — the bar the tint holds is one
/// the player may not be looking at, and a collision radius nobody walks into
/// says nothing at all.
void DrawScene(const OverlayModel& model, UiState& state) {
    ImGui::Checkbox("Health bar tint", &state.health_bar_tint);
    if (state.health_bar_tint) {
        // Only while the switch is on, and indented under it: a colour for a
        // feature that is off is a control that does nothing. It stays up here
        // with the switches, because it is one.
        //
        // `ColorEdit4` rather than a set of sliders because ImGui already has
        // the widget, and it is the one place in this overlay where a colour is
        // the subject rather than the styling — the rule in `Overlay.h` is that
        // nothing here *paints itself* in colours of its own choosing.
        ImGui::Indent();
        ImGui::ColorEdit4("Colour", state.tint_colour.data(),
                          ImGuiColorEditFlags_AlphaBar | ImGuiColorEditFlags_AlphaPreviewHalf);
        ImGui::Unindent();
    }

    // Named for what it does to the player rather than for the field it writes:
    // "no collision" read as walking through walls, which is not what zeroing
    // the collision radius does. What it stops is what the client decides by
    // that radius, and the one people notice is area damage.
    ImGui::Checkbox("No hitbox", &state.no_hitbox);
    ImGui::Checkbox("Shots pass walls", &state.shots_pass_walls);
    // The two switches here that change nothing about the game — they draw over
    // it. Grouped with the rest anyway, because what they draw is what the lines
    // below describe in numbers.
    ImGui::Checkbox("Show where we are walking", &state.movement_markers);
    ImGui::Checkbox("Show where we are aiming", &state.aim_markers);
    // The third of them, and the only one that costs anything on the wire: it
    // asks the runtime to keep sending what it predicts about every shot.
    ImGui::Checkbox("Show where we are dodging", &state.dodge_markers);

    ImGui::Separator();

    const float column = StatusColumn();

    if (!state.health_bar_tint) {
        StatusLine(column, kTintStatus, "off");
    } else if (!model.tint_installed) {
        StatusLine(column, kTintStatus, "waiting for Graphic::set_color");
    } else {
        StatusLine(column, kTintStatus, "%u call(s) recoloured", model.tinted);
    }

    if (!state.no_hitbox) {
        StatusLine(column, kHitboxStatus, "off");
    } else if (!model.collision_bound) {
        StatusLine(column, kHitboxStatus, "waiting for the map data classes");
    } else {
        StatusLine(column, kHitboxStatus, "%u pass(es) applied", model.collisions_cleared);
    }

    if (!state.shots_pass_walls) {
        StatusLine(column, kShotWallStatus, "off");
    } else if (!model.shot_noclip_installed) {
        // Not a failure. The game builds the projectile class the first time
        // something shoots, so this is what the switch says until it has.
        StatusLine(column, kShotWallStatus, "waiting for the projectile class - fire a shot");
    } else {
        StatusLine(column, kShotWallStatus, "%u shot(s) let through", model.shots_passed);
    }

    if (!state.movement_markers) {
        StatusLine(column, kMarkerStatus, "off");
    } else if (!model.camera_bound) {
        StatusLine(column, kMarkerStatus, "waiting for the camera - enter a map");
    } else {
        StatusLine(column, kMarkerStatus, "over the map");
    }

    // Three things can be true here and they are different problems: the switch
    // is off, the camera cannot be asked where to draw, or nothing is being
    // aimed at — which is the ordinary state between fights and not a fault.
    if (!state.aim_markers) {
        StatusLine(column, kAimMarkerStatus, "off");
    } else if (!model.camera_bound) {
        StatusLine(column, kAimMarkerStatus, "waiting for the camera - enter a map");
    } else if (!model.aim_live) {
        StatusLine(column, kAimMarkerStatus, "no aim right now, %u shot(s) pointed so far",
                   model.aim_redirected);
    } else if (!model.aim_installed) {
        // A crosshair over an aim nothing acts on. Worth its own line: the
        // drawing looks identical to the working case.
        StatusLine(column, kAimMarkerStatus, "aiming, but no detour is in - shots go their own way");
    } else {
        StatusLine(column, kAimMarkerStatus, "over the map, %u shot(s) pointed",
                   model.aim_redirected);
    }

    // Four things can be true, and they are four different problems: the switch
    // is off, the camera cannot say where to draw, the runtime is not answering
    // — which is what a link that is down or a plugin that is off looks like
    // from here — or there is simply nothing in the air, which is the ordinary
    // state outside a fight.
    if (!state.dodge_markers) {
        StatusLine(column, kDodgeMarkerStatus, "off");
    } else if (!model.camera_bound) {
        StatusLine(column, kDodgeMarkerStatus, "waiting for the camera - enter a map");
    } else if (model.trails_drawn == 0) {
        StatusLine(column, kDodgeMarkerStatus, "nothing in flight");
    } else {
        StatusLine(column, kDodgeMarkerStatus, "over the map, %d shot(s)", model.trails_drawn);
    }

    // Read-only, and the only feature here that is. Player noclip is switched
    // on from the runtime, because the half of it that stops the server pulling
    // the player back is packets — and a switch here would turn on the half
    // that does not work alone. What is left to show is whether it arrived and
    // whether it is doing anything.
    if (model.walk_gates == 0) {
        StatusLine(column, kNoclipStatus, "waiting for the world manager - enter a map");
    } else if (!model.walk_noclip_wanted) {
        StatusLine(column, kNoclipStatus, "off from the runtime, %d gate(s) watched",
                   static_cast<int>(model.walk_gates));
    } else {
        StatusLine(column, kNoclipStatus, "%u answer(s) forced across %d gate(s)",
                   model.walks_allowed, static_cast<int>(model.walk_gates));
    }

    if (!model.text_installed) {
        StatusLine(column, kTextStatus, "not resolved");
    } else {
        StatusLine(column, kTextStatus, "%u line(s) shown", model.texts_shown);
    }
}

/// The world, from both sides at once.
///
/// One table, two value columns: what the server said and what the module read
/// out of the game. No verdict row — a reader comparing two numbers on the same
/// line does not need to be told whether they match, and a verdict is one more
/// thing that has to stay true.
///
/// A blank in the client column means the module has nothing to say about that
/// row, either because it does not read it at all or because the stat block has
/// not been located yet. Blank rather than a zero: those are different claims.
void DrawWorld(const OverlayModel& model) {
    // Above the table, and it copies the offsets too: what gets reported is
    // both panels together, because a value and the offset it came from are one
    // piece of evidence.
    if (ImGui::Button("Copy")) {
        CopyStateAsJson(model);
    }

    if (!model.world.known) {
        ImGui::TextDisabled("no session yet");
        return;
    }

    constexpr ImGuiTableFlags kFlags =
        ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg | ImGuiTableFlags_SizingStretchProp;
    if (!ImGui::BeginTable("world", 3, kFlags)) {
        return;
    }
    ImGui::TableSetupColumn("", ImGuiTableColumnFlags_WidthStretch, 2.0F);
    ImGui::TableSetupColumn("server", ImGuiTableColumnFlags_WidthStretch, 2.0F);
    ImGui::TableSetupColumn("client", ImGuiTableColumnFlags_WidthStretch, 2.0F);
    ImGui::TableHeadersRow();

    const auto row = [](const char* label, const char* server, const char* client) {
        ImGui::TableNextRow();
        ImGui::TableNextColumn();
        ImGui::TextDisabled("%s", label);
        ImGui::TableNextColumn();
        ImGui::TextUnformatted(server);
        ImGui::TableNextColumn();
        if (client[0] != '\0') {
            ImGui::TextUnformatted(client);
        }
    };

    // Fixed buffers rather than strings: this runs once a frame, and a handful
    // of allocations to draw five rows is a handful nobody needs.
    char server[48]{};
    char client[48]{};
    const bool stats = model.memory.known && model.memory.calibrated;

    std::snprintf(server, sizeof(server), "%d / %d", model.world.hp, model.world.max_hp);
    if (stats) {
        std::snprintf(client, sizeof(client), "%d / %d", model.memory.hp, model.memory.max_hp);
    } else {
        client[0] = '\0';
    }
    row("health", server, client);

    if (model.world.defense_known) {
        std::snprintf(server, sizeof(server), "%d", model.world.defense);
    } else {
        server[0] = '\0';
    }
    if (model.memory.defense_known) {
        std::snprintf(client, sizeof(client), "%d", model.memory.defense);
    } else {
        client[0] = '\0';
    }
    row("defense", server, client);

    // Reassembled from hundredths here rather than sent as text: the wire stays
    // integers, and the one place that needs a decimal point is the one that
    // draws it.
    std::snprintf(server, sizeof(server), "%.2f, %.2f",
                  static_cast<double>(model.world.x_hundredths) / 100.0,
                  static_cast<double>(model.world.y_hundredths) / 100.0);
    if (model.memory.known) {
        std::snprintf(client, sizeof(client), "%.2f, %.2f", static_cast<double>(model.memory.x),
                      static_cast<double>(model.memory.y));
    } else {
        client[0] = '\0';
    }
    row("position", server, client);

    std::snprintf(server, sizeof(server), "%d", model.world.entities);
    row("entities", server, "");
    std::snprintf(server, sizeof(server), "%d", model.world.shots);
    row("shots in flight", server, "");

    // Only when a shot has been announced and none of it reached the planner.
    // A dodge starved of data looks exactly like a broken one, and this is the
    // line that separates them — shown when it has something to say and not
    // otherwise.
    if (model.world.shot_stats_known && model.world.shots_announced != 0) {
        std::snprintf(server, sizeof(server), "%d announced", model.world.shots_announced);
        std::snprintf(client, sizeof(client), "%d no owner, %d no definition",
                      model.world.shots_no_owner, model.world.shots_no_definition);
        row("shots dropped", server, client);
    }

    ImGui::EndTable();

    // Only when there is something the matter. An empty client column with no
    // explanation is a question; this is the answer to it.
    if (!model.memory.known && !model.memory.trouble.empty()) {
        ImGui::TextDisabled("%s", model.memory.trouble.c_str());
    }
}

/// The pending-edit key standing for a plugin's own on/off switch.
///
/// Empty because that switch is not one of the plugin's settings and so needs a
/// name none of them can have. A plugin that declared a setting with an empty
/// key would share the slot; the cost of that is one frame of stale display on
/// a plugin nobody has written.
constexpr std::string_view kEnabledKey{};

std::string FormatNumber(float value) {
    char text[32]{};
    std::snprintf(text, sizeof(text), "%.6g", static_cast<double>(value));
    return text;
}

/// How many decimals to draw a numeric setting with, taken from the step it
/// was declared to move in.
const char* NumberFormat(float step) {
    if (step <= 0.0F) return "%.2f";
    if (step >= 1.0F) return "%.0f";
    if (step >= 0.1F) return "%.1f";
    return "%.3f";
}

/// Rounds to the nearest multiple of the declared step.
///
/// The runtime clamps but deliberately does not snap — `step` is a property of
/// the control, not of the value, and a plugin setting 43 in code means 43. So
/// this belongs here, in the widget that offered the choice.
float SnapToStep(float value, const SettingRow& row) {
    if (row.step <= 0.0F) return value;
    const float origin = row.has_min ? row.min : 0.0F;
    return origin + std::round((value - origin) / row.step) * row.step;
}

/// Whether a setting's `visibleWhen` condition is met.
bool IsVisible(const PluginRow& plugin, const SettingRow& row) {
    if (row.visible_key.empty()) return true;

    for (const SettingRow& other : plugin.settings) {
        if (other.key != row.visible_key) continue;
        for (const std::string& value : row.visible_values) {
            if (other.value == value) return true;
        }
        return false;
    }
    // It depends on a setting that is not there. Showing it is the better of
    // the two mistakes: a control wrongly shown can still be used, while one
    // wrongly hidden cannot be found.
    return true;
}

void SendSetting(const PluginRow& plugin, const SettingRow& row, std::string_view value,
                 const ActionSink& emit) {
    emit(BuildAction("setting", {plugin.id, row.key, row.value_type, value}));
}

void DrawBoolean(const PluginRow& plugin, const SettingRow& row, std::uint64_t version,
                 PendingEdit& edit, const ActionSink& emit) {
    bool value = edit.Holds(plugin.id, row.key) ? edit.number != 0.0F : row.value == "1";
    if (!ImGui::Checkbox(row.label.c_str(), &value)) return;

    edit.Hold(plugin.id, row.key);
    edit.number = value ? 1.0F : 0.0F;
    SendSetting(plugin, row, value ? "1" : "0", emit);
    edit.Sent(version);
}

/// A number with no slider: either it was declared without both bounds, or it
/// is a `number` rather than a `range`.
void DrawNumber(const PluginRow& plugin, const SettingRow& row, std::uint64_t version,
                PendingEdit& edit, const ActionSink& emit) {
    float value = edit.Holds(plugin.id, row.key) ? edit.number : row.number;
    if (ImGui::InputFloat(row.label.c_str(), &value, row.step, row.step * 10.0F,
                          NumberFormat(row.step))) {
        edit.Hold(plugin.id, row.key);
        edit.number = value;
    }
    if (ImGui::IsItemDeactivatedAfterEdit() && edit.Holds(plugin.id, row.key)) {
        SendSetting(plugin, row, FormatNumber(edit.number), emit);
        edit.Sent(version);
    }
}

void DrawRange(const PluginRow& plugin, const SettingRow& row, std::uint64_t version,
               PendingEdit& edit, const ActionSink& emit) {
    if (!row.has_min || !row.has_max) {
        // A slider without both ends is not a slider. Drawn as a plain number
        // rather than against invented bounds, which would look authoritative.
        DrawNumber(plugin, row, version, edit, emit);
        return;
    }

    float value = edit.Holds(plugin.id, row.key) ? edit.number : row.number;
    if (ImGui::SliderFloat(row.label.c_str(), &value, row.min, row.max, NumberFormat(row.step))) {
        edit.Hold(plugin.id, row.key);
        edit.number = SnapToStep(value, row);
    }
    // Sent when the drag ends, not while it runs: one action per change the
    // user meant, rather than one per frame the cursor moved through.
    if (ImGui::IsItemDeactivatedAfterEdit() && edit.Holds(plugin.id, row.key)) {
        SendSetting(plugin, row, FormatNumber(edit.number), emit);
        edit.Sent(version);
    }
}

void DrawSelect(const PluginRow& plugin, const SettingRow& row, std::uint64_t version,
                PendingEdit& edit, const ActionSink& emit) {
    const std::string current =
        edit.Holds(plugin.id, row.key) ? std::string{edit.TextView()} : row.value;

    const char* preview = current.c_str();
    for (const SettingOption& option : row.options) {
        if (option.value == current) {
            preview = option.label.c_str();
            break;
        }
    }

    if (!ImGui::BeginCombo(row.label.c_str(), preview)) return;
    for (const SettingOption& option : row.options) {
        const bool selected = option.value == current;
        if (ImGui::Selectable(option.label.c_str(), selected)) {
            edit.Hold(plugin.id, row.key);
            edit.SetText(option.value);
            SendSetting(plugin, row, option.value, emit);
            edit.Sent(version);
        }
        if (selected) ImGui::SetItemDefaultFocus();
    }
    ImGui::EndCombo();
}

void DrawText(const PluginRow& plugin, const SettingRow& row, std::uint64_t version,
              PendingEdit& edit, const ActionSink& emit) {
    // Seeded from the model every frame, and from the pending edit while one is
    // being typed. ImGui keeps its own buffer for the item it is editing, so
    // re-seeding this one costs nothing and cannot fight the cursor.
    std::array<char, PendingEdit::kTextCapacity> buffer{};
    const std::string_view source =
        edit.Holds(plugin.id, row.key) ? edit.TextView() : std::string_view{row.value};
    const std::size_t length = std::min(source.size(), buffer.size() - 1);
    std::memcpy(buffer.data(), source.data(), length);

    if (ImGui::InputText(row.label.c_str(), buffer.data(), buffer.size())) {
        edit.Hold(plugin.id, row.key);
        edit.SetText(buffer.data());
    }
    if (ImGui::IsItemDeactivatedAfterEdit() && edit.Holds(plugin.id, row.key)) {
        SendSetting(plugin, row, edit.TextView(), emit);
        edit.Sent(version);
    }
}

void DrawSetting(const PluginRow& plugin, const SettingRow& row, std::uint64_t version,
                 PendingEdit& edit, const ActionSink& emit) {
    ImGui::PushID(row.key.c_str());
    switch (row.kind) {
        case SettingKind::kBoolean:
            DrawBoolean(plugin, row, version, edit, emit);
            break;
        case SettingKind::kNumber:
            DrawNumber(plugin, row, version, edit, emit);
            break;
        case SettingKind::kRange:
            DrawRange(plugin, row, version, edit, emit);
            break;
        case SettingKind::kSelect:
            DrawSelect(plugin, row, version, edit, emit);
            break;
        case SettingKind::kText:
            DrawText(plugin, row, version, edit, emit);
            break;
        case SettingKind::kButton:
            if (ImGui::Button(row.label.c_str())) {
                emit(BuildAction("press", {plugin.id, row.key}));
            }
            break;
    }
    ImGui::PopID();
}

/// Draws one plugin's settings, either the everyday ones or the advanced ones.
void DrawSettings(const PluginRow& plugin, bool advanced, std::uint64_t version, PendingEdit& edit,
                  const ActionSink& emit) {
    std::string group;

    for (const SettingRow& row : plugin.settings) {
        if (row.advanced != advanced || !IsVisible(plugin, row)) continue;
        if (row.group != group) {
            group = row.group;
            if (!group.empty()) ImGui::SeparatorText(group.c_str());
        }
        DrawSetting(plugin, row, version, edit, emit);
    }
}

/// Whether opening this plugin would show anything at all.
///
/// Counted rather than assumed: a setting can be hidden by the value of another
/// one, so a plugin with rows in the model may still have nothing to show right
/// now — and one whose `setup` threw has a message instead of settings.
[[nodiscard]] bool HasBody(const PluginRow& plugin) {
    if (!plugin.error.empty()) {
        return true;
    }
    for (const SettingRow& row : plugin.settings) {
        if (IsVisible(plugin, row)) {
            return true;
        }
    }
    return false;
}

void DrawPlugin(const PluginRow& plugin, std::uint64_t version, PendingEdit& edit,
                const ActionSink& emit) {
    bool enabled = edit.Holds(plugin.id, kEnabledKey) ? edit.number != 0.0F : plugin.enabled;

    // Only a plugin whose `setup` threw is out of reach — it registered nothing
    // and switching it on would run nothing. One switched off for failing
    // handlers keeps a live toggle, because pressing it is how the user says
    // "try again", and the alternative was restarting the runtime.
    ImGui::BeginDisabled(!plugin.enableable);
    if (ImGui::Checkbox("##enabled", &enabled)) {
        edit.Hold(plugin.id, kEnabledKey);
        edit.number = enabled ? 1.0F : 0.0F;
        emit(BuildAction("toggle", {plugin.id, enabled ? "1" : "0"}));
        edit.Sent(version);
    }
    ImGui::EndDisabled();
    ImGui::SameLine();

    // **A plugin with nothing to show is not a node to open.** An arrow that
    // opens onto "no settings" is a control that answers a question nobody
    // asked, and half the list is like that. Drawn as a leaf so that the name
    // still lines up with the ones that do open.
    if (!HasBody(plugin)) {
        ImGui::TreeNodeEx("##body",
                          ImGuiTreeNodeFlags_Leaf | ImGuiTreeNodeFlags_NoTreePushOnOpen, "%s",
                          plugin.name.c_str());
        return;
    }

    // Closed until asked for, like everything else here: a plugin's settings
    // are read when they are being changed, which is rarely.
    const bool open = ImGui::TreeNodeEx("##body", ImGuiTreeNodeFlags_None, "%s",
                                        plugin.name.c_str());
    if (!open) return;

    if (!plugin.error.empty()) {
        ImGui::TextWrapped("%s", plugin.error.c_str());
    }
    DrawSettings(plugin, false, version, edit, emit);

    // Visible ones only, by the same rule as the node above: a section that
    // opens onto nothing is worse than no section.
    bool has_advanced = false;
    for (const SettingRow& row : plugin.settings) {
        if (row.advanced && IsVisible(plugin, row)) has_advanced = true;
    }
    if (has_advanced && ImGui::TreeNode("Advanced")) {
        DrawSettings(plugin, true, version, edit, emit);
        ImGui::TreePop();
    }

    ImGui::TreePop();
}

void DrawPlugins(const OverlayModel& model, PendingEdit& edit, const ActionSink& emit) {
    if (model.plugins.empty()) {
        // Two different situations, and the status line above already says which:
        // no runtime connected, or a runtime with an empty plugin directory.
        ImGui::TextDisabled("no plugins loaded");
        return;
    }

    // The mirror hands the list over already grouped, so a heading is due
    // wherever the category changes — no sorting or bucketing per frame.
    const std::string* heading = nullptr;
    for (const PluginRow& plugin : model.plugins) {
        if (heading == nullptr || *heading != plugin.category) {
            heading = &plugin.category;
            ImGui::SeparatorText(plugin.category.c_str());
        }
        ImGui::PushID(plugin.id.c_str());
        DrawPlugin(plugin, model.controls_version, edit, emit);
        ImGui::PopID();
    }
}

/// Rebuilds the filtered index list, but only when it can no longer be right.
///
/// Keyed on the filter text *and* the report's address: a new report means new
/// indices, and stale ones would point into a list that has changed under them.
void RefreshMatches(InspectorInput& inspector, const InspectorReport& report) {
    const std::string_view filter{inspector.filter.data(), std::strlen(inspector.filter.data())};
    if (inspector.matched && inspector.matched_report == &report &&
        inspector.matched_filter == filter) {
        return;
    }

    inspector.matches.clear();
    for (std::size_t i = 0; i < report.classes.size(); ++i) {
        if (filter.empty() || report.classes[i].find(filter) != std::string::npos) {
            inspector.matches.push_back(static_cast<int>(i));
        }
    }
    inspector.matched_filter.assign(filter);
    inspector.matched_report = &report;
    inspector.matched = true;
}

/// What a class touches: the readable type names among its members.
void DrawTouches(const ClassDetail& detail) {
    if (detail.touches.empty()) {
        ImGui::TextDisabled("nothing readable — every type it touches is renamed too");
        return;
    }
    // The point of the panel, for a name that says nothing. Wrapped rather than
    // tabled: it is prose about what the class is for, not data to sort.
    std::string line;
    for (const std::string& type : detail.touches) {
        if (!line.empty()) {
            line.append(", ");
        }
        line.append(type);
    }
    ImGui::TextWrapped("%s", line.c_str());
}

void DrawMembers(const ClassDetail& detail) {
    constexpr ImGuiTableFlags kFlags = ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg |
                                       ImGuiTableFlags_SizingStretchProp |
                                       ImGuiTableFlags_ScrollY;
    // Whatever is left of the window, so the members are the part that grows.
    const ImVec2 size{0.0F, ImGui::GetContentRegionAvail().y};
    if (!ImGui::BeginTable("members", 3, kFlags, size)) {
        return;
    }
    ImGui::TableSetupColumn("at", ImGuiTableColumnFlags_WidthStretch, 1.0F);
    ImGui::TableSetupColumn("name", ImGuiTableColumnFlags_WidthStretch, 2.5F);
    ImGui::TableSetupColumn("type or signature", ImGuiTableColumnFlags_WidthStretch, 4.0F);
    ImGui::TableSetupScrollFreeze(0, 1);
    ImGui::TableHeadersRow();

    // Only the rows on screen are built. A class can carry several hundred
    // members and all but a dozen are scrolled out of sight.
    ImGuiListClipper clipper;
    clipper.Begin(static_cast<int>(detail.members.size()));
    while (clipper.Step()) {
        for (int i = clipper.DisplayStart; i < clipper.DisplayEnd; ++i) {
            const MemberRow& row = detail.members[static_cast<std::size_t>(i)];
            ImGui::TableNextRow();

            ImGui::TableNextColumn();
            if (row.is_method) {
                ImGui::TextDisabled("method");
            } else if (row.is_static) {
                ImGui::TextDisabled("static");
            } else {
                ImGui::TextUnformatted(row.offset.c_str());
            }

            ImGui::TableNextColumn();
            ImGui::TextUnformatted(row.name.c_str());

            ImGui::TableNextColumn();
            ImGui::TextUnformatted(row.detail.c_str());
        }
    }
    ImGui::EndTable();
}

/// The metadata inspector, in its own window.
///
/// **Nothing here runs on its own.** The list is fetched when the button is
/// pressed, a class is described when its row is clicked, and Clear drops both
/// — the report is shared by pointer, so letting go of it on both sides is what
/// actually returns the memory.
void DrawInspectorBody(const std::shared_ptr<const InspectorReport>& report,
                       InspectorInput& inspector, const ActionSink& emit) {
    if (report == nullptr || report->empty()) {
        if (ImGui::Button("Load class list")) {
            emit(BuildAction(kLoadClassesAction, {}));
        }
        ImGui::SameLine();
        // Beside the class list because it answers the other half of the same
        // question: that says where a field is, this says what is in it.
        if (ImGui::Button("Dump player object")) {
            emit(BuildAction(kDumpPlayerAction, {}));
        }
        ImGui::SameLine();
        // The shortcut past the list. Every player offset lives in one class
        // whose name is eleven letters of obfuscator output, so finding it in a
        // list of thousands means knowing the name first — and the module
        // already does.
        if (ImGui::Button("Export the player's class")) {
            emit(BuildAction(kExportPlayerClassAction, {}));
        }
        return;
    }

    if (ImGui::Button("Clear")) {
        inspector.Invalidate();
        emit(BuildAction(kClearInspectorAction, {}));
    }
    ImGui::SameLine();
    if (ImGui::Button("Export all to a file")) {
        emit(BuildAction(kExportClassesAction, {}));
    }
    ImGui::SameLine();
    if (ImGui::Button("Dump player object")) {
        emit(BuildAction(kDumpPlayerAction, {}));
    }
    ImGui::SameLine();
    if (ImGui::Button("Export the player's class")) {
        emit(BuildAction(kExportPlayerClassAction, {}));
    }
    ImGui::SameLine();
    ImGui::TextDisabled("%zu classes", report->classes.size());
    if (report->unprepared != 0) {
        // Said out loud. A sweep that quietly skipped part of the image would
        // be read as a complete answer, and "not there" would then be wrong.
        ImGui::TextDisabled("%zu more are registered but not built yet, so were left alone",
                            report->unprepared);
    }

    RefreshMatches(inspector, *report);
    ImGui::SetNextItemWidth(-1.0F);
    if (ImGui::InputTextWithHint("##filter", "filter", inspector.filter.data(),
                                 inspector.filter.size())) {
        RefreshMatches(inspector, *report);
    }

    constexpr ImGuiTableFlags kFlags =
        ImGuiTableFlags_RowBg | ImGuiTableFlags_ScrollY | ImGuiTableFlags_BordersOuter;
    // A share of what is left rather than a fixed number of rows: this has its
    // own window now, and a list that ignored how big the user made it would
    // waste the space they gave it.
    const bool has_detail = !report->selected.name.empty();
    const ImVec2 size{0.0F, ImGui::GetContentRegionAvail().y * (has_detail ? 0.35F : 1.0F)};
    if (ImGui::BeginTable("classes", 1, kFlags, size)) {
        ImGuiListClipper clipper;
        clipper.Begin(static_cast<int>(inspector.matches.size()));
        while (clipper.Step()) {
            for (int i = clipper.DisplayStart; i < clipper.DisplayEnd; ++i) {
                const int index = inspector.matches[static_cast<std::size_t>(i)];
                const std::string& name = report->classes[static_cast<std::size_t>(index)];

                // **Class names are not unique.** The compiler emits a `<>c`
                // for every class that closes over anything, so the image holds
                // dozens with that exact name — and a `Selectable` takes its
                // identity from its label, so two of them on screen at once are
                // one widget as far as ImGui is concerned. Keyed on the
                // position in the list, which is unique whatever the name says.
                ImGui::PushID(index);
                ImGui::TableNextRow();
                ImGui::TableNextColumn();
                if (ImGui::Selectable(name.c_str(), index == inspector.selected_index)) {
                    inspector.selected_index = index;
                    emit(BuildAction(kDescribeClassAction, {name}));
                }
                ImGui::PopID();
            }
        }
        ImGui::EndTable();
    }
    if (inspector.matches.empty()) {
        ImGui::TextDisabled("nothing matches that");
    }

    if (report->selected.name.empty()) {
        ImGui::TextDisabled("pick one to see what it holds");
        return;
    }

    ImGui::Separator();
    ImGui::TextUnformatted(report->selected.name.c_str());
    ImGui::SameLine();
    // Prints this one class to the log, safely — unlike "Export all to a file",
    // which walks the whole image. This is how a single class is handed off.
    if (ImGui::Button("Export this class")) {
        emit(BuildAction(kExportClassAction, {report->selected.name}));
    }
    if (!report->selected.base.empty()) {
        // For an unreadable name this line is often the most informative one on
        // the page: what it derives from was frequently left alone.
        ImGui::TextDisabled("derives from %s", report->selected.base.c_str());
    }
    DrawTouches(report->selected);
    DrawMembers(report->selected);
}

void DrawInspectorWindow(const std::shared_ptr<const InspectorReport>& report,
                         InspectorInput& inspector, const ActionSink& emit) {
    if (!inspector.open) {
        return;
    }

    // Roomier than the main window's default, because the list and the member
    // table are the two things here that want the space.
    ImGui::SetNextWindowSize(ImVec2{560.0F, 480.0F}, ImGuiCond_FirstUseEver);
    // The bool gives the window its close button, and closing it is the same
    // state as unticking the box that opened it.
    if (ImGui::Begin("Brownie Inspector", &inspector.open)) {
        DrawInspectorBody(report, inspector, emit);
    }
    ImGui::End();
}

}  // namespace

void PendingEdit::Hold(std::string_view id, std::string_view setting_key) {
    if (!Holds(id, setting_key)) {
        plugin_id = id;
        key = setting_key;
        number = 0.0F;
        text.fill('\0');
    }
    holding = true;
    // Taking hold again after sending means the user carried on before the
    // answer arrived, so the wait for that answer no longer applies.
    sent = false;
}

void PendingEdit::SetText(std::string_view value) noexcept {
    text.fill('\0');
    std::memcpy(text.data(), value.data(), std::min(value.size(), text.size() - 1));
}

std::string_view PendingEdit::TextView() const noexcept {
    return {text.data(), std::strlen(text.data())};
}

void PendingEdit::Sent(std::uint64_t version) noexcept {
    sent_at_version = version;
    sent = true;
}

void PendingEdit::Clear() noexcept {
    plugin_id.clear();
    key.clear();
    number = 0.0F;
    text.fill('\0');
    holding = false;
    sent = false;
}

void Draw(const OverlayModel& model, const std::shared_ptr<const InspectorReport>& report,
          UiState& state, const ActionSink& emit) {
    PendingEdit& edit = state.edit;

    // An interaction is held until the runtime has published a sync newer than
    // the one it was sent against — that sync is the answer, whatever it says.
    if (edit.sent && model.controls_version > edit.sent_at_version) {
        edit.Clear();
    }

    ImGui::SetNextWindowSize(ImVec2{800.0F, 600.0F}, ImGuiCond_FirstUseEver);
    // Collapsing the main window must not take the inspector with it: they are
    // separate windows, and the one is not inside the other.
    if (!ImGui::Begin("Brownie")) {
        // `End` is still required — ImGui pairs them regardless of what `Begin`
        // returned.
        ImGui::End();
        DrawInspectorWindow(report, state.inspector, emit);
        return;
    }

    // No permanent status rows. Once the link, the binding and the redirect are
    // working they say the same three things every frame, and a line that never
    // changes is one the eye stops reading — including on the day it changes.
    // What is left below appears only when there is something wrong to say.
    if (!model.status.empty()) {
        ImGui::TextWrapped("%s", model.status.c_str());
    }
    if (model.dropped_input != 0) {
        // Only shown when it happened. A permanent "dropped: 0" trains the eye
        // to skip the line that matters.
        ImGui::Text("%u input message(s) dropped; the render thread stalled.",
                    model.dropped_input);
    }
    if (model.dropped_actions != 0) {
        ImGui::Text("%u interaction(s) dropped; the runtime stopped reading.",
                    model.dropped_actions);
    }

    // Everything starts collapsed. The window sits over a game, and opening
    // what you came for beats closing three things you did not.
    if (ImGui::CollapsingHeader("Plugins")) {
        DrawPlugins(model, edit, emit);
    }

    if (ImGui::CollapsingHeader("Scene")) {
        DrawScene(model, state);
    }

    if (ImGui::CollapsingHeader("World")) {
        DrawWorld(model);
    }

    if (ImGui::CollapsingHeader("Offsets")) {
        // Inside the header rather than beside it: the inspector is how an
        // offset gets found in the first place, so it belongs with them and
        // hides with them.
        ImGui::Checkbox("Inspector", &state.inspector.open);
        DrawOffsets(model.offsets);
    }

    ImGui::End();

    DrawInspectorWindow(report, state.inspector, emit);
}

}  // namespace brownie::overlay
