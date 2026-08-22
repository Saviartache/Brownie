#include "game/FloatingText.h"

#include <algorithm>
#include <cstring>
#include <utility>

#include "game/PlayerRoute.h"

namespace brownie::game {
namespace {

/// `void MapObjectUIManager::ShowFloatingText(kind, text, colour, x, y, z)`, as
/// the compiler generated it — the overload a line of ours goes out through.
///
/// The three floats are an offset the reference implementation always passed as
/// zero, which puts the line where the game puts its own. They are named rather
/// than dropped because the prototype has to describe the method exactly: an
/// argument left out of a call is not an argument the callee stops reading.
using ShowFloatingTextFn = void (*)(void* self, std::int32_t kind, void* text,
                                    NullableColor32 colour, float x, float y, float z,
                                    void* method_info);

/// `void MapObjectUIManager::ShowFloatingText(kind, amount, colour, scale)` —
/// the overload every damage number and experience gain goes through, detoured
/// only so that its arguments can be read.
using ShowFloatingNumberFn = void (*)(void* self, std::int32_t kind, std::int32_t amount,
                                      NullableColor32 colour, float scale, void* method_info);

/// The one floating text in this process. See `AimHook.cpp` for why a detour has
/// nowhere else to keep this.
FloatingText* g_text = nullptr;

void ShowFloatingTextDetour(void* self, std::int32_t kind, void* text, NullableColor32 colour,
                            float x, float y, float z, void* method_info) {
    FloatingText* observer = g_text;
    if (observer == nullptr || observer->text_original() == nullptr) {
        // The detour outlived its owner, which `Remove` makes impossible on any
        // path it controls — but the check costs a comparison and the
        // alternative is a jump through a null trampoline.
        return;
    }
    observer->Observe(self, kind, method_info);
    reinterpret_cast<ShowFloatingTextFn>(observer->text_original())(self, kind, text, colour, x, y,
                                                                   z, method_info);
}

void ShowFloatingNumberDetour(void* self, std::int32_t kind, std::int32_t amount,
                              NullableColor32 colour, float scale, void* method_info) {
    FloatingText* observer = g_text;
    if (observer == nullptr || observer->number_original() == nullptr) {
        return;
    }
    // The style and the receiver only. **Not the `MethodInfo*`**: this is a
    // different method, and handing one method's to another is the mistake this
    // whole file is about not making.
    observer->Observe(self, kind, nullptr);
    reinterpret_cast<ShowFloatingNumberFn>(observer->number_original())(self, kind, amount, colour,
                                                                       scale, method_info);
}

}  // namespace

FloatingText::~FloatingText() {
    Remove();
}

void FloatingText::Bind(std::uint32_t view_handler_at, std::uint32_t gui_manager_at) {
    if (bound_.load(std::memory_order_relaxed)) {
        return;
    }
    view_handler_at_ = view_handler_at;
    gui_manager_at_ = gui_manager_at;
    bound_.store(true, std::memory_order_release);
}

Status FloatingText::Install(void* show_text, void* show_number) {
    if (g_text != nullptr && g_text != this) {
        return Error{ErrorCode::kInvalidArgument, "another floating text is already installed"};
    }
    if (live_.load(std::memory_order_relaxed)) {
        return {};
    }
    if (show_text == nullptr || show_number == nullptr) {
        return Error{ErrorCode::kNotReady, "the floating text methods have not both resolved"};
    }

    auto text = hooks::Hook::Create(show_text, reinterpret_cast<void*>(&ShowFloatingTextDetour));
    if (!text.ok()) {
        return text.error();
    }
    auto number =
        hooks::Hook::Create(show_number, reinterpret_cast<void*>(&ShowFloatingNumberDetour));
    if (!number.ok()) {
        return number.error();
    }
    text_hook_ = std::move(text).value();
    number_hook_ = std::move(number).value();

    // The trampolines and the owner are published before either detour is
    // enabled, because the game can draw a damage number the instant one is —
    // and a detour whose original is still null would swallow it.
    text_original_ = text_hook_.original<void*>();
    number_original_ = number_hook_.original<void*>();
    g_text = this;

    if (auto enabled = text_hook_.Enable(); !enabled.ok()) {
        Detach();
        return enabled.error();
    }
    if (auto enabled = number_hook_.Enable(); !enabled.ok()) {
        Detach();
        return enabled.error();
    }
    live_.store(true, std::memory_order_release);
    return {};
}

void FloatingText::Remove() noexcept {
    Detach();
}

void FloatingText::Detach() noexcept {
    // Cleared first, so a call already inside a detour finds nothing to record
    // rather than an object being taken apart.
    live_.store(false, std::memory_order_release);

    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it is replacing, so once these return no further
    // detour can begin.
    text_hook_ = hooks::Hook{};
    number_hook_ = hooks::Hook{};
    text_original_ = nullptr;
    number_original_ = nullptr;
    if (g_text == this) {
        g_text = nullptr;
    }
}

void FloatingText::Observe(const void* receiver, std::int32_t kind, void* method_info) noexcept {
    any_kind_.store(kind, std::memory_order_relaxed);
    if (receiver != nullptr && receiver == receiver_.load(std::memory_order_relaxed)) {
        own_kind_.store(kind, std::memory_order_relaxed);
        own_kind_seen_.store(true, std::memory_order_relaxed);
    }
    if (method_info != nullptr) {
        method_info_.store(method_info, std::memory_order_relaxed);
    }
}

std::int32_t FloatingText::kind() const noexcept {
    return own_kind_seen_.load(std::memory_order_relaxed)
               ? own_kind_.load(std::memory_order_relaxed)
               : any_kind_.load(std::memory_order_relaxed);
}

void FloatingText::Queue(std::string_view text, std::uint32_t rgba) noexcept {
    const std::size_t length = std::min(text.size(), kMaxLength - 1);

    const std::lock_guard<std::mutex> held{pending_lock_};
    if (length != 0) {
        std::memcpy(pending_.data(), text.data(), length);
    }
    pending_[length] = '\0';
    pending_rgba_ = rgba;
    has_pending_.store(true, std::memory_order_release);
}

void* FloatingText::ReceiverOf(void* local_player) const {
    void* handler = nullptr;
    if (!ReadField(local_player, view_handler_at_, handler) || handler == nullptr) {
        return nullptr;
    }
    void* manager = nullptr;
    if (!ReadField(handler, gui_manager_at_, manager)) {
        return nullptr;
    }
    return manager;
}

bool FloatingText::Apply(const Il2CppRuntime& game, void* local_player) {
    if (!bound() || !installed() || local_player == nullptr) {
        return false;
    }

    void* const receiver = ReceiverOf(local_player);
    if (receiver == nullptr) {
        return false;
    }
    // Published whether or not there is anything to show, because it is what
    // lets a detour tell this manager from every other one — and the style seen
    // on this one is the style a line of ours wants.
    receiver_.store(receiver, std::memory_order_relaxed);

    // Taken rather than peeked at, so the lock is not held across a call into
    // the game — and a message that cannot be shown is dropped rather than
    // retried, because the next tick of a counter says the same thing better.
    std::array<char, kMaxLength> text{};
    std::uint32_t rgba = 0;
    {
        const std::lock_guard<std::mutex> held{pending_lock_};
        if (!has_pending_.load(std::memory_order_relaxed)) {
            return false;
        }
        text = pending_;
        rgba = pending_rgba_;
        has_pending_.store(false, std::memory_order_relaxed);
    }

    // The colour is the one argument that is neither the game's nor read out of
    // it. Present rather than null, which is what overrides the style's colour.
    NullableColor32 colour{};
    colour.has_value = true;
    colour.rgba = rgba;

    const auto show = reinterpret_cast<ShowFloatingTextFn>(text_original_);
    void* const method_info = method_info_.load(std::memory_order_relaxed);
    const std::int32_t style = kind();

    // Once per receiver, and the receiver changes with the realm. See the note
    // in the header for what this is and what is not known about it.
    //
    // **The reference implementation showed nothing on the pass that primed,
    // and this one goes on to show.** That cost a second of a countdown that is
    // twenty seconds long, on the tick where somebody has just switched
    // something on and is looking for a sign that it worked — which is the one
    // tick that has to arrive.
    if (primed_ != receiver) {
        void* const empty = game.NewString("");
        if (empty == nullptr) {
            return false;
        }
        for (int call = 0; call < kPrimeCalls; ++call) {
            show(receiver, style, empty, colour, 0.0F, 0.0F, 0.0F, method_info);
        }
        primed_ = receiver;
    }

    void* const managed = game.NewString(text.data());
    if (managed == nullptr) {
        return false;
    }
    show(receiver, style, managed, colour, 0.0F, 0.0F, 0.0F, method_info);
    shown_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

}  // namespace brownie::game
