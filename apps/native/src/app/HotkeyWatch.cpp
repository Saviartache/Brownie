#include "app/HotkeyWatch.h"

#include <utility>

namespace brownie::app {

void HotkeyWatch::Release(Watched& watched, const Report& report) {
    if (!watched.holding) return;
    watched.holding = false;
    watched.down = false;
    report(watched.bind.plugin_id, watched.bind.slot, kHoldAction, false);
}

void HotkeyWatch::Watch(std::vector<HotkeyBind> binds, const Report& report) {
    std::vector<Watched> next;
    next.reserve(binds.size());

    for (HotkeyBind& bind : binds) {
        if (bind.plugin_id.empty() || !bind.chord.bound()) continue;

        Watched* previous = nullptr;
        for (Watched& candidate : watched_) {
            if (candidate.bind.plugin_id == bind.plugin_id && candidate.bind.slot == bind.slot) {
                previous = &candidate;
                break;
            }
        }

        Watched watched;
        if (previous != nullptr && previous->bind.chord == bind.chord &&
            previous->bind.hold == bind.hold) {
            // Unchanged: the edge state comes across, so a sync published for
            // some other reason does not re-arm a key the player is holding.
            // The old entry stops owning the hold, so the sweep below cannot
            // release what has just been carried over.
            watched.down = previous->down;
            watched.holding = previous->holding;
            previous->holding = false;
        } else {
            if (previous != nullptr) Release(*previous, report);
            // Seeded from the keyboard as it is right now rather than from
            // nothing, which is what stops a bind firing on a key that was
            // already down when it appeared — the player rebinding to the key
            // they are holding, or a runtime that reconnected mid-press.
            watched.down = held_(bind.chord);
        }
        watched.bind = std::move(bind);
        next.push_back(std::move(watched));
    }

    // Whatever is not in the new set is gone, and a hold it was reporting has
    // to end — nothing else will ever say so.
    for (Watched& stale : watched_) Release(stale, report);
    watched_ = std::move(next);
}

void HotkeyWatch::Poll(bool watchable, const Report& report) {
    for (Watched& watched : watched_) {
        const bool down = watchable && held_(watched.bind.chord);
        if (down == watched.down) continue;
        watched.down = down;

        if (!watched.bind.hold) {
            // A toggle has no release: the runtime flips a switch it owns, and
            // reporting the way up would undo the press that came before it.
            if (down) report(watched.bind.plugin_id, watched.bind.slot, kToggleAction, true);
            continue;
        }

        if (down) {
            watched.holding = true;
            report(watched.bind.plugin_id, watched.bind.slot, kHoldAction, true);
        } else if (watched.holding) {
            watched.holding = false;
            report(watched.bind.plugin_id, watched.bind.slot, kHoldAction, false);
        }
    }
}

}  // namespace brownie::app
