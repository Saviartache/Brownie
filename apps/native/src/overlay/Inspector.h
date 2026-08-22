// What the inspector has been asked to show.
//
// Kept out of `OverlayModel` on purpose. That model is republished on every
// world tick — four times a second — and copied into the render thread's own
// copy each time. A list of three thousand class names inside it would be three
// thousand strings copied per tick to draw a panel that had not changed.
//
// This travels as a `shared_ptr` to a const report instead: publishing swaps a
// pointer, refreshing copies a pointer, and the report itself is never copied
// at all. It is also the reason clearing works — drop the pointer on both
// sides and the memory goes with it.
//
// **Nothing here is filled in unless a button was pressed.** Building it walks
// the game's metadata, which is neither free nor safe to do on a timer.

#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace brownie::overlay {

/// One field or one method of a class.
struct MemberRow {
    std::string name;
    /// A field's declared type, or a method's signature.
    std::string detail;
    /// `0x1BC` for an instance field; empty for anything without one.
    std::string offset;
    bool is_method = false;
    bool is_static = false;
};

/// One class, described.
struct ClassDetail {
    std::string name;
    /// What it derives from, which for an unreadable name is often the most
    /// informative line on the page.
    std::string base;
    std::vector<MemberRow> members;

    /// The readable type names this class touches, deduplicated.
    ///
    /// **This is the answer to "what is this thing".** A class called
    /// `LKHPPBEGNOM` says nothing, but the obfuscator left most library and
    /// data types alone — so the types it stores, returns and accepts describe
    /// its job even though its name cannot. Evidence, not a guess at a name.
    std::vector<std::string> touches;
};

/// Everything the Inspector panel draws.
struct InspectorReport {
    std::vector<std::string> classes;
    /// Classes the runtime had registered but not finished preparing, and so
    /// were not asked for their members. Counted rather than hidden: a sweep
    /// that quietly skipped a tenth of the image would be read as complete.
    std::size_t unprepared = 0;
    /// Empty until a row is clicked.
    ClassDetail selected;

    [[nodiscard]] bool empty() const noexcept {
        return classes.empty() && selected.name.empty();
    }
};

/// Whether a name survived obfuscation.
///
/// Beebyte renames to a fixed-length run of capitals, so a name carrying a
/// namespace, a lowercase letter or a digit is one it left alone. A heuristic,
/// and used only to decide what to *show* — nothing resolves on it.
[[nodiscard]] bool LooksReadable(std::string_view name) noexcept;

}  // namespace brownie::overlay
