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
/// The planner's own circles, which are drawn at whatever size the world says.
///
/// Thinner than the marks above: several of them overlap around every monster,
/// and the picture is meant to be read *through*. Below the minimum a circle is
/// a dot that says nothing, and ImGui draws a degenerate one as a smear.
constexpr float kRingStroke = 1.0F;
constexpr float kMinRingRadius = 2.0F;
/// How solid the two circles that are filled rather than outlined are.
constexpr float kBodyFill = 0.18F;
constexpr float kBlastFill = 0.22F;

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

/// The same colour, at a stated opacity. For the circles that are filled.
[[nodiscard]] ImU32 Faded(ImU32 colour, float alpha) {
    ImVec4 parts = ImGui::ColorConvertU32ToFloat4(colour);
    parts.w = alpha;
    return ImGui::ColorConvertFloat4ToU32(parts);
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

void DrawDodgeRings(const RingMark* marks, int count) {
    ImDrawList* list = ImGui::GetForegroundDrawList();
    if (list == nullptr || marks == nullptr) {
        return;
    }

    // The two the theme keeps for data rather than for chrome. Which is which
    // matters less than that they differ in every stock theme: what tells these
    // apart in a fight is size and position, and the colour is there to stop two
    // circles the same size reading as the same thing.
    const ImU32 line = Solid(ImGuiCol_PlotLines);
    const ImU32 mark = Solid(ImGuiCol_PlotHistogram);

    for (int i = 0; i < count; ++i) {
        const RingMark& ring = marks[i];
        // Below a pixel or two a circle is a dot that says nothing, and ImGui
        // draws a degenerate one as a smear.
        if (!(ring.radius >= kMinRingRadius)) {
            continue;
        }
        const ImVec2 centre = At(ring.centre);

        switch (ring.role) {
            case RingRole::Player:
                list->AddCircle(centre, ring.radius, line, 0, kStroke);
                break;
            case RingRole::Engage:
                // Thin, because it is the largest thing on the screen most of
                // the time and a heavy line that size is a wall around the
                // character rather than a mark on the ground.
                list->AddCircle(centre, ring.radius, line, 0, kRingStroke);
                break;
            case RingRole::Body:
                // Filled, faintly: this is the thing itself, and what is
                // interesting is where its edge is rather than what is under it.
                list->AddCircleFilled(centre, ring.radius, Faded(mark, kBodyFill));
                list->AddCircle(centre, ring.radius, mark, 0, kRingStroke);
                break;
            case RingRole::KeepAway:
                list->AddCircle(centre, ring.radius, mark, 0, kStroke);
                break;
            case RingRole::Blast:
                // **The one that is coloured by its own number**, for the same
                // reason the shot trails are: green to red is how long there is
                // left to walk out of it, and a bomb two seconds out and one
                // landing this instant are otherwise the same circle in the same
                // place. Filled as well as outlined, because what matters about
                // a blast is the ground it takes rather than its edge.
                list->AddCircleFilled(centre, ring.radius, Lifetime(ring.ahead, kBlastFill));
                list->AddCircle(centre, ring.radius, Lifetime(ring.ahead, 1.0F), 0, kStroke);
                break;
        }
    }
}

}  // namespace brownie::overlay
