// What describing a class needs, beyond what resolving an offset does.
//
// `MetadataSource` answers questions about a class somebody already knows the
// name of, because that is all offset resolution ever asks. The inspector asks
// the other kind: what is in this image at all, and what does this class derive
// from. Kept as a separate interface rather than added there, so the narrow
// question stays narrow — a test double for offset resolution should not have
// to describe an image it has no opinion about.

#pragma once

#include <string>
#include <vector>

#include "game/Metadata.h"

namespace brownie::game {

class ClassCatalog : public MetadataSource {
  public:
    /// Every class the source can describe, as "Namespace.Name".
    [[nodiscard]] virtual std::vector<std::string> ClassNames() const = 0;

    /// The name of the class this one derives from, or empty at the root.
    ///
    /// For an obfuscated name this is often the single most informative thing
    /// available: a class called `LKHPPBEGNOM` says nothing, but one deriving
    /// from a readable base has already explained most of itself.
    [[nodiscard]] virtual std::string BaseClassName(ClassRef klass) const = 0;
};

}  // namespace brownie::game
