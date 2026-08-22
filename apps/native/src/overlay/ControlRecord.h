// Reading the runtime's control records, and writing the actions that answer
// them.
//
// The runtime describes the plugin list and every setting as a stream of
// `|`-separated, percent-encoded records; an interaction travels back in the
// same shape. `docs/ipc.md` is the specification and
// `packages/ipc/src/overlay/RecordCodec.ts` is the other half of this file.
//
// Two rules from that document are what this implements, and both are
// load-bearing:
//
//   * an unknown record kind is ignored, never rejected, so a newer runtime
//     cannot break an older module;
//   * fields are positional and new ones are appended, so a reader that stops
//     early still reads everything it knows about.
//
// The world record has its own reader in `WorldRecord.h`: it carries integers
// only and needs neither the splitting nor the decoding done here.

#pragma once

#include <cstdint>
#include <initializer_list>
#include <string>
#include <string_view>
#include <vector>

#include "overlay/Ui.h"

namespace brownie::overlay {

/// Splits a record into decoded fields, the kind first. Never empty: a record
/// with no separator in it is one field, and an empty record is one empty one.
///
/// **Decoding is also where the overlay's ASCII rule is enforced.** A label is
/// written by whoever wrote the plugin, and `encodeURIComponent` happily
/// carries text in any language — which the built-in ImGui font cannot draw.
/// Any byte outside printable ASCII becomes `?` here rather than reaching the
/// font as a glyph it has no entry for, or reaching layout as a newline.
[[nodiscard]] std::vector<std::string> SplitRecord(std::string_view record);

/// Percent-encodes one field, matching JavaScript's `encodeURIComponent`.
[[nodiscard]] std::string EncodeField(std::string_view value);

/// Builds one action record from a kind and its fields.
[[nodiscard]] std::string BuildAction(std::string_view kind,
                                      std::initializer_list<std::string_view> fields);

/// Actions the module answers itself instead of sending on.
///
/// The inspector reads the game's own metadata, which only this side has, so
/// these two never reach the runtime as interactions — the engine recognises
/// them on their way out and replies with what it found. See `Engine`.
inline constexpr std::string_view kLoadClassesAction = "load-classes";
inline constexpr std::string_view kDescribeClassAction = "describe-class";
inline constexpr std::string_view kClearInspectorAction = "clear-inspector";
inline constexpr std::string_view kExportClassesAction = "export-classes";
/// Prints one class's members to the log, the way the player dump does. Safe
/// where `export-classes` is not: it describes only a class already selected,
/// so it never walks the whole image and cannot fault on a class nobody asked
/// for.
inline constexpr std::string_view kExportClassAction = "export-class";
/// The same, for the class the player's own features are resolved against.
///
/// It takes no name, and that is the point: the name is eleven letters of
/// obfuscator output that changes with the build, so anyone looking for a
/// member of it has to be told the name before they can ask about it. The
/// module already knows it — every player offset is resolved through it — so
/// this asks for "the player's class" and lets the module say which that is.
inline constexpr std::string_view kExportPlayerClassAction = "export-player-class";
inline constexpr std::string_view kDumpPlayerAction = "dump-player";

/// The runtime's plugin list, mirrored.
///
/// The overlay holds no state of its own, so this is not a cache to be kept in
/// step: it is a copy of what the runtime last described, replaced wholesale.
/// A sync is bracketed by `sync-begin` and `sync-end` and is committed only
/// when the closing record arrives — a list half-replaced by a connection that
/// dropped mid-sync would show plugins that no longer exist beside settings
/// that do.
class ControlMirror {
  public:
    /// Applies one record.
    ///
    /// @returns whether the visible list changed, which is true only when a
    ///   sync completes. Records this does not recognise — the world record
    ///   among them — return false and leave the mirror alone.
    [[nodiscard]] bool Apply(std::string_view record);

    /// Drops everything. Called when the link goes down: a frozen snapshot of a
    /// runtime that is no longer there is worse than an empty list.
    void Reset() noexcept;

    /// The committed list, grouped by category and stable within each group.
    [[nodiscard]] const std::vector<PluginRow>& plugins() const noexcept { return plugins_; }

    /// How many syncs have been committed.
    ///
    /// The overlay uses this to know when an interaction it sent has been
    /// answered — see `PendingEdit` in `Ui.h`.
    [[nodiscard]] std::uint64_t version() const noexcept { return version_; }

  private:
    std::vector<PluginRow> plugins_;
    /// The sync being built. Kept apart from `plugins_` so a commit is a move.
    std::vector<PluginRow> staging_;
    bool syncing_ = false;
    std::uint64_t version_ = 0;
};

}  // namespace brownie::overlay
