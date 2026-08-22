#include "overlay/WorldMarkers.h"

#include <imgui.h>

namespace brownie::overlay {
namespace {

/// How big the marks are, in pixels.
///
/// A tile is thirty-odd pixels at the default zoom, so these are read as
/// "roughly a third of a tile" — small enough to leave what they mark visible,
/// large enough to find while something is moving.
constexpr float kPlayerRadius = 7.0F;
constexpr float kTargetRadius = 5.0F;
constexpr float kCursorRadius = 9.0F;
constexpr float kAimRadius = 5.0F;
constexpr float kStroke = 2.0F;
/// A shot's own mark, and the line it is going to travel.
///
/// Smaller than the rest: there can be fifty of these at once, and a picture
/// where every shot is as loud as the character is a picture of nothing.
constexpr float kShotRadius = 3.0F;
constexpr float kTrailStroke = 1.5F;

/// One theme colour, held at full opacity.
///
/// The theme's own alpha is meant for widgets sitting on the overlay's own
/// background; these sit on the game, where a half-transparent line over a
/// bright tile is not a line.
[[nodiscard]] ImU32 Solid(ImGuiCol which) {
    ImVec4 colour = ImGui::GetStyleColorVec4(which);
    colour.w = 1.0F;
    return ImGui::ColorConvertFloat4ToU32(colour);
}

[[nodiscard]] ImVec2 At(ScreenPoint point) {
    return ImVec2{point.x, point.y};
}

/// How long something has left, as a colour: green for plenty, red for none.
///
/// Through yellow rather than straight from one to the other, because a
/// half-and-half mix of pure green and pure red is a muddy brown that reads as
/// neither. `left` is one at the moment a shot is fired and nought as it dies.
[[nodiscard]] ImU32 Lifetime(float left, float alpha) {
    const float amount = left < 0.0F ? 0.0F : (left > 1.0F ? 1.0F : left);
    const float red = amount > 0.5F ? (1.0F - amount) * 2.0F : 1.0F;
    const float green = amount > 0.5F ? 1.0F : amount * 2.0F;
    return ImGui::ColorConvertFloat4ToU32(ImVec4{red, green, 0.15F, alpha});
}

}  // namespace

void DrawMovement(const MovementMarkers& markers) {
    ImDrawList* list = ImGui::GetForegroundDrawList();
    if (list == nullptr) {
        return;
    }

    // The two colours the theme keeps for data rather than for chrome, which is
    // what these are. Distinct in every stock theme, and they follow whichever
    // one is active instead of being chosen here.
    const ImU32 line = Solid(ImGuiCol_PlotLines);
    const ImU32 mark = Solid(ImGuiCol_PlotHistogram);

    // The line first, so the marks at either end of it are drawn over it.
    if (markers.has_player && markers.has_target) {
        list->AddLine(At(markers.player), At(markers.target), line, kStroke);
    }

    if (markers.has_player) {
        // Hollow: what it marks is the character, and filling it in would hide
        // the thing being marked.
        list->AddCircle(At(markers.player), kPlayerRadius, line, 0, kStroke);
    }
    if (markers.has_target) {
        list->AddCircleFilled(At(markers.target), kTargetRadius, mark);
    }
    if (markers.has_cursor) {
        // The input rather than the outcome, so it is drawn as a ring around
        // where the cursor points and not as a place the character is going —
        // the two are different the moment the projection is wrong, which is
        // the whole reason to see both.
        list->AddCircle(At(markers.cursor), kCursorRadius, mark, 0, kStroke);
    }
}

void DrawShotTrails(const TrailMarkers& markers) {
    ImDrawList* list = ImGui::GetForegroundDrawList();
    if (list == nullptr || markers.points == nullptr || markers.lengths == nullptr ||
        markers.lives == nullptr) {
        return;
    }

    int offset = 0;
    for (int trail = 0; trail < markers.count; ++trail) {
        const int length = markers.lengths[trail];
        if (length < 2) {
            offset += length;
            continue;
        }
        const float life = markers.lives[trail];

        // **The line is a gradient because the shot ages along it.** The head is
        // where the shot is now, with whatever life it has left; the far end is
        // where it stops existing, which is nought by definition. So a fresh
        // shot draws green fading to red at the place it dies, and a shot on its
        // last legs draws a short red stub — the length and the colour say the
        // same thing twice, which is what makes it readable in a fight.
        for (int i = 0; i + 1 < length; ++i) {
            const float along = (static_cast<float>(i) + 0.5F) / static_cast<float>(length - 1);
            const float left = life * (1.0F - along);
            // Held well short of transparent: a line over a bright tile has to
            // be a line. The far end is dimmer than the head because the far end
            // is a prediction about a moment further away.
            const float alpha = 0.35F + 0.55F * (1.0F - along);
            list->AddLine(At(markers.points[offset + i]), At(markers.points[offset + i + 1]),
                          Lifetime(left, alpha), kTrailStroke);
        }

        // The shot itself, marked where it is right now.
        list->AddCircleFilled(At(markers.points[offset]), kShotRadius, Lifetime(life, 1.0F));
        offset += length;
    }
}

void DrawAim(const AimMarkers& markers) {
    ImDrawList* list = ImGui::GetForegroundDrawList();
    if (list == nullptr) {
        return;
    }

    if (!markers.has_target) {
        // Nothing is being aimed at right now, which is most of the time and is
        // not a failure — the panel's own line says whether the feature is on.
        return;
    }

    // A third theme colour, so a walk and an aim are never mistaken for each
    // other when both are on: this is the one the theme uses for a mark that
    // means "yes, this one".
    const ImU32 aim = Solid(ImGuiCol_CheckMark);

    // The line first, so the ring at its end is drawn over it. **The line is
    // half the answer**: a ring on a monster looks right whichever direction it
    // was reached from, and where it is *from* is what the shots follow.
    if (markers.has_player) {
        list->AddLine(At(markers.player), At(markers.target), aim, kStroke);
    }
    list->AddCircle(At(markers.target), kAimRadius, aim, 0, kStroke);
}

}  // namespace brownie::overlay
