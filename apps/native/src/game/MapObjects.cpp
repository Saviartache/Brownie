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

/// `List<T>` of a reference type: the item array, then the count in use.
///
/// The documented shape of the library type, like the dictionary's above, and
/// checked the same way — an object read out of one has to agree about its own
/// id before anything believes it.
constexpr std::uint32_t kListItemsAt = kObjectHeaderBytes;
constexpr std::uint32_t kListSizeAt = kListItemsAt + sizeof(void*);

/// How many entries of a table are worth walking, bounded three ways.
///
/// **The array's own length bounds the walk, not the table's count.** The count
/// is how many entries are in use and the array is at least that long, but both
/// numbers come out of memory that may not be what it is taken for — so the walk
/// is held to the smaller of the two and to a ceiling neither of them can raise.
[[nodiscard]] bool BoundedLength(const void* array, std::int32_t count,
                                 std::uint32_t& walk) noexcept {
    if (array == nullptr || count <= 0) {
        return false;
    }
    std::uint64_t length = 0;
    if (!ReadField(array, kArrayLengthAt, length)) {
        return false;
    }
    walk = static_cast<std::uint32_t>(count);
    if (length < walk) {
        walk = static_cast<std::uint32_t>(length);
    }
    if (walk > kMaxMapObjects) {
        walk = kMaxMapObjects;
    }
    return true;
}

/// How a walk of one container ended.
///
/// **Absent and failed are different answers**, and the difference is the
/// whole of what makes a walk safe to draw conclusions from. A table that is
/// not there — unresolved, or null between realms — hides nothing; one whose
/// read failed part of the way through hides whatever was after the failure,
/// and a caller counting what is missing must not count those. Nor one that
/// was longer than any walk goes: everything it handed over was real, and
/// everything past the bound is as unknown as a failed read's.
enum class Walk : std::uint8_t { kAbsent, kDone, kPartial, kStopped, kFailed };

/// Hands every filled slot of one table to `visit`, a block at a time.
///
/// A free slot keeps its old key and its old value, so what is handed over is
/// not yet an answer: whoever receives it checks the object agrees about its own
/// id, which also catches a table not laid out the way the constants above say.
template <typename Visit>
[[nodiscard]] Walk WalkTable(const void* world, std::uint32_t table_at, Visit&& visit) noexcept {
    if (table_at == 0) {
        return Walk::kAbsent;
    }
    void* table = nullptr;
    if (!ReadField(world, table_at, table)) {
        return Walk::kFailed;
    }
    if (table == nullptr) {
        return Walk::kAbsent;
    }

    void* entries = nullptr;
    std::int32_t count = 0;
    if (!ReadField(table, kDictionaryEntriesAt, entries) ||
        !ReadField(table, kDictionaryCountAt, count)) {
        return Walk::kFailed;
    }
    // An empty table, or one not built yet, holds nothing and hides nothing.
    if (entries == nullptr || count <= 0) {
        return Walk::kDone;
    }
    std::uint32_t walk = 0;
    if (!BoundedLength(entries, count, walk)) {
        return Walk::kFailed;
    }

    const bool whole = walk == static_cast<std::uint32_t>(count);

    std::array<std::byte, static_cast<std::size_t>(kEntriesPerRead) * kEntryBytes> block{};
    for (std::uint32_t first = 0; first < walk; first += kEntriesPerRead) {
        const std::uint32_t taken =
            walk - first < kEntriesPerRead ? walk - first : kEntriesPerRead;
        const auto* at = static_cast<const std::byte*>(entries) + kArrayElementsAt +
                         static_cast<std::size_t>(first) * kEntryBytes;
        if (!ReadRaw(at, block.data(), static_cast<std::size_t>(taken) * kEntryBytes)) {
            return Walk::kFailed;
        }

        for (std::uint32_t index = 0; index < taken; ++index) {
            const std::byte* entry = block.data() + static_cast<std::size_t>(index) * kEntryBytes;
            std::int32_t key = 0;
            std::memcpy(&key, entry + kEntryKeyAt, sizeof(key));
            void* object = nullptr;
            std::memcpy(&object, entry + kEntryValueAt, sizeof(object));
            if (object == nullptr) {
                continue;
            }
            if (!visit(key, object)) {
                return Walk::kStopped;
            }
        }
    }
    return whole ? Walk::kDone : Walk::kPartial;
}

/// Searches one table, or reports that this was not the one.
[[nodiscard]] bool LookUpIn(const void* world, std::uint32_t table_at,
                            const MapObjectRoute& route, std::int32_t object_id, float& x,
                            float& y) noexcept {
    bool found = false;
    (void)WalkTable(world, table_at, [&](std::int32_t key, const void* object) noexcept {
        if (key != object_id || !ObjectAgrees(object, route, object_id)) {
            return true;
        }
        found = ReadObjectPosition(object, route, x, y);
        return false;
    });
    return found;
}

/// Hands every object in the world manager's pending list to `visitor`.
///
/// The list files nothing by id, so each object's own id is read off it — which
/// is also the check that the pointer is a map object at all. An object whose id
/// cannot be read is skipped rather than failing the walk: it is in no table
/// yet, so nothing counting what is missing could be misled by it.
[[nodiscard]] Walk WalkPending(const void* world, std::uint32_t pending_at,
                               const MapObjectRoute& route, MapObjectVisitor& visitor) noexcept {
    if (pending_at == 0) {
        return Walk::kAbsent;
    }
    void* list = nullptr;
    if (!ReadField(world, pending_at, list)) {
        return Walk::kFailed;
    }
    if (list == nullptr) {
        return Walk::kAbsent;
    }
    void* items = nullptr;
    std::int32_t size = 0;
    if (!ReadField(list, kListItemsAt, items) || !ReadField(list, kListSizeAt, size)) {
        return Walk::kFailed;
    }
    if (items == nullptr || size <= 0) {
        return Walk::kDone;
    }
    std::uint32_t walk = 0;
    if (!BoundedLength(items, size, walk)) {
        return Walk::kFailed;
    }
    const bool whole = walk == static_cast<std::uint32_t>(size);

    constexpr std::uint32_t kPointersPerRead = 512;
    std::array<void*, kPointersPerRead> block{};
    for (std::uint32_t first = 0; first < walk; first += kPointersPerRead) {
        const std::uint32_t taken =
            walk - first < kPointersPerRead ? walk - first : kPointersPerRead;
        const auto* at = static_cast<const std::byte*>(items) + kArrayElementsAt +
                         static_cast<std::size_t>(first) * sizeof(void*);
        if (!ReadRaw(at, block.data(), static_cast<std::size_t>(taken) * sizeof(void*))) {
            return Walk::kFailed;
        }
        for (std::uint32_t index = 0; index < taken; ++index) {
            const void* object = block[index];
            std::int32_t id = 0;
            if (object == nullptr || !ReadField(object, route.object_id_at, id)) {
                continue;
            }
            if (!visitor.Visit(id, object)) {
                return Walk::kStopped;
            }
        }
    }
    return whole ? Walk::kDone : Walk::kPartial;
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

bool ForEachMapObject(const void* world, const MapObjectRoute& route, std::uint32_t pending_at,
                      MapObjectVisitor& visitor) noexcept {
    if (world == nullptr || !route.usable()) {
        return false;
    }
    // A stopped walk stops everything after it too: the visitor said it has
    // seen enough, and the other table and the list are more of the same. A
    // failed or partial one fails the whole walk, because what it did not reach
    // is not known to be absent.
    const auto visit = [&](std::int32_t key, const void* object) noexcept {
        return visitor.Visit(key, object);
    };
    const auto whole = [](Walk walk) { return walk != Walk::kFailed && walk != Walk::kPartial; };
    const Walk first = WalkTable(world, route.objects_at, visit);
    if (!whole(first)) {
        return false;
    }
    if (first == Walk::kStopped) {
        return true;
    }
    const Walk second = WalkTable(world, route.objects_alt_at, visit);
    if (!whole(second)) {
        return false;
    }
    if (second == Walk::kStopped) {
        return true;
    }
    return whole(WalkPending(world, pending_at, route, visitor));
}

}  // namespace brownie::game
