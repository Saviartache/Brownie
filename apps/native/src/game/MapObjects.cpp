#include "game/MapObjects.h"

#include <array>
#include <cstddef>
#include <cstring>

namespace brownie::game {
namespace {

/// The header every managed object carries: a class pointer and a monitor.
///
/// Not assumed — read off the dump. Every class in the game's metadata puts its
/// first instance field at `0x10`, which is this.
constexpr std::uint32_t kObjectHeaderBytes = 0x10;

/// A managed array's header: the object header, a bounds pointer and a length.
constexpr std::uint32_t kArrayLengthAt = kObjectHeaderBytes + sizeof(void*);
constexpr std::uint32_t kArrayElementsAt = kArrayLengthAt + sizeof(std::uint64_t);

/// `Dictionary<TKey, TValue>`, as the runtime lays it out.
///
/// **The one thing in this file that metadata cannot answer.** The exporter
/// skips the library generics — they report themselves prepared and then fault
/// when walked — so this is the documented shape of the type rather than a
/// reading of this build's. It is why every lookup checks its answer.
constexpr std::uint32_t kDictionaryEntriesAt = kObjectHeaderBytes + sizeof(void*);
constexpr std::uint32_t kDictionaryCountAt = kDictionaryEntriesAt + sizeof(void*);

/// `struct Entry { uint hashCode; int next; int key; TValue value; }` for an
/// `int` key and a reference value, with the padding that alignment inserts
/// before the pointer.
constexpr std::uint32_t kEntryBytes = 24;
constexpr std::uint32_t kEntryKeyAt = 8;
constexpr std::uint32_t kEntryValueAt = 16;

/// One bulk read's worth of entries.
///
/// **Read in blocks rather than one at a time, because each read is a system
/// call.** A frame that asked separately for a few hundred entries would spend
/// more time crossing into the kernel than the game spends drawing them.
constexpr std::uint32_t kEntriesPerRead = 512;

/// Whether an object filed under `object_id` really is that object.
///
/// The check the whole file rests on. A dictionary walked with the wrong stride
/// hands back a pointer into the middle of something, and a pointer that is not
/// a map object does not carry that id at that offset.
[[nodiscard]] bool ObjectAgrees(const void* object, const MapObjectRoute& route,
                                std::int32_t object_id) noexcept {
    std::int32_t stored = 0;
    return ReadField(object, route.object_id_at, stored) && stored == object_id;
}

/// Reads a position out of an object already proven to be the right one.
///
/// Both coordinates in one read where they are neighbours, for the reason
/// `ReadPosition` gives: they are adjacent floats and asking twice is a system
/// call spent on arithmetic already in hand.
[[nodiscard]] bool ReadObjectPosition(const void* object, const MapObjectRoute& route, float& x,
                                      float& y) noexcept {
    if (route.y_at == route.x_at + sizeof(float)) {
        std::array<float, 2> both{};
        if (!ReadField(object, route.x_at, both)) {
            return false;
        }
        x = both[0];
        y = both[1];
        return true;
    }
    return ReadField(object, route.x_at, x) && ReadField(object, route.y_at, y);
}

/// Searches one table, or reports that this was not the one.
[[nodiscard]] bool LookUpIn(const void* world, std::uint32_t table_at,
                            const MapObjectRoute& route, std::int32_t object_id, float& x,
                            float& y) noexcept {
    if (table_at == 0) {
        return false;
    }
    void* table = nullptr;
    if (!ReadField(world, table_at, table) || table == nullptr) {
        return false;
    }

    void* entries = nullptr;
    std::int32_t count = 0;
    if (!ReadField(table, kDictionaryEntriesAt, entries) || entries == nullptr) {
        return false;
    }
    if (!ReadField(table, kDictionaryCountAt, count) || count <= 0) {
        return false;
    }

    // **The array's own length bounds the walk, not the dictionary's count.**
    // The count is how many entries are in use and the array is at least that
    // long, but both numbers come out of memory that may not be a dictionary at
    // all — so the walk is held to the smaller of the two and to a ceiling
    // neither of them can raise.
    std::uint64_t length = 0;
    if (!ReadField(entries, kArrayLengthAt, length)) {
        return false;
    }
    std::uint32_t walk = static_cast<std::uint32_t>(count);
    if (length < walk) {
        walk = static_cast<std::uint32_t>(length);
    }
    if (walk > kMaxMapObjects) {
        walk = kMaxMapObjects;
    }

    std::array<std::byte, static_cast<std::size_t>(kEntriesPerRead) * kEntryBytes> block{};
    for (std::uint32_t first = 0; first < walk; first += kEntriesPerRead) {
        const std::uint32_t taken =
            walk - first < kEntriesPerRead ? walk - first : kEntriesPerRead;
        const auto* at = static_cast<const std::byte*>(entries) + kArrayElementsAt +
                         static_cast<std::size_t>(first) * kEntryBytes;
        if (!ReadRaw(at, block.data(), static_cast<std::size_t>(taken) * kEntryBytes)) {
            return false;
        }

        for (std::uint32_t index = 0; index < taken; ++index) {
            const std::byte* entry = block.data() + static_cast<std::size_t>(index) * kEntryBytes;
            std::int32_t key = 0;
            std::memcpy(&key, entry + kEntryKeyAt, sizeof(key));
            if (key != object_id) {
                continue;
            }
            void* object = nullptr;
            std::memcpy(&object, entry + kEntryValueAt, sizeof(object));
            // A free slot keeps its old key, so a match is not yet an answer —
            // and neither is a live slot if this table is not laid out the way
            // the constants above say. The object itself settles both.
            if (object == nullptr || !ObjectAgrees(object, route, object_id)) {
                continue;
            }
            return ReadObjectPosition(object, route, x, y);
        }
    }
    return false;
}

}  // namespace

bool FindMapObject(const Il2CppRuntime& game, const MapObjectRoute& route, std::int32_t object_id,
                   float& x, float& y) noexcept {
    if (!route.usable()) {
        return false;
    }
    void* world = FindWorldManager(game, route.world);
    if (world == nullptr) {
        return false;
    }
    // The tables in the order the class declares them, and no memory of which
    // answered last time: the live one is the live one every frame, and a table
    // that stops answering has had the object leave view rather than having
    // been the wrong table all along.
    return LookUpIn(world, route.objects_at, route, object_id, x, y) ||
           LookUpIn(world, route.objects_alt_at, route, object_id, x, y);
}

}  // namespace brownie::game
