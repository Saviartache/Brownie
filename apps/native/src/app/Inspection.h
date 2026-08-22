// Turning what this side can see into text the other side can read.
//
// The module is the only party that can ask the game's own runtime what a class
// contains, and the answers are diagnostics: a name the obfuscator removed is
// recovered by looking at what a class stores, and a field that resolves to the
// wrong number is caught by reading the player object beside what the server
// says about it.
//
// **Nothing here reaches the link.** Lines and chunks go to a sink the caller
// supplies, which is what makes every rule in this file testable against a
// metadata source with no game behind it — including the one that decides which
// classes must not be walked at all.

#pragma once

#include <cstddef>
#include <functional>
#include <span>
#include <string>
#include <string_view>

#include "game/ClassCatalog.h"
#include "overlay/Inspector.h"

namespace brownie::app {

/// One line of an answer, on its way to wherever the caller sends lines.
using LineSink = std::function<void(std::string_view)>;

/// A block of the class dump, for a file rather than for a log.
using ChunkSink = std::function<void(const std::string&)>;

/// Whether a class is one a whole-image sweep should walk past rather than ask
/// for its members.
///
/// Generic definitions (`List`1`), arrays (`Foo[]`) and compiler-generated
/// closures (`<>c`, `<M>d__3`) report themselves prepared yet fault when their
/// fields are iterated — the crash the reference implementation hit and
/// `IsPrepared` alone does not stop. Every one of them carries a character the
/// obfuscator never emits into an ordinary class name, so the name is enough to
/// tell them apart. A class picked by hand in the inspector skips this: it was
/// already described without fault, which is the proof this heuristic stands in
/// for.
[[nodiscard]] bool LooksUnsafeToWalk(std::string_view full_name) noexcept;

/// Describes one class: its base, its members, and the readable types it
/// touches — which is what stands in for a name the obfuscator removed.
///
/// Never fails: a class the runtime has not built yet is missing exactly like
/// one that never existed, and saying so is the answer.
[[nodiscard]] overlay::ClassDetail Describe(const game::ClassCatalog& catalog,
                                            const std::string& full_name);

/// Writes a described class as a heading and one line per member.
void WriteClass(const overlay::ClassDetail& detail, const LineSink& say);

/// What a sweep across the image did.
struct ExportSummary {
    std::size_t written = 0;
    /// Classes that were not asked about their members. Counted rather than
    /// hidden: a sweep that quietly skipped a tenth of the image would be read
    /// as complete.
    std::size_t skipped = 0;
};

/// Describes every class in the image, in chunks of roughly `chunk_bytes`.
///
/// Chunked because one class per record would be the same bytes and a hundred
/// times the round trips, and because a few thousand names do not belong in a
/// log. The final chunk goes out however short it is.
[[nodiscard]] ExportSummary ExportClasses(const game::ClassCatalog& catalog,
                                          std::size_t chunk_bytes, const ChunkSink& send);

/// Prints an object word by word, each word as an integer and as a float.
///
/// A word is one or the other and which one is exactly what is being worked
/// out, so both are shown. A trailing partial word is not printed: it would be
/// a read past the buffer the caller handed over.
void DumpObject(std::span<const std::byte> object, const LineSink& say);

}  // namespace brownie::app
