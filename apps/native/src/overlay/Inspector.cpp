#include "overlay/Inspector.h"

#include <string_view>

namespace brownie::overlay {

bool LooksReadable(std::string_view name) noexcept {
    if (name.empty()) {
        return false;
    }
    for (const char byte : name) {
        // A namespace separator, a lowercase letter, a digit or a generic's
        // punctuation — none of which survives a rename to eleven capitals.
        if (byte < 'A' || byte > 'Z') {
            return true;
        }
    }
    return false;
}

}  // namespace brownie::overlay
