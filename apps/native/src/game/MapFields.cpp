#include "game/MapFields.h"

#include <string_view>

namespace brownie::game {
namespace {

/// The namespace is empty because this class is in the global one, spelled out
/// rather than defaulted for the reason `ProjectileFields.cpp` gives.
constexpr std::string_view kGlobalNamespace{};

/// The world manager, named again here rather than shared with
/// `PlayerFields.cpp`, which queries the same class for the local player. The
/// two files ask different things of it and each says which class it is asking,
/// so a build that renames it leaves both sets of keys unresolved and visible
/// in the overlay's report.
constexpr std::string_view kWorldManagerClass = "HJMBOMEHGDJ";

constexpr ClassQuery kWorldManager{kGlobalNamespace, kWorldManagerClass, {}};

constexpr std::string_view kBooleanReturn = "System.Boolean";
constexpr std::string_view kTileParameters[] = {"System.Single", "System.Single"};

/// The prefix every predicate's key gets. What follows it is the obfuscated
/// name, so the report reads `map.walkable.PEGDEDNHEHD` — which is what makes a
/// row in that report and a counter in the Scene panel the same predicate.
constexpr std::string_view kKeyPrefix = "map.walkable.";

[[nodiscard]] bool IsWalkabilityShape(const MethodDescription& method) {
    return method.return_type == kBooleanReturn &&
           method.parameter_types.size() == std::size(kTileParameters) &&
           method.parameter_types[0] == kTileParameters[0] &&
           method.parameter_types[1] == kTileParameters[1];
}

}  // namespace

std::vector<WalkabilityPredicate> ResolveWalkabilityPredicates(const MetadataSource& source,
                                                               OffsetTable& table) {
    std::vector<WalkabilityPredicate> found;

    const auto klass = ResolveClass(source, kWorldManager);
    if (!klass.ok()) {
        return found;
    }

    for (const auto& method : source.Methods(klass.value().first)) {
        if (found.size() >= kMaxWalkabilityPredicates || !IsWalkabilityShape(method)) {
            continue;
        }
        // Registered by exact name, which is what the enumeration just handed
        // over — so the report says `exact name` and means it, and the address
        // it carries is the one the entry-point check passed rather than the
        // one this loop happens to be holding.
        const std::string key = std::string{kKeyPrefix} + method.name;
        const MethodQuery query{kWorldManager, method.name, {}, kBooleanReturn, kTileParameters};
        const auto resolved = table.ResolveMethod(key, query);
        if (!resolved.ok()) {
            continue;
        }
        found.push_back({method.name, resolved.value().address});
    }
    return found;
}

}  // namespace brownie::game
