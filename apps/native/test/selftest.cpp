// A self-check for the pieces that have no game to run in.
//
// Not a test framework: the module is a DLL loaded into someone else's process,
// and pulling a framework in for the handful of things testable without a game
// would cost more than it returns. Anything that needs more than this belongs
// on the Node side, where the contract is already tested against a hostile peer.

#include <cstdio>
#include <cstring>
#include <array>
#include <cmath>
#include <cstddef>
#include <deque>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "app/Inspection.h"
#include "app/PlayerControl.h"
#include "core/Clock.h"
#include "core/ModuleImage.h"
#include "core/Result.h"
#include "game/AimHook.h"
#include "game/ArcaneStyle.h"
#include "game/ClassCatalog.h"
#include "game/GlowFields.h"
#include "game/HealthBarTint.h"
#include "game/OffsetTable.h"
#include "game/PlayerCollision.h"
#include "game/PlayerFields.h"
#include "game/PlayerMover.h"
#include "game/PlayerNoclip.h"
#include "game/ProjectileNoclip.h"
#include "game/ScreenProjection.h"
#include "hooks/Hook.h"
#include "hooks/SwapChain.h"
#include "ipc/Frame.h"
#include "ipc/FrameReader.h"
#include "ipc/Handshake.h"
#include "ipc/Json.h"
#include "ipc/SessionKey.h"
#include "overlay/ActionQueue.h"
#include "overlay/ControlRecord.h"
#include "overlay/InputQueue.h"
#include "overlay/DodgePicture.h"
#include "overlay/WorldRecord.h"

namespace {

int failures = 0;

void Check(bool condition, const char* what) {
    if (!condition) {
        std::printf("  FAIL  %s\n", what);
        ++failures;
    }
}

void FrameHeaderRoundTrips() {
    std::byte buffer[brownie::ipc::kHeaderBytes]{};
    const brownie::ipc::FrameHeader written{
        brownie::ipc::kVersion,
        static_cast<std::uint16_t>(brownie::ipc::MessageType::kControlAction),
        static_cast<std::uint16_t>(brownie::ipc::FrameFlags::kNone),
        7,
        42,
    };
    Check(brownie::ipc::WriteHeader(buffer, sizeof(buffer), written).ok(), "header writes");

    // 'BRWN' in the first four bytes, little-endian.
    Check(std::memcmp(buffer, "BRWN", 4) == 0, "magic is BRWN");

    const auto read = brownie::ipc::ReadHeader(buffer, sizeof(buffer));
    Check(read.ok(), "header reads back");
    Check(read.value().seq == 7, "sequence survives");
    Check(read.value().length == 42, "length survives");
    Check(read.value().type == 0x0202, "type survives");
}

void FrameHeaderRejectsWhatItMust() {
    std::byte buffer[brownie::ipc::kHeaderBytes]{};
    const brownie::ipc::FrameHeader header{brownie::ipc::kVersion, 1, 0, 1, 0};
    Check(brownie::ipc::WriteHeader(buffer, sizeof(buffer), header).ok(), "setup");

    Check(!brownie::ipc::ReadHeader(buffer, 4).ok(), "a truncated header is refused");

    std::byte wrong_magic[brownie::ipc::kHeaderBytes]{};
    std::memcpy(wrong_magic, buffer, sizeof(buffer));
    wrong_magic[0] = std::byte{0};
    Check(!brownie::ipc::ReadHeader(wrong_magic, sizeof(wrong_magic)).ok(), "bad magic is refused");

    std::byte wrong_version[brownie::ipc::kHeaderBytes]{};
    std::memcpy(wrong_version, buffer, sizeof(buffer));
    wrong_version[4] = std::byte{99};
    Check(!brownie::ipc::ReadHeader(wrong_version, sizeof(wrong_version)).ok(),
          "an unknown version is refused");

    std::byte reserved_set[brownie::ipc::kHeaderBytes]{};
    std::memcpy(reserved_set, buffer, sizeof(buffer));
    reserved_set[10] = std::byte{1};
    Check(!brownie::ipc::ReadHeader(reserved_set, sizeof(reserved_set)).ok(),
          "a non-zero reserved field is refused");

    std::byte huge[brownie::ipc::kHeaderBytes]{};
    std::memcpy(huge, buffer, sizeof(buffer));
    huge[19] = std::byte{0xFF};
    Check(!brownie::ipc::ReadHeader(huge, sizeof(huge)).ok(), "an oversized payload is refused");
}

void SequenceNumbersBehave() {
    brownie::ipc::SequenceSource source;
    Check(source.Take() == 1, "sequences start at 1");
    Check(source.Take() == 2, "and increase");
    Check(brownie::ipc::NextSeq(0xFFFFFFFFu) == 1, "and wrap to 1, never to 0");

    brownie::ipc::SequenceGuard guard;
    Check(guard.Accept(1).ok(), "an unbroken run is accepted");
    Check(guard.Accept(2).ok(), "and continues");
    Check(!guard.Accept(4).ok(), "a gap is refused");
    brownie::ipc::SequenceGuard replay;
    Check(replay.Accept(1).ok(), "setup");
    Check(!replay.Accept(1).ok(), "a replay is refused");
}

void ResultCarriesTheReason() {
    const brownie::Result<int> ok{7};
    Check(ok.ok() && ok.value() == 7, "a value comes back");

    const brownie::Result<int> failed{
        brownie::Error{brownie::ErrorCode::kProtocol, "because"}};
    Check(!failed.ok(), "a failure is not ok");
    Check(failed.error().code() == brownie::ErrorCode::kProtocol, "the code survives");
    Check(failed.value_or(-1) == -1, "and a fallback is available");
}

/// Builds a frame into `out`, returning how many bytes it wrote.
std::size_t BuildFrame(std::byte* out, std::uint32_t seq, const char* payload) {
    const auto length = static_cast<std::uint32_t>(std::strlen(payload));
    const brownie::ipc::FrameHeader header{brownie::ipc::kVersion, 0x0202, 0, seq, length};
    Check(brownie::ipc::WriteHeader(out, brownie::ipc::kHeaderBytes, header).ok(), "frame writes");
    std::memcpy(out + brownie::ipc::kHeaderBytes, payload, length);
    return brownie::ipc::kHeaderBytes + length;
}

void FrameReaderReassembles() {
    std::byte wire[256]{};
    std::size_t size = BuildFrame(wire, 1, "first");
    size += BuildFrame(wire + size, 2, "second");

    // A pipe read is not a message boundary: feed it one byte at a time, which
    // is the worst case the real thing can produce.
    brownie::ipc::FrameReader reader;
    int seen = 0;
    for (std::size_t i = 0; i < size; ++i) {
        reader.Push(wire + i, 1);
        for (;;) {
            auto frame = reader.Next();
            if (!frame.ok()) {
                Check(frame.error().code() == brownie::ErrorCode::kNotReady,
                      "an incomplete frame is not an error");
                break;
            }
            ++seen;
            Check(frame.value().header.seq == static_cast<std::uint32_t>(seen), "frames arrive in order");
        }
    }
    Check(seen == 2, "both frames were reassembled");
    Check(reader.buffered() == 0, "nothing is left over");
}

void FrameReaderRefusesGarbage() {
    brownie::ipc::FrameReader reader;
    std::byte garbage[brownie::ipc::kHeaderBytes]{};
    reader.Push(garbage, sizeof(garbage));

    const auto frame = reader.Next();
    Check(!frame.ok(), "a bad header is refused");
    Check(frame.error().code() == brownie::ErrorCode::kProtocol,
          "and refused as a protocol error, which closes the connection");
}

void JsonReadsWhatTheRuntimeWrites() {
    const std::string document =
        R"({"userId":"player.one","pid":1234,"ok":true,"response":"ab\"cd"})";

    const auto user = brownie::ipc::json::String(document, "userId");
    Check(user.ok() && user.value() == "player.one", "a string field reads back");
    const auto pid = brownie::ipc::json::Integer(document, "pid");
    Check(pid.ok() && pid.value() == 1234, "an integer field reads back");
    const auto ok = brownie::ipc::json::Boolean(document, "ok");
    Check(ok.ok() && ok.value(), "a boolean field reads back");

    Check(!brownie::ipc::json::String(document, "absent").ok(), "a missing field is refused");
    Check(!brownie::ipc::json::Integer(document, "userId").ok(),
          "a field of the wrong type is refused");

    // What `SetFeature` reads, and the reason it exists: a plugin may hand the
    // runtime a boolean, a number or a string, and this side has to carry all
    // three to a feature that knows which it is. Read as a string, the first
    // two were a refusal and a switch that silently did nothing.
    const auto as_text = brownie::ipc::json::Value(document, "ok");
    Check(as_text.ok() && as_text.value() == "true", "a boolean reads back as its token");
    const auto number = brownie::ipc::json::Value(document, "pid");
    Check(number.ok() && number.value() == "1234", "and a number as its digits");
    const auto text = brownie::ipc::json::Value(document, "userId");
    Check(text.ok() && text.value() == "player.one", "while a string reads back unquoted");
    Check(!brownie::ipc::json::Value(document, "absent").ok(),
          "and a missing field is still refused");
}

void JsonRoundTrips() {
    brownie::ipc::json::Writer writer;
    const std::string document =
        writer.Str("challenge", "deadbeef").Int("pid", 42).Bool("ok", false).Finish();

    const auto challenge = brownie::ipc::json::String(document, "challenge");
    Check(challenge.ok() && challenge.value() == "deadbeef", "what we write, we can read");
    const auto pid = brownie::ipc::json::Integer(document, "pid");
    Check(pid.ok() && pid.value() == 42, "and the number too");
    const auto ok = brownie::ipc::json::Boolean(document, "ok");
    Check(ok.ok() && !ok.value(), "and the boolean");
}

void HandshakeSignsUnambiguously() {
    brownie::ipc::Secret secret{};
    for (std::size_t i = 0; i < secret.size(); ++i) secret[i] = static_cast<std::uint8_t>(i);

    // Without a separator, ("ab","c") and ("a","bc") would sign identically.
    const auto left = brownie::ipc::Sign(secret, {"ab", "c"});
    const auto right = brownie::ipc::Sign(secret, {"a", "bc"});
    Check(left.ok() && right.ok(), "signing works");
    Check(left.value() != right.value(), "field boundaries are unambiguous");

    Check(brownie::ipc::MacEquals(left.value(), left.value()), "a MAC equals itself");
    Check(!brownie::ipc::MacEquals(left.value(), right.value()), "and not another");
    Check(!brownie::ipc::MacEquals(left.value(), "not hex"), "a malformed MAC compares false");

    Check(brownie::ipc::NormaliseUserId("  ") == "anonymous", "no user has an explicit name");
    Check(brownie::ipc::NormaliseUserId("player one") == "player_one",
          "the identity is normalised the same way on both sides");
}

// A function to detour. Three things about it are deliberate:
//
//   * `noinline` — an inlined target has no address to hook.
//   * The argument arrives through a `volatile`, so the optimiser cannot know
//     it. At -O2 a call with a literal argument can be replaced by its answer,
//     and a test whose result the compiler computed would pass with the hook
//     removed entirely.
//   * The body reads a `volatile` too, which makes it long enough to hook at
//     all. A detour overwrites the first bytes of the target, so a function
//     that compiles to `lea eax,[rcx+rcx]; ret` — four bytes — has nowhere to
//     put one, and MinHook refuses it. Real targets are whole functions; this
//     is the one way a synthetic test is unlike them.
volatile int g_zero = 0;
volatile int g_twenty_one = 21;

__attribute__((noinline)) int Doubled(int value) { return value * 2 + g_zero; }

using DoubledFn = int (*)(int);
DoubledFn g_original_doubled = nullptr;

__attribute__((noinline)) int TripledDetour(int value) {
    // Calls through to the original, which is the shape every real detour has:
    // observe or adjust, then let the game's own code run.
    return g_original_doubled(value) + value;
}

void HooksDivertAndRestore() {
    auto engine = brownie::hooks::HookEngine::Create();
    Check(engine.ok(), "the hook engine initialises");
    if (!engine.ok()) {
        return;
    }

    Check(Doubled(g_twenty_one) == 42, "the target does what it says before anything touches it");

    auto hook = brownie::hooks::Hook::Create(reinterpret_cast<void*>(&Doubled),
                                             reinterpret_cast<void*>(&TripledDetour));
    Check(hook.ok(), "a hook installs");
    if (!hook.ok()) {
        return;
    }
    auto installed = std::move(hook).value();
    g_original_doubled = installed.original<DoubledFn>();
    Check(g_original_doubled != nullptr, "and yields a trampoline to the original");

    // Installed but not enabled: nothing has been diverted yet.
    Check(Doubled(g_twenty_one) == 42, "installing alone does not divert anything");

    Check(installed.Enable().ok(), "the hook enables");
    Check(Doubled(g_twenty_one) == 63, "and the detour runs, with the original reachable through it");

    Check(installed.Disable().ok(), "the hook disables");
    Check(Doubled(g_twenty_one) == 42, "and the target is itself again");
}

void RemovingAHookIsScopeExit() {
    auto engine = brownie::hooks::HookEngine::Create();
    if (!engine.ok()) {
        Check(false, "the hook engine initialises");
        return;
    }

    {
        auto hook = brownie::hooks::Hook::Create(reinterpret_cast<void*>(&Doubled),
                                                 reinterpret_cast<void*>(&TripledDetour));
        Check(hook.ok(), "setup");
        if (!hook.ok()) {
            return;
        }
        auto installed = std::move(hook).value();
        g_original_doubled = installed.original<DoubledFn>();
        Check(installed.Enable().ok(), "setup");
        Check(Doubled(g_twenty_one) == 63, "the detour is live inside the scope");
    }

    // This is the property that matters most: an unload happens at a moment the
    // module does not choose, and a hook that outlives its owner leaves the game
    // jumping into memory that is no longer mapped.
    Check(Doubled(g_twenty_one) == 42, "leaving scope removed it");
}

void TwoEnginesAreRefused() {
    auto first = brownie::hooks::HookEngine::Create();
    Check(first.ok(), "the first engine initialises");
    // Two owners of one process-wide teardown means whichever destructor runs
    // first removes hooks the other still believes are installed.
    Check(!brownie::hooks::HookEngine::Create().ok(), "a second engine is refused");
}

void PresentResolvesToRealCode() {
    const auto present = brownie::hooks::FindPresent();
    if (!present.ok()) {
        // A machine with no usable Direct3D is a machine the overlay stays away
        // from. Reported, not failed — the resolver's job is to be right or to
        // say it cannot be, and saying so is the correct outcome here.
        std::printf("  note  Present not resolved: %.*s\n",
                    static_cast<int>(present.error().message().size()),
                    present.error().message().data());
        return;
    }
    std::printf("  note  IDXGISwapChain::Present at %p\n", present.value());
    Check(brownie::ModuleImage::Containing(present.value()).ok(),
          "the resolved address belongs to a loaded module");
}

void WorldRecordsAreReadStrictly() {
    brownie::overlay::WorldStatus status;
    Check(brownie::overlay::ParseWorldRecord("world|640|770|1250|-6425|37|12", status),
          "a world record parses");
    Check(status.known && status.hp == 640 && status.max_hp == 770, "health survives");
    Check(status.x_hundredths == 1250 && status.y_hundredths == -6425,
          "a negative coordinate survives");
    Check(status.entities == 37 && status.shots == 12, "the counts survive");
    // Defence was appended later, so a record without it is not malformed — it
    // is an older runtime, and "unknown" is not the same claim as "zero".
    Check(!status.defense_known, "a record without defence says so rather than reading zero");

    brownie::overlay::WorldStatus armoured;
    Check(brownie::overlay::ParseWorldRecord("world|640|770|1250|-6425|37|12|41", armoured),
          "a record with defence parses");
    Check(armoured.defense_known && armoured.defense == 41, "and carries it");

    // A record kind this build does not know is ignored, not refused: a newer
    // runtime must not break an older module.
    brownie::overlay::WorldStatus other;
    Check(!brownie::overlay::ParseWorldRecord("setting|a|b|c", other), "another kind is not ours");
    Check(!other.known, "and leaves nothing behind");

    // A truncated or malformed record must not half-fill the status: a position
    // of zero would draw the player at the corner of the map.
    brownie::overlay::WorldStatus partial;
    Check(!brownie::overlay::ParseWorldRecord("world|640|770", partial), "a short record is refused");
    Check(!partial.known, "and writes nothing");
    Check(!brownie::overlay::ParseWorldRecord("world|640|770|12.5|0|0|0", partial),
          "a field that is not a whole number is refused");
    Check(!brownie::overlay::ParseWorldRecord("world|640|770||0|0|0", partial),
          "an empty field is refused");
}

void WorldRecordsCarryBlastCounts() {
    brownie::overlay::WorldStatus status;
    Check(brownie::overlay::ParseWorldRecord("world|640|770|0|0|0|0|41|3|0|0|2|7|1", status),
          "a record with blast counts parses");
    Check(status.blast_stats_known, "and says so");
    Check(status.blasts == 2 && status.blasts_confirmed == 7 && status.blasts_unmatched == 1,
          "all three survive");

    // A runtime older than this build stops before them, which is not a
    // malformed record — the same rule the defence and shot counts follow.
    brownie::overlay::WorldStatus older;
    Check(brownie::overlay::ParseWorldRecord("world|640|770|0|0|0|0|41|3|0|0", older),
          "a record without them still parses");
    Check(!older.blast_stats_known, "and says it does not know rather than reading nought");
}

void WeaponRecordsCarryTheName() {
    brownie::overlay::WeaponStatus weapon;
    Check(brownie::overlay::ParseWeaponRecord("weapon|Bow%20of%20Covert%20Havens|2822|1600|440|704",
                                              weapon),
          "a weapon record parses");
    Check(weapon.known && weapon.described, "and says the catalog described it");
    Check(weapon.name == "Bow of Covert Havens", "the name is decoded");
    Check(weapon.object_type == 2822, "the type survives");
    Check(weapon.speed_hundredths == 1600 && weapon.lifetime_ms == 440,
          "so do the shot's own numbers");
    Check(weapon.range_hundredths == 704, "and the reach they come to");

    // An item the data files do not describe is still reported: "no entry for
    // this type" and "the numbers are wrong" want opposite fixes.
    brownie::overlay::WeaponStatus unknown;
    Check(brownie::overlay::ParseWeaponRecord("weapon||2822|0|0|0", unknown),
          "an undescribed weapon still parses");
    Check(unknown.known && !unknown.described, "and says which of the two it is");
    Check(unknown.object_type == 2822, "with the type to look up by hand");

    brownie::overlay::WeaponStatus other;
    Check(!brownie::overlay::ParseWeaponRecord("world|1|2|3|4|5|6", other),
          "another kind is not ours");
    Check(!brownie::overlay::ParseWeaponRecord("weapon|Bow|2822|1600", other),
          "a short record is refused");
    Check(!other.known, "and writes nothing");
}

void MoveRecordsAreReadStrictly() {
    brownie::overlay::MoveCommand move;
    Check(brownie::overlay::ParseMoveRecord("move|10723|-16456|600|400", move),
          "a move record parses");
    Check(move.x_hundredths == 10723 && move.y_hundredths == -16456,
          "in hundredths of a tile, sign and all");
    Check(move.speed_hundredths == 600 && move.hold_ms == 400, "with a speed and a lifetime");
    Check(!move.from_player, "and a runtime that says nothing means a place on the map");

    // The planner's own commands, which are a heading rather than a place: the
    // runtime hears where the player is five times a second and cannot turn one
    // into the other without naming somewhere already walked past.
    Check(brownie::overlay::ParseMoveRecord("move|-45|80|600|120|1", move),
          "a move measured from the player parses");
    Check(move.from_player, "and says so");
    Check(move.x_hundredths == -45 && move.y_hundredths == 80, "with the offset it carries");
    Check(brownie::overlay::ParseMoveRecord("move|1|2|600|400|0", move),
          "and nought is the map, said out loud");
    Check(!move.from_player, "which is the same as not saying it");

    // Half a destination is a destination somewhere else, so a short or
    // malformed record leaves the last one alone rather than steering by it.
    brownie::overlay::MoveCommand kept = move;
    Check(!brownie::overlay::ParseMoveRecord("move|10723|-16456|600", kept),
          "a record missing a field is refused");
    Check(kept.hold_ms == 400, "and changes nothing");
    Check(!brownie::overlay::ParseMoveRecord("move|1.5|2|600|400", kept),
          "and so is one that is not whole");
    Check(!brownie::overlay::ParseMoveRecord("world|1|2|3|4|5|6", kept),
          "another kind is not a move");

    // A step with no speed or no lifetime is not a slower walk; it is a walk
    // that never happens, and saying so beats issuing a zero.
    Check(!brownie::overlay::ParseMoveRecord("move|1|2|0|400", kept), "no speed is refused");
    Check(!brownie::overlay::ParseMoveRecord("move|1|2|600|0", kept), "and no lifetime too");
}

void AimRecordsAreReadStrictly() {
    brownie::overlay::AimCommand aim;
    Check(brownie::overlay::ParseAimRecord("aim|10723|-16456|350", aim), "an aim record parses");
    Check(aim.x_hundredths == 10723 && aim.y_hundredths == -16456,
          "in hundredths of a tile, sign and all");
    Check(aim.hold_ms == 350, "with a lifetime");

    brownie::overlay::AimCommand kept = aim;
    Check(!brownie::overlay::ParseAimRecord("aim|1|2", kept),
          "a record missing a field is refused");
    Check(kept.hold_ms == 350, "and changes nothing");
    Check(!brownie::overlay::ParseAimRecord("move|1|2|600|350", kept), "a move is not an aim");
    Check(!brownie::overlay::ParseAimRecord("aim|1|2|0", kept), "no lifetime is refused");
}

/// A text record carries its message whole, separators and all.
///
/// The point of putting the numbers first: the reference implementation packed
/// its colour into the message as a suffix and had to unpack it again, which is
/// a parser inside a payload. Here the message is whatever is left.
void TextRecordsCarryTheWholeMessage() {
    brownie::overlay::TextCommand text;
    Check(brownie::overlay::ParseTextRecord("text|32|220|0|Noclip - 3s left", text),
          "a text record parses");
    Check(text.red == 32 && text.green == 220 && text.blue == 0, "with its three channels");
    Check(text.text == "Noclip - 3s left", "and its message");

    Check(brownie::overlay::ParseTextRecord("text|255|0|25|a|b|c", text),
          "a message may contain separators");
    Check(text.text == "a|b|c", "and keeps every one of them");

    brownie::overlay::TextCommand kept = text;
    Check(!brownie::overlay::ParseTextRecord("text|1|2|3", kept), "a record with no message");
    Check(!brownie::overlay::ParseTextRecord("text|1|2|3|", kept), "nor an empty one");
    Check(!brownie::overlay::ParseTextRecord("text|1|2|300|hi", kept),
          "nor a channel outside a byte");
    Check(!brownie::overlay::ParseTextRecord("text|1|2|-1|hi", kept), "in either direction");
    Check(!brownie::overlay::ParseTextRecord("aim|1|2|3|hi", kept), "an aim is not a text");
    Check(text.text == "a|b|c", "and a refusal changes nothing");
}

/// The dodge picture is drawn whole or not at all, and lets go on its own.
///
/// Both halves matter and for the same reason: a picture of two moments is a
/// picture of neither, and a picture of a fight that ended is worse than none.
/// Paths and circles share one bracket because they describe one plan.
void DodgePictureCommitsWholeSetsAndExpires() {
    brownie::overlay::DodgePicture picture;
    Check(picture.trails().empty(), "a fresh picture has no paths");
    Check(picture.marks().empty(), "and no circles");
    Check(!picture.fresh(1000), "and is not worth drawing");

    Check(picture.Apply("dodge-begin", 1000), "a set opens");
    // One record per kind, several things in each: the packing is the whole
    // reason the picture arrives fast enough to be worth drawing.
    Check(picture.Apply("trails|1000,1000,2000,1100,2000|500,0,0,100,100", 1000),
          "two paths in one record are taken");
    Check(picture.Apply("marks|3,1000,2000,250,1000|1,0,0,300,1000", 1000),
          "and two circles in another");
    Check(picture.trails().empty(), "and neither is visible until the set closes");
    Check(picture.marks().empty(), "on either half");
    Check(picture.Apply("dodge-end", 1000), "the set closes");
    Check(picture.trails().size() == 2, "and commits together");
    Check(picture.marks().size() == 2, "both halves of it");
    Check(picture.fresh(1000), "and is worth drawing");

    const brownie::overlay::ShotTrail& trail = picture.trails()[0];
    Check(trail.points.size() == 2, "with both of its points");
    Check(std::fabs(trail.points[0].x - 10.0F) < 0.001F, "in tiles rather than hundredths");
    Check(std::fabs(trail.points[1].y - 20.0F) < 0.001F, "on both axes");
    Check(std::fabs(trail.life - 1.0F) < 0.001F, "and its life as a fraction");

    const brownie::overlay::DodgeMark& mark = picture.marks()[0];
    Check(mark.kind == brownie::overlay::MarkKind::KeepAway, "and the circle knows what it is");
    Check(std::fabs(mark.centre.x - 10.0F) < 0.001F, "where it is, in tiles");
    Check(std::fabs(mark.radius_tiles - 2.5F) < 0.001F, "and how wide");
    Check(std::fabs(mark.ahead - 1.0F) < 0.001F, "with nothing to wait for");
    // What an older runtime sends, and what it has to mean: a circle that sits
    // where it was stated, belonging to nothing that moves.
    Check(!mark.follows_player, "a circle says nothing about the player by default");
    Check(mark.velocity_x == 0.0F && mark.velocity_y == 0.0F, "and nothing about moving");
    Check(picture.committed_at_ms() == 1000, "and the set remembers when it was stated");

    // The rule every reading on this link follows: silence means stop.
    Check(!picture.fresh(1000 + brownie::overlay::kPictureFreshMs + 1), "an old set goes stale");

    // **What keeps the picture continuous between two publishes.** The circles
    // round the character are drawn wherever the character is, and a monster's
    // is carried by the velocity the planner scored the place with.
    Check(picture.Apply("dodge-begin", 1500), "a set with motion in it opens");
    Check(picture.Apply("marks|1,0,0,300,1000,1,0,0|2,500,600,50,1000,0,-250,125", 1500),
          "circles carrying an anchor and a velocity are taken");
    Check(picture.Apply("dodge-end", 1500), "and it closes");
    Check(picture.marks().size() == 2, "with both of them");
    Check(picture.marks()[0].follows_player, "the ring round the character says so");
    Check(!picture.marks()[1].follows_player, "and a monster's does not");
    Check(std::fabs(picture.marks()[1].velocity_x + 2.5F) < 0.001F,
          "which moves in tiles a second, sign and all");
    Check(std::fabs(picture.marks()[1].velocity_y - 1.25F) < 0.001F, "on both axes");

    // A velocity nobody meant would carry a circle off the map. Held still
    // instead of dropped: one drawn where it was stated says more than none.
    Check(picture.Apply("dodge-begin", 1600), "a set with a nonsense velocity opens");
    Check(picture.Apply("marks|2,0,0,100,1000,0,999999,0", 1600), "and the circle is taken");
    Check(picture.Apply("dodge-end", 1600), "and it closes");
    Check(picture.marks().size() == 1, "with the circle in it");
    Check(picture.marks()[0].velocity_x == 0.0F, "standing still");

    // A path with one end is not a path, and a record outside a set is not one
    // either — both are dropped rather than drawn. A circle whose kind this
    // build does not know is dropped for the same reason: drawing it as
    // whichever shape came first would be inventing information.
    Check(picture.Apply("dodge-begin", 2000), "another set opens");
    Check(picture.Apply("trails|500,100,100", 2000), "a one-point path is taken");
    Check(picture.Apply("trails|500,100,100,abc,200", 2000), "so is one that does not parse");
    Check(picture.Apply("marks|99,100,100,100,1000", 2000), "so is a circle of no known kind");
    Check(picture.Apply("marks|1,100,100", 2000), "and one missing its fields");
    Check(picture.Apply("marks|1,100,100,-50,1000", 2000), "and one of negative width");
    Check(picture.Apply("dodge-end", 2000), "and it closes");
    Check(picture.trails().empty(), "with none of them in it");
    Check(picture.marks().empty(), "on either half");

    Check(picture.Apply("trails|1000,0,0,100,100", 3000), "a path outside a set is ours");
    Check(picture.Apply("marks|1,0,0,100,1000", 3000), "and so is a circle");
    Check(picture.trails().empty(), "and neither is drawn");
    Check(picture.marks().empty(), "on either half");
    Check(!picture.Apply("world|1|2", 3000), "and a world record is somebody else's");

    picture.Reset();
    Check(!picture.fresh(3000), "a reset drops what was committed");
}

/// Player noclip refuses what it cannot detour, and either detour stands alone.
///
/// The opposite of the pair above, and deliberately: an overridden answer lasts
/// exactly as long as the call it answers, so there is no half-written state for
/// a missing second detour to leave behind.
void PlayerNoclipRefusesWhatItCannotDetour() {
    brownie::game::PlayerNoclip noclip;
    Check(!noclip.installed(), "a fresh player noclip is not installed");
    Check(noclip.hooked() == 0, "and has nothing hooked");
    Check(!noclip.enabled(), "and is switched off");
    Check(noclip.allowed() == 0, "and has allowed nothing");

    Check(!noclip.Install({}).ok(), "no predicate at all installs nothing");
    Check(!noclip.installed(), "so it stays uninstalled");

    std::vector<brownie::game::WalkabilityPredicate> tooMany(
        brownie::game::PlayerNoclip::kMaxGates + 1);
    Check(!noclip.Install(tooMany).ok(), "nor do more predicates than there are detours");

    // Counted only while the feature is on, which is what makes the count mean
    // "this did something" rather than "this was called".
    Check(!noclip.Override(), "a switched-off noclip forces nothing");
    Check(noclip.allowed() == 0, "and counts nothing");

    noclip.SetEnabled(true);
    Check(noclip.Override(), "a switched-on one forces the answer");
    Check(noclip.Override(), "however many gates ask");
    Check(noclip.allowed() == 2, "counting one total across them");

    // Out of range rather than merely unhooked: a detour index can only come
    // from this object, but the check is what a stray call is caught by.
    Check(noclip.original(brownie::game::PlayerNoclip::kMaxGates) == nullptr,
          "a gate past the last has nothing to call through");
}

/// The aim hook redirects nothing until it is told to, and nothing that is not
/// the player.
///
/// Its detours cannot run without a game, but the decision they make — "is this
/// shot one to redirect" — is ordinary state, and it is the part that must not
/// be wrong: a hook that answered for every object would point every shot in
/// the realm at one monster.
void AimRedirectsOnlyWhatItWasGiven() {
    brownie::game::AimHook hook;
    float angle = 0.0F;

    int player = 0;
    int somebody_else = 0;

    Check(!hook.installed(), "a fresh aim hook is not installed");
    Check(!hook.AngleFor(&player, angle), "and redirects nothing");

    hook.Aim(&player, 1.25F, brownie::NowMs() + 1000);
    Check(hook.AngleFor(&player, angle), "an aimed player is redirected");
    Check(angle == 1.25F, "to the angle it was given");
    Check(!hook.AngleFor(&somebody_else, angle), "and nothing else is");
    Check(hook.redirected() == 1, "each redirected shot is counted");

    hook.Clear();
    Check(!hook.AngleFor(&player, angle), "a cleared aim redirects nothing");

    // An aim that has run out is the player's own again, whatever the frame
    // that published it is doing.
    hook.Aim(&player, 1.25F, brownie::NowMs());
    Check(!hook.AngleFor(&player, angle), "an expired aim redirects nothing");

    // Aiming at nothing is not aiming at the origin.
    hook.Aim(nullptr, 0.5F, brownie::NowMs() + 1000);
    Check(!hook.AngleFor(nullptr, angle), "a null player is not a target");
}

/// A swap takes one square and puts back exactly what it took.
///
/// The detours cannot run without a game, but what they write can: this is the
/// only thing projectile noclip changes in the game's memory, and the pairing
/// is the whole of its safety. A take that is not put back is a square that
/// stays passable for the rest of the map.
void ATileSwapPutsBackWhatItTook() {
    // Offset zero of a managed object is its header and never a field, which is
    // what lets a route read zero as "not resolved". The fakes are laid out to
    // match, so no offset below is one the real thing could not have.
    struct FakeTile {
        void* header;
        std::int32_t layer;
    };
    struct FakeShot {
        void* header;
        std::uint8_t active;
        void* tile;
    };

    FakeTile tile{nullptr, 12};
    FakeShot shot{nullptr, 1, &tile};

    brownie::game::ProjectileTileRoute route;
    route.active_at = static_cast<std::uint32_t>(offsetof(FakeShot, active));
    route.tile_at = static_cast<std::uint32_t>(offsetof(FakeShot, tile));
    route.layer_at = static_cast<std::uint32_t>(offsetof(FakeTile, layer));
    Check(route.complete(), "a route with all three offsets is complete");

    brownie::game::TileSwap swap;
    Check(swap.Apply(&shot, route), "a shot against a wall takes the square");
    Check(tile.layer == brownie::game::TileSwap::kPassableLayer, "and makes it passable");
    Check(swap.held(), "and says it is holding one");
    Check(!swap.Apply(&shot, route), "a second take while one is held is refused");

    swap.Restore();
    Check(tile.layer == 12, "restoring puts back the game's own layer");
    Check(!swap.held(), "and lets go of the square");
    swap.Restore();
    Check(tile.layer == 12, "restoring twice writes nothing");

    // The guard: a shot that is not in flight is not one to change a square for.
    shot.active = 0;
    Check(!swap.Apply(&shot, route), "a shot that is not in flight takes nothing");
    Check(tile.layer == 12, "and leaves the square alone");

    // Half a route is no route. A feature that wrote at an offset nothing
    // resolved would be writing into whatever happens to be there.
    shot.active = 1;
    brownie::game::ProjectileTileRoute partial = route;
    partial.layer_at = 0;
    Check(!partial.complete(), "a route missing an offset is not complete");
    Check(!swap.Apply(&shot, partial), "and nothing is written through it");
    Check(tile.layer == 12, "so the square is untouched");
}

/// Projectile noclip installs both detours or neither.
///
/// The inner detour is what makes a square passable and the outer is what puts
/// it back, so half of this feature is worse than none of it — the map would
/// keep the holes.
void ProjectileNoclipInstallsBothOrNeither() {
    brownie::game::ProjectileNoclip noclip;
    Check(!noclip.installed(), "a fresh projectile noclip is not installed");
    Check(!noclip.enabled(), "and is switched off");
    Check(noclip.passed() == 0, "and has let nothing through");

    // Never dereferenced: every case below is refused before MinHook is asked
    // for anything.
    int method = 0;
    brownie::game::ProjectileTileRoute route;
    route.active_at = 8;
    route.tile_at = 16;
    route.layer_at = 8;

    Check(!noclip.Install(route, nullptr, &method).ok(), "one method alone installs nothing");
    Check(!noclip.Install(route, &method, nullptr).ok(), "whichever of the two it is");
    Check(!noclip.Install(brownie::game::ProjectileTileRoute{}, &method, &method).ok(),
          "nor does a route with nothing resolved");
    Check(!noclip.installed(), "so it stays uninstalled");
}

/// What a frame's reads cost, measured rather than argued about.
///
/// Every read of the player goes through `ReadProcessMemory` — a system call —
/// because the pointers it follows are freed between realms and a dereference
/// of one would take the game down with us. That makes the *number* of reads
/// per frame the thing to keep down, and this says what one is worth.
///
/// The paired position read is the point: `x` and `y` are adjacent floats, so
/// eight bytes in one call answers both. The two are timed side by side here so
/// the saving is a measurement rather than a claim.
void ReadCostIsMeasured() {
    struct FakeObject {
        float x;
        float y;
    };
    FakeObject object{12.5F, -3.25F};

    brownie::game::PlayerRoute adjacent{};
    adjacent.x_at = 0;
    adjacent.y_at = sizeof(float);

    brownie::game::PlayerRoute apart{};
    apart.x_at = 0;
    // Not neighbours, so the same call has to make two reads.
    apart.y_at = sizeof(float) + 1;

    constexpr int kRuns = 20000;
    float x = 0.0F;
    float y = 0.0F;

    const auto time = [&](const brownie::game::PlayerRoute& route) {
        LARGE_INTEGER started{};
        LARGE_INTEGER ended{};
        ::QueryPerformanceCounter(&started);
        for (int i = 0; i < kRuns; ++i) {
            if (!brownie::game::ReadPosition(&object, route, x, y)) {
                return -1.0;
            }
        }
        ::QueryPerformanceCounter(&ended);
        LARGE_INTEGER frequency{};
        ::QueryPerformanceFrequency(&frequency);
        return static_cast<double>(ended.QuadPart - started.QuadPart) * 1e9 /
               (static_cast<double>(frequency.QuadPart) * kRuns);
    };

    const double paired = time(adjacent);
    // Checked before the split run, which reads `y` from an offset chosen to
    // make it two calls rather than to hold anything.
    Check(x == 12.5F, "a paired position read gets x");
    Check(y == -3.25F, "and y");

    const double split = time(apart);
    Check(paired > 0.0 && split > 0.0, "both position reads succeed");
    std::printf("  note  position read %.0f ns paired, %.0f ns split\n", paired, split);
}

void UnbindableCallersStayQuiet() {
    // Neither calls anything until it has been given a method, and neither can
    // be given one that does not exist. That is what makes an unresolved key a
    // feature that goes quiet rather than one that jumps into nothing.
    brownie::game::PlayerMover mover;
    mover.Bind(nullptr);
    Check(!mover.bound(), "a mover cannot be bound to no method");
    Check(!mover.StepTowards(brownie::game::PlayerLocation{}, 1.0F, 1.0F, 0.5F),
          "and an unbound mover steps nowhere");

    brownie::game::AimHook hook;
    Check(!hook.Install(nullptr, nullptr).ok(), "nor can an aim hook detour nothing");
    Check(!hook.installed(), "so it stays uninstalled");
}

void ControlFieldsRoundTrip() {
    // The exact escaping `encodeURIComponent` produces, because the runtime
    // decodes with `decodeURIComponent` and anything else would not survive.
    Check(brownie::overlay::EncodeField("Warn below (% health)") ==
              "Warn%20below%20(%25%20health)",
          "a label encodes the way the runtime decodes");
    Check(brownie::overlay::EncodeField("a|b") == "a%7Cb", "a separator cannot escape its field");

    const auto fields = brownie::overlay::SplitRecord("setting|low-health|Warn%20below%20(%25)");
    Check(fields.size() == 3, "a record splits into its fields");
    Check(fields[2] == "Warn below (%)", "and each one decodes");

    // The built-in font has no glyph past ASCII, so decoding is where text that
    // cannot be drawn stops being text that will be drawn.
    const auto wide =
        brownie::overlay::SplitRecord("setting|x|%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82");
    Check(wide[2] == "????????????",
          "non-ASCII becomes question marks rather than reaching the font");

    const auto malformed = brownie::overlay::SplitRecord("setting|x|100%");
    Check(malformed[2] == "100%", "a malformed escape is kept verbatim rather than dropped");

    Check(brownie::overlay::BuildAction("toggle", {"low-health", "1"}) == "toggle|low-health|1",
          "an action is built in the same shape");
}

void AControlSyncIsAllOrNothing() {
    brownie::overlay::ControlMirror mirror;

    Check(!mirror.Apply("world|1|2|3|4|5|6"), "a world record is not ours");
    Check(!mirror.Apply("something-new|1"), "and neither is a kind this build predates");

    Check(!mirror.Apply("sync-begin"), "a sync opening changes nothing yet");
    Check(!mirror.Apply("plugin|low-health|Low%20Health|utility|0|loaded|"),
          "nor does a plugin inside it");
    Check(!mirror.Apply(
              "setting|low-health|thresholdPercent|Warn%20below|range|n|40|1|5|1|95|5|0|||"),
          "nor a setting");
    Check(mirror.plugins().empty(), "nothing is visible until the sync closes");

    Check(mirror.Apply("sync-end"), "closing the sync commits it");
    Check(mirror.version() == 1, "and counts as one sync");
    Check(mirror.plugins().size() == 1, "the plugin is there");

    const auto& plugin = mirror.plugins().front();
    Check(plugin.id == "low-health" && plugin.name == "Low Health", "with its name decoded");
    Check(plugin.category == "utility" && !plugin.enabled && plugin.state == "loaded",
          "and its state");
    // That record stopped before `enableable`, which was appended later. A
    // runtime that predates the field could not have disabled a toggle anyway,
    // so its plugins are all offered rather than all locked.
    Check(plugin.enableable, "a plugin from a runtime without the field is still offered");
    Check(plugin.settings.size() == 1, "and its setting");

    const auto& setting = plugin.settings.front();
    Check(setting.key == "thresholdPercent" && setting.label == "Warn below", "labelled");
    Check(setting.kind == brownie::overlay::SettingKind::kRange, "as a range");
    Check(setting.value_type == "n" && setting.value == "40", "carrying its value and type");
    Check(setting.number == 40.0F, "which also reads as a number");
    Check(setting.has_min && setting.min == 5.0F, "with a lower bound");
    Check(setting.has_max && setting.max == 95.0F && setting.step == 5.0F,
          "an upper one and a step");
    Check(!setting.advanced && setting.options.empty(), "and nothing else claimed");
}

void AControlSyncReplacesRatherThanMerges() {
    brownie::overlay::ControlMirror mirror;
    Check(!mirror.Apply("sync-begin"), "open");
    Check(!mirror.Apply("plugin|a|A|utility|1|enabled|"), "one plugin");
    Check(!mirror.Apply("plugin|b|B|utility|0|loaded|"), "and another");
    Check(mirror.Apply("sync-end"), "commit");
    Check(mirror.plugins().size() == 2, "both are listed");

    // The second sync mentions only one of them. Anything a sync does not
    // mention is gone — that is what makes the list the runtime's, rather than
    // a union of everything ever seen.
    Check(!mirror.Apply("sync-begin"), "open again");
    Check(!mirror.Apply("plugin|a|A|utility|1|enabled|"), "just the one this time");
    Check(mirror.Apply("sync-end"), "commit again");
    Check(mirror.plugins().size() == 1 && mirror.plugins().front().id == "a",
          "the unmentioned plugin is gone");
    Check(mirror.version() == 2, "two syncs have landed");

    // A record outside a sync is ignored rather than applied to the committed
    // list: a commit is atomic, not usually atomic.
    Check(!mirror.Apply("plugin|c|C|utility|0|loaded|"), "a stray plugin record is ignored");
    Check(mirror.plugins().size() == 1, "and leaves the list alone");
}

void ACommitOrdersPluginsByCategory() {
    brownie::overlay::ControlMirror mirror;
    Check(!mirror.Apply("sync-begin"), "open");
    // Deliberately interleaved, the way a plugin directory hands them over.
    Check(!mirror.Apply("plugin|dodge|Dodge|movement|1|enabled|"), "a movement plugin");
    Check(!mirror.Apply("plugin|nexus|Nexus|commands|1|enabled|"), "a command");
    Check(!mirror.Apply("plugin|aim|Aim|combat|1|enabled|"), "a combat plugin");
    Check(!mirror.Apply("plugin|noclip|Noclip|movement|0|loaded|"), "another movement plugin");
    Check(!mirror.Apply("plugin|odd|Odd|something-new|0|loaded|"), "and one this build predates");
    Check(!mirror.Apply("plugin|glow|Glow|visuals|1|enabled|"), "a visuals plugin");
    Check(mirror.Apply("sync-end"), "commits");

    const auto& plugins = mirror.plugins();
    Check(plugins.size() == 6, "all of them survive the ordering");
    Check(plugins[0].id == "aim", "combat comes first");
    Check(plugins[1].id == "dodge" && plugins[2].id == "noclip",
          "movement follows, in the order the runtime sent it");
    Check(plugins[3].id == "glow", "then visuals");
    Check(plugins[4].id == "nexus", "then commands");
    // An unknown category is a newer runtime's, not a broken one. It is filed
    // last rather than dropped or scattered through the known groups.
    Check(plugins[5].id == "odd", "and an unknown category is filed last");
}

void AFailedSetupIsTheOnlyPluginPutOutOfReach() {
    brownie::overlay::ControlMirror mirror;
    Check(!mirror.Apply("sync-begin"), "open");
    // Its `setup` threw: it registered nothing, so switching it on would run
    // nothing at all.
    Check(!mirror.Apply("plugin|dead|Dead|utility|0|failed|bad%20setup|0"), "one that cannot run");
    // This one ran, then threw often enough to be switched off. Its
    // subscriptions are intact, so pressing the toggle is a retry.
    Check(!mirror.Apply("plugin|noisy|Noisy|utility|0|failed|disabled%20after%2010|1"),
          "and one that can be retried");
    Check(mirror.Apply("sync-end"), "commits");

    const auto& plugins = mirror.plugins();
    Check(!plugins[0].enableable, "the failed setup is out of reach");
    Check(plugins[1].enableable, "the failed handlers are not");
    Check(plugins[0].error == "bad setup" && plugins[1].state == "failed",
          "both still say what happened");
}

void AControlRecordThatSaysTooLittleIsRefused() {
    brownie::overlay::ControlMirror mirror;
    Check(!mirror.Apply("sync-begin"), "open");
    Check(!mirror.Apply("plugin|a|A|utility"), "a plugin record missing fields");
    Check(mirror.Apply("sync-end"), "still closes the sync");
    Check(mirror.plugins().empty(), "having added no half-described plugin");

    // A setting whose plugin was never described has nothing to belong to.
    Check(!mirror.Apply("sync-begin"), "open");
    Check(!mirror.Apply("setting|ghost|k|K|text|s|hello"), "an orphan setting");
    Check(mirror.Apply("sync-end"), "commits");
    Check(mirror.plugins().empty(), "with nothing invented to hold it");

    // Trailing fields are optional: a runtime older than this build stops early,
    // and everything it did send must still be read.
    Check(!mirror.Apply("sync-begin"), "open");
    Check(!mirror.Apply("plugin|a|A|utility|1|enabled|"), "a plugin");
    Check(!mirror.Apply("setting|a|k|K|text|s|hello"), "and a setting with no trailing fields");
    Check(mirror.Apply("sync-end"), "commits");
    Check(mirror.plugins().front().settings.size() == 1, "the setting is there");
    Check(mirror.plugins().front().settings.front().value == "hello", "with its value");
    Check(!mirror.plugins().front().settings.front().has_min, "and no bounds claimed");
}

void SelectOptionsAndVisibilityAreRead() {
    brownie::overlay::ControlMirror mirror;
    Check(!mirror.Apply("sync-begin"), "open");
    Check(!mirror.Apply("plugin|a|A|utility|1|enabled|"), "a plugin");
    Check(!mirror.Apply(
              "setting|a|mode|Mode|select|s|fast|0|0|0|0|0|0|Fast%3Dfast%3BSlow%3Dslow||"),
          "a select");
    // Trailing empties are the options and the group, which this one does not
    // use: `visibleWhen` is the last field and is read by position, not by
    // being last.
    Check(!mirror.Apply("setting|a|tune|Tune|range|n|1|1|0|1|5|1|0|||mode%3Dfast%7Cslow"),
          "and one that depends on it");
    Check(mirror.Apply("sync-end"), "commits");

    const auto& settings = mirror.plugins().front().settings;
    Check(settings.size() == 2, "both are there");
    Check(settings[0].options.size() == 2, "the select has its options");
    Check(settings[0].options[0].label == "Fast" && settings[0].options[0].value == "fast",
          "each with a label and the value to send back");
    Check(settings[1].visible_key == "mode", "the dependency names its setting");
    Check(settings[1].visible_values.size() == 2 && settings[1].visible_values[1] == "slow",
          "and every value that reveals it");
}

void MultiSelectIsReadAsAChecklist() {
    brownie::overlay::ControlMirror mirror;
    Check(!mirror.Apply("sync-begin"), "open");
    Check(!mirror.Apply("plugin|a|A|movement|1|enabled|"), "a plugin");
    // Same shape as a select — a string value and an options list — but its own
    // kind, so the overlay draws a checklist rather than a combo. The value is
    // the chosen keys joined by commas.
    Check(!mirror.Apply("setting|a|picks|Picks|multiSelect|s|b|0|0|0|0|0|0|A%3Da%3BB%3Db||"),
          "a multi-select");
    Check(mirror.Apply("sync-end"), "commits");

    const auto& row = mirror.plugins().front().settings.front();
    Check(row.kind == brownie::overlay::SettingKind::kMultiSelect, "kept as a multi-select");
    Check(row.value == "b", "with its chosen keys as the value");
    Check(row.options.size() == 2 && row.options[1].label == "B" && row.options[1].value == "b",
          "and every option to tick");
}

void ActionQueueHandsInteractionsOver() {
    brownie::overlay::ActionQueue queue;
    queue.Push("toggle|a|1");
    queue.Push("setting|a|k|n|40");

    const auto drained = queue.Drain();
    Check(drained.size() == 2, "both are handed over");
    Check(drained[0] == "toggle|a|1" && drained[1] == "setting|a|k|n|40", "oldest first");
    Check(queue.Drain().empty(), "and draining again yields nothing");
    Check(queue.TakeDropped() == 0, "nothing was lost");
}

void ActionQueueKeepsTheNewestWhenFull() {
    brownie::overlay::ActionQueue queue;
    for (std::size_t i = 0; i <= brownie::overlay::ActionQueue::kCapacity; ++i) {
        queue.Push(std::to_string(i));
    }

    const auto drained = queue.Drain();
    Check(drained.size() == brownie::overlay::ActionQueue::kCapacity, "the queue stays bounded");
    // The oldest goes, not the newest: these are a person's intentions, and the
    // newest is the one they still hold.
    Check(drained.front() == "1", "the oldest was the one dropped");
    Check(drained.back() == std::to_string(brownie::overlay::ActionQueue::kCapacity),
          "and the newest survived");
    Check(queue.TakeDropped() == 1, "the loss is counted");
    Check(queue.TakeDropped() == 0, "and counted once");
}

void InputQueueHandsMessagesOver() {
    brownie::overlay::InputQueue queue;
    Check(queue.Push({WM_KEYDOWN, 'A', 0}), "a message is accepted");
    Check(queue.Push({WM_KEYUP, 'A', 0}), "and another");
    Check(queue.size() == 2, "both are pending");

    std::array<brownie::overlay::InputMessage, brownie::overlay::InputQueue::kCapacity> drained{};
    Check(queue.Drain(drained) == 2, "a drain takes everything");
    Check(drained[0].message == WM_KEYDOWN && drained[1].message == WM_KEYUP,
          "oldest first — input order is the whole point");
    Check(queue.size() == 0, "and leaves nothing behind");
    Check(queue.Drain(drained) == 0, "draining an empty queue is not an error");
}

void InputQueueIsBoundedAndSaysSo() {
    brownie::overlay::InputQueue queue;
    for (std::size_t i = 0; i < brownie::overlay::InputQueue::kCapacity; ++i) {
        Check(queue.Push({WM_MOUSEMOVE, 0, 0}), "the queue accepts up to its capacity");
    }
    // Filled by an external source: a window flooded while the render thread is
    // stalled must not grow this without limit inside someone else's process.
    Check(!queue.Push({WM_MOUSEMOVE, 0, 0}), "and refuses beyond it");
    Check(queue.TakeDropped() == 1, "the loss is counted, not hidden");
    Check(queue.TakeDropped() == 0, "and counted once");
}

void InputQueueWrapsWithoutLosingOrder() {
    brownie::overlay::InputQueue queue;
    std::array<brownie::overlay::InputMessage, brownie::overlay::InputQueue::kCapacity> drained{};

    // Push and drain repeatedly so the ring's head walks past the end — the
    // case where an off-by-one reorders or duplicates input.
    for (unsigned round = 0; round < 5; ++round) {
        for (unsigned i = 0; i < 200; ++i) {
            queue.Push({WM_KEYDOWN, round * 1000 + i, 0});
        }
        Check(queue.Drain(drained) == 200, "every round drains what it pushed");
        Check(drained[0].wparam == round * 1000, "starting where it should");
        Check(drained[199].wparam == round * 1000 + 199, "and ending where it should");
    }
}

void SessionKeysAreParsedStrictly() {
    std::string hex;
    for (std::size_t i = 0; i < brownie::ipc::kNonceBytes; ++i) hex += "ab";

    const auto parsed = brownie::ipc::ParseSessionKey(hex);
    Check(parsed.ok(), "a 32-byte hex key parses");
    Check(parsed.value()[0] == 0xAB, "into the bytes it spells");

    Check(brownie::ipc::ParseSessionKey(hex + "\r\n").ok(),
          "a trailing newline is tolerated, because text files have one");

    // Everything else is refused. A key that is silently padded, truncated or
    // partially parsed is a *different* secret, and the failure would surface
    // as an authentication error with no hint that the file was the cause.
    Check(!brownie::ipc::ParseSessionKey(hex.substr(0, 62)).ok(), "a short key is refused");
    Check(!brownie::ipc::ParseSessionKey(hex + "ab").ok(), "a long key is refused");
    Check(!brownie::ipc::ParseSessionKey("").ok(), "an empty file is refused");
    std::string not_hex = hex;
    not_hex[10] = 'z';
    Check(!brownie::ipc::ParseSessionKey(not_hex).ok(), "a non-hex character is refused");
}

void SessionKeyPathsRefuseToEscape() {
    Check(brownie::ipc::SessionKeyPath(L"brownie-bridge").ok(), "an ordinary pipe name resolves");
    // The pipe name reaches this from configuration, so it decides which file
    // gets read. Anything that could name a different one is refused outright
    // rather than escaped.
    Check(!brownie::ipc::SessionKeyPath(L"..\\..\\secrets").ok(), "a traversal is refused");
    Check(!brownie::ipc::SessionKeyPath(L"a/b").ok(), "a separator is refused");
    Check(!brownie::ipc::SessionKeyPath(L"").ok(), "an empty name is refused");
    // These pass a plain character-set check and name a directory, not a file.
    Check(!brownie::ipc::SessionKeyPath(L"..").ok(), "a name of only dots is refused");
    Check(!brownie::ipc::SessionKeyPath(L".hidden").ok(), "a leading dot is refused");
}

// A game's metadata, without a game.
//
// The resolution rules decide which memory a feature reads. Exercising them
// against the real runtime would mean provoking, inside someone else's process,
// the exact mistakes they exist to prevent — so they are exercised here, where
// a wrong answer is a failed check instead of a corrupted player object.
class FakeMetadata final : public brownie::game::ClassCatalog {
  public:
    struct Class {
        std::string name_space;
        std::string name;
        std::vector<brownie::game::FieldDescription> fields;
        std::vector<brownie::game::MethodDescription> methods;
        /// Registered but not built, which early in a run is most of them.
        bool prepared = true;
        /// What it derives from, empty at the root.
        std::string base;
        /// Which assembly it is in. Empty means the one image a source opens by
        /// itself — the game's own — which is where all but the engine's
        /// classes live.
        std::string assembly;
    };

    void Add(Class klass) { classes_.push_back(std::move(klass)); }

    [[nodiscard]] std::vector<std::string> ClassNames() const override {
        std::vector<std::string> names;
        for (const auto& klass : classes_) {
            names.push_back(klass.name_space.empty() ? klass.name
                                                     : klass.name_space + "." + klass.name);
        }
        return names;
    }

    [[nodiscard]] std::string BaseClassName(brownie::game::ClassRef klass) const override {
        return static_cast<const Class*>(klass)->base;
    }

    [[nodiscard]] bool IsPrepared(brownie::game::ClassRef klass) const noexcept override {
        return klass != nullptr && static_cast<const Class*>(klass)->prepared;
    }

    /// Makes every class invisible to a namespace-and-name lookup, the way one
    /// is when the namespace asked for is not the namespace it is in: present,
    /// findable by name, and absent from the only lookup being tried.
    void HideFromNamespaceLookup() noexcept { in_image_ = false; }

    [[nodiscard]] std::optional<brownie::game::ClassRef> FindClass(
        std::string_view name_space, std::string_view name) const override {
        if (!in_image_) {
            return std::nullopt;
        }
        for (const auto& klass : classes_) {
            if (klass.name_space == name_space && klass.name == name) {
                return static_cast<brownie::game::ClassRef>(&klass);
            }
        }
        return std::nullopt;
    }

    /// Only the classes said to be in that assembly, and only by their full
    /// name. The real source opens the assembly's image and asks it, which
    /// cannot see anything outside it either.
    [[nodiscard]] std::optional<brownie::game::ClassRef> FindClassIn(
        std::string_view assembly, std::string_view name_space,
        std::string_view name) const override {
        for (const auto& klass : classes_) {
            if (klass.assembly == assembly && klass.name_space == name_space &&
                klass.name == name) {
                return static_cast<brownie::game::ClassRef>(&klass);
            }
        }
        return std::nullopt;
    }

    [[nodiscard]] std::optional<brownie::game::ClassRef> FindClassAnywhere(
        std::string_view name) const override {
        const Class* found = nullptr;
        std::size_t matches = 0;
        for (const auto& klass : classes_) {
            if (klass.name != name) {
                continue;
            }
            ++matches;
            if (found == nullptr) {
                found = &klass;
            }
        }
        // A bare name two classes share identifies neither.
        if (matches != 1) {
            return std::nullopt;
        }
        return static_cast<brownie::game::ClassRef>(found);
    }

    [[nodiscard]] std::vector<brownie::game::FieldDescription> Fields(
        brownie::game::ClassRef klass) const override {
        return static_cast<const Class*>(klass)->fields;
    }

    [[nodiscard]] std::vector<brownie::game::MethodDescription> Methods(
        brownie::game::ClassRef klass) const override {
        return static_cast<const Class*>(klass)->methods;
    }

  private:
    /// A deque, not a vector: the handles handed out are pointers into this
    /// container, and a vector would invalidate every one of them on the next
    /// `Add` — which would make the fake behave in a way no real source does.
    std::deque<Class> classes_;
    bool in_image_ = true;
};

/// A stand-in entry point. Only its non-nullness matters: the real runtime
/// verifies the address against the game image before it ever reaches here.
void* const kEntryPoint = reinterpret_cast<void*>(static_cast<std::uintptr_t>(0x1000));
/// A second one, for the tests that have to say *which* method was picked.
void* const kOtherEntryPoint = reinterpret_cast<void*>(static_cast<std::uintptr_t>(0x2000));

FakeMetadata::Class PlayerClass() {
    return FakeMetadata::Class{
        .name = "Player",
        .fields =
            {
                {"hp", "System.Int32", 0x40, false},
                {"maxHp", "System.Int32", 0x44, false},
                {"name", "System.String", 0x48, false},
                {"instanceCount", "System.Int32", 0x00, true},
            },
        .methods =
            {
                {"Damage", "System.Void", {"System.Int32"}, kEntryPoint},
                {"Move", "System.Void", {"System.Single", "System.Single"}, kEntryPoint},
            },
    };
}

void OffsetsResolveByName() {
    FakeMetadata metadata;
    metadata.Add(PlayerClass());
    brownie::game::OffsetTable table{metadata};

    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", {}, {}, 0, 0};
    const auto resolved = table.ResolveField("self.hp", query);
    Check(resolved.ok(), "a field that has not moved resolves");
    Check(resolved.value().offset == 0x40, "and at the right offset");
    Check(resolved.value().provenance == brownie::game::Provenance::kExactName,
          "reported as an exact match");
    Check(table.FieldOffset("self.hp") == 0x40, "and is readable by key afterwards");
    Check(table.unresolved() == 0, "nothing is outstanding");

    // A key resolved twice is one line in the report, not two: an operator
    // reading two answers for the same key learns nothing from either.
    (void)table.ResolveField("self.hp", query);
    Check(table.entries().size() == 1, "resolving it again replaces rather than appends");

    const brownie::game::FieldQuery gone{{"", "Player", {}}, "notAField", {}, {}, 0, 0};
    (void)table.ResolveField("self.hp", gone);
    Check(!table.FieldOffset("self.hp").has_value() && table.unresolved() == 1,
          "and a key that stops resolving stops having an offset");
}

void AResolutionReportsTheShapeItFound() {
    FakeMetadata metadata;
    metadata.Add(PlayerClass());
    brownie::game::OffsetTable table{metadata};

    // The point of reporting it: this game's names are largely obfuscated, so a
    // rebuild renames the field and only its shape survives. That shape has to
    // be read off a running game rather than invented, and this is where it is
    // said out loud.
    const brownie::game::FieldQuery query{{"", "Player", {}}, "maxHp", {}, {}, 0, 0};
    const auto resolved = table.ResolveField("self.maxHp", query);
    Check(resolved.ok(), "the field resolves");
    Check(resolved.value().observed_type == "System.Int32", "and reports its declared type");
    // `instanceCount` is an Int32 too but static, so it is not counted: a static
    // field's offset is into a different block of memory entirely.
    Check(resolved.value().observed_ordinal == 1 && resolved.value().observed_count == 2,
          "and where it sits among the instance fields of that type");

    const auto& entries = table.entries();
    Check(!entries.empty() && entries.front().detail == "exact name; System.Int32 #1 of 2",
          "the report carries it in a form that can be transcribed");

    const brownie::game::FieldQuery static_query{{"", "Player", {}}, "instanceCount", {}, {}, 0, 0};
    const auto static_field = table.ResolveField("player.count", static_query);
    Check(static_field.ok() && static_field.value().observed_type.empty(),
          "a static field claims no instance-field ordinal");
}

void OffsetsRecoverFromARename() {
    FakeMetadata metadata;
    auto renamed = PlayerClass();
    renamed.fields[0].name = "m_hp";  // the patch renamed it
    metadata.Add(std::move(renamed));
    brownie::game::OffsetTable table{metadata};

    static constexpr std::string_view kAliases[] = {"m_hp"};
    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", kAliases, {}, 0, 0};
    const auto resolved = table.ResolveField("self.hp", query);
    Check(resolved.ok(), "a renamed field is recovered by its alias");
    Check(resolved.value().offset == 0x40, "at the offset it actually has");
    Check(resolved.value().provenance == brownie::game::Provenance::kAlias,
          "and is reported as recovered, not as certain");
}

void OffsetsRecoverFromAFingerprint() {
    FakeMetadata metadata;
    auto renamed = PlayerClass();
    renamed.fields[0].name = "somethingNobodyPredicted";
    metadata.Add(std::move(renamed));
    brownie::game::OffsetTable table{metadata};

    // Two instance fields of type Int32, and hp is the first of them.
    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", {}, "System.Int32", 0, 2};
    const auto resolved = table.ResolveField("self.hp", query);
    Check(resolved.ok(), "a field with no known name is recovered by its type fingerprint");
    Check(resolved.value().offset == 0x40, "at the right offset");
    Check(resolved.value().provenance == brownie::game::Provenance::kFingerprint,
          "and reported as the weakest kind of match");
}

void AFingerprintRefusesRatherThanGuess() {
    FakeMetadata metadata;
    auto changed = PlayerClass();
    changed.fields[0].name = "somethingNobodyPredicted";
    // The patch also added an Int32. The recorded ordinal now points at a
    // different field — the exact situation where guessing corrupts memory.
    changed.fields.push_back({"shield", "System.Int32", 0x4C, false});
    metadata.Add(std::move(changed));
    brownie::game::OffsetTable table{metadata};

    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", {}, "System.Int32", 0, 2};
    const auto resolved = table.ResolveField("self.hp", query);
    Check(!resolved.ok(), "a fingerprint whose field count changed is refused");
    Check(!table.FieldOffset("self.hp").has_value(), "so the feature that needed it goes quiet");
    Check(table.unresolved() == 1, "and the failure is kept, to be reported");
}

void StaticFieldsDoNotCountTowardsAFingerprint() {
    FakeMetadata metadata;
    auto renamed = PlayerClass();
    renamed.fields[0].name = "gone";
    metadata.Add(std::move(renamed));
    brownie::game::OffsetTable table{metadata};

    // Player has three Int32 fields, but one is static. A static field's offset
    // is into different memory entirely, so counting it would both break the
    // count and, if selected, produce an offset into the wrong object.
    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", {}, "System.Int32", 0, 2};
    Check(table.ResolveField("self.hp", query).ok(), "only instance fields are counted");
}

void AClassInAnUnknownNamespaceIsStillFound() {
    // Naming the wrong namespace is the ordinary way to miss a class that is
    // there: `ApplicationManager` looked absent until it turned out to be
    // `DecaGames.RotMG.Managers.ApplicationManager`.
    FakeMetadata metadata;
    metadata.Add(PlayerClass());
    metadata.HideFromNamespaceLookup();
    brownie::game::OffsetTable table{metadata};

    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", {}, {}, 0, 0};
    const auto resolved = table.ResolveField("self.hp", query);
    Check(resolved.ok(), "a class in an unexpected namespace resolves by bare name");
    Check(resolved.value().offset == 0x40, "at the right offset");
    // It proves less: no namespace, and a search to find it at all.
    Check(resolved.value().provenance == brownie::game::Provenance::kAlias,
          "and is reported as no better than an alias");
}

void ABareNameSharedByTwoClassesResolvesNeither() {
    FakeMetadata metadata;
    metadata.Add(PlayerClass());

    // The same bare name in another namespace. Nothing distinguishes them once
    // the namespace is the thing being given up.
    auto twin = PlayerClass();
    twin.name_space = "SomewhereElse";
    twin.fields[0].offset = 0x900;
    metadata.Add(std::move(twin));
    metadata.HideFromNamespaceLookup();

    brownie::game::OffsetTable table{metadata};
    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", {}, {}, 0, 0};
    Check(!table.ResolveField("self.hp", query).ok(),
          "an ambiguous bare name refuses rather than picking one");
    Check(table.FieldOffset("self.hp") == std::nullopt, "and leaves nothing readable");
}

void AMissingClassIsNotAnOffsetOfZero() {
    FakeMetadata metadata;
    brownie::game::OffsetTable table{metadata};

    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", {}, {}, 0, 0};
    const auto resolved = table.ResolveField("self.hp", query);
    Check(!resolved.ok(), "a class that is gone does not resolve");
    Check(!table.FieldOffset("self.hp").has_value(), "and yields no offset at all");
}

void MethodsResolveAndOverloadsAreRefused() {
    FakeMetadata metadata;
    auto overloaded = PlayerClass();
    overloaded.methods.push_back({"Damage", "System.Void", {"System.Single"}, kEntryPoint});
    metadata.Add(std::move(overloaded));
    brownie::game::OffsetTable table{metadata};

    // No signature given, and the name now covers two methods: refusing is the
    // point. Hooking the wrong overload is not a smaller mistake than hooking
    // none.
    const brownie::game::MethodQuery ambiguous{{"", "Player", {}}, "Damage", {}, {}, {}};
    Check(!table.ResolveMethod("player.damage", ambiguous).ok(),
          "an ambiguous method name is refused");

    static constexpr std::string_view kParameters[] = {"System.Int32"};
    const brownie::game::MethodQuery precise{
        {"", "Player", {}}, "Damage", {}, "System.Void", kParameters};
    const auto resolved = table.ResolveMethod("player.damage", precise);
    Check(resolved.ok(), "the same name with a signature resolves");
    Check(resolved.value().address == kEntryPoint, "to the right entry point");
    Check(table.unresolved() == 0, "and the earlier failure was replaced, not appended");
}

/// An argument count picks between overloads whose types cannot be written out.
///
/// The case is real: `ShowFloatingText` takes an enumeration whose type name is
/// obfuscator output, so the shape cannot be spelled and the bare name is two
/// methods. What does not change with a rename is how many arguments it takes.
void AnArgumentCountPicksBetweenOverloads() {
    FakeMetadata metadata;
    auto overloaded = PlayerClass();
    overloaded.methods.push_back({"Show", "System.Void", {"OBFUSCATED"}, kEntryPoint});
    overloaded.methods.push_back(
        {"Show", "System.Void", {"OBFUSCATED", "System.Single"}, kOtherEntryPoint});
    metadata.Add(std::move(overloaded));
    brownie::game::OffsetTable table{metadata};

    const brownie::game::MethodQuery byName{{"", "Player", {}}, "Show", {}, {}, {}};
    Check(!table.ResolveMethod("ui.show", byName).ok(), "the bare name is still two methods");

    const brownie::game::MethodQuery byArity{{"", "Player", {}}, "Show", {}, {}, {}, false, 2};
    const auto resolved = table.ResolveMethod("ui.show", byArity);
    Check(resolved.ok(), "an argument count picks one of them");
    Check(resolved.value().address == kOtherEntryPoint, "and it is the one with that many");

    // Never a name of its own: the count narrows a name that was given, and a
    // method that no longer answers to the name is gone whatever its shape.
    const brownie::game::MethodQuery renamed{{"", "Player", {}}, "Draw", {}, {}, {}, false, 2};
    Check(!table.ResolveMethod("ui.show", renamed).ok(),
          "and a count alone does not stand in for a name");
}

/// A class the runtime has registered but not built is not one to ask about its
/// members.
///
/// The most expensive lesson in this file: asking an unprepared class for its
/// fields or methods faults inside `GameAssembly`, and resolution runs twice a
/// second from the moment the module attaches — long before the game has built
/// most of what it will. So the resolution says "not yet" and tries again,
/// rather than the module crashing the game it is a guest in.
void AnUnpreparedClassIsNotAskedAboutItsMembers() {
    FakeMetadata metadata;
    auto unbuilt = PlayerClass();
    unbuilt.prepared = false;
    metadata.Add(std::move(unbuilt));
    brownie::game::OffsetTable table{metadata};

    const brownie::game::FieldQuery query{{"", "Player", {}}, "hp", {}};
    const auto outcome = table.ResolveField("self.hp", query);
    Check(!outcome.ok(), "a class that is not built yet does not resolve");
    Check(outcome.error().code() == brownie::ErrorCode::kNotReady,
          "and says so as 'not yet', so the loop asks again");
}

void AClassIsLookedForOnlyInItsOwnAssembly() {
    FakeMetadata metadata;
    // The engine's, in the assembly this build ships it in — the second of the
    // two names the query knows.
    metadata.Add(FakeMetadata::Class{
        .name_space = "UnityEngine.UI", .name = "Image", .assembly = "Unity.ugui"});
    // And the game's own class of the same bare name, in its own image. Nothing
    // to do with the engine's, and the trap: a lookup that fell back to the
    // image would find it and every offset taken through it would be wrong.
    metadata.Add(FakeMetadata::Class{.name = "Image"});

    static constexpr std::string_view kAssemblies[] = {"UnityEngine.UI", "Unity.ugui"};
    const brownie::game::ClassQuery query{"UnityEngine.UI", "Image", {}, kAssemblies};

    const auto resolved = brownie::game::ResolveClass(metadata, query);
    Check(resolved.ok(), "a class is found in the second assembly its query names");
    Check(resolved.value().first ==
              metadata.FindClassIn("Unity.ugui", "UnityEngine.UI", "Image").value_or(nullptr),
          "and it is the engine's class, not the game's of the same name");

    static constexpr std::string_view kElsewhere[] = {"Some.Other.Assembly"};
    const brownie::game::ClassQuery missing{"UnityEngine.UI", "Image", {}, kElsewhere};
    const auto refused = brownie::game::ResolveClass(metadata, missing);
    Check(!refused.ok(), "and a class named with an assembly is not looked for outside it");
    Check(refused.error().code() == brownie::ErrorCode::kNotReady,
          "reported as 'not yet', so the loop asks again after a patch");
}

void AColourSurvivesBeingPacked() {
    using brownie::game::PackColour;
    using brownie::game::UiColor;
    using brownie::game::UnpackColour;

    // The colour the game is handed travels as one word so that a change can
    // never be seen half-applied. What it costs is a channel rounded to 1/255,
    // and this is the check that it costs nothing else.
    const UiColor original = brownie::game::HealthBarTint::kDefaultColour;
    const UiColor returned = UnpackColour(PackColour(original));
    Check(std::fabs(returned.r - original.r) <= 1.0F / 255.0F &&
              std::fabs(returned.g - original.g) <= 1.0F / 255.0F &&
              std::fabs(returned.b - original.b) <= 1.0F / 255.0F &&
              std::fabs(returned.a - original.a) <= 1.0F / 255.0F,
          "a colour comes back within what a channel can hold");

    // Which makes packing settled after one round trip — the comparison that
    // decides whether a repaint is worth a call into the game is made on the
    // packed form, and it must not report a change that is not one.
    Check(PackColour(returned) == PackColour(original), "and packing it again gives the same word");

    // The floats come out of a widget, and converting anything outside 0..1 to
    // an integer channel is undefined rather than merely wrong.
    Check(PackColour(UiColor{-1.0F, 2.0F, 0.0F, 1.0F}) == 0x00FF00FFu,
          "and a value outside the range is clamped, not converted");

    Check(PackColour(UiColor{1.0F, 1.0F, 1.0F, 1.0F}) == 0xFFFFFFFFu, "white is every bit set");
    Check(PackColour(UiColor{0.0F, 0.0F, 0.0F, 0.0F}) == 0x00000000u, "and nothing is none");
}

void PropertiesAreFoundByTypeAndBounded() {
    const std::vector<brownie::game::FieldDescription> fields{
        {"id", "System.Int32", 0x10, false},
        {"props", "DecaGames.RotMG.Objects.Map.Data.ObjectProperties", 0x20, false},
        // Static, and at an offset into a different block of memory entirely: a
        // write at that distance into an instance lands somewhere unrelated.
        {"shared", "DecaGames.RotMG.Objects.Map.Data.ObjectProperties", 0x00, true},
        {"spawn", "DecaGames.RotMG.Objects.Map.Data.ObjectProperties", 0x30, false},
    };
    constexpr std::string_view kProperties = "DecaGames.RotMG.Objects.Map.Data.ObjectProperties";

    const auto found = brownie::game::PropertyFieldOffsets(fields, kProperties, 16);
    Check(found.size() == 2, "only the instance fields of that type are candidates");
    Check(found[0] == 0x20 && found[1] == 0x30, "in declaration order");

    Check(brownie::game::PropertyFieldOffsets(fields, kProperties, 1).size() == 1,
          "and no more of them than the caller allowed");
    Check(brownie::game::PropertyFieldOffsets(fields, "", 16).empty(),
          "without a type to match, nothing is a candidate");
}

void TheGamesOwnMultiplierIsTakenOnceAndPutBack() {
    // Two addresses, and nothing is dereferenced: this decides *what* to write,
    // and the walk that reads and writes is the part a game has to be running
    // for.
    int first = 0;
    int second = 0;
    const void* const properties = &first;
    const void* const rebuilt = &second;

    brownie::game::CollisionMemory memory;
    Check(!memory.holding(), "nothing is held before a pass has seen anything");

    Check(memory.Decide(properties, 1.0F, 0.5F) == std::optional<float>{0.5F},
          "the first pass writes what was asked for");
    Check(memory.holding(), "and holds the game's own value against putting it back");

    // The second pass reads back the module's own write. Remembering *that* as
    // the game's value is the mistake this class exists to make impossible —
    // the restore would be a no-op and the collider would stay shrunk.
    Check(memory.Decide(properties, 0.5F, 0.2F) == std::optional<float>{0.2F},
          "a later pass writes the new value");
    Check(memory.Decide(properties, 0.2F, std::nullopt) == std::optional<float>{1.0F},
          "and switching off puts back what the game had, not what the module wrote");
    Check(!memory.holding(), "which is the end of holding anything");

    Check(memory.Decide(properties, 1.0F, std::nullopt) == std::nullopt,
          "an off pass with nothing held writes nothing");

    // The player is rebuilt between realms, and the address the walk hands over
    // is a different object. Writing the old value into it would be restoring
    // somebody else's number.
    Check(memory.Decide(properties, 1.0F, 0.5F) == std::optional<float>{0.5F}, "on again");
    Check(memory.Decide(rebuilt, 0.9F, std::nullopt) == std::nullopt,
          "a different object is not the one the value came from");
    // Still held: a walk asks every handler under the player's node, so one
    // mismatch is not the answer — the pass forgets once the whole walk has
    // found nowhere to put it back.
    Check(memory.holding(), "and one mismatch is not the walk giving up");
    memory.Forget();
    Check(!memory.holding(), "which is the pass's to say, and it says it by forgetting");

    Check(memory.Decide(nullptr, 1.0F, 0.5F) == std::nullopt, "there is nothing to write to");

    // A field that is not a number is an object the walk mistook for the
    // player's properties. Left alone, and not remembered either — a restore
    // built on it would write a captured NaN back into the game.
    brownie::game::CollisionMemory nonsense;
    const float nan = std::numeric_limits<float>::quiet_NaN();
    Check(nonsense.Decide(properties, nan, 0.5F) == std::nullopt,
          "a field that is not finite is not written");
    Check(!nonsense.holding(), "and nothing was taken from it");
}

void AMethodSignatureDoesNotStandInForAName() {
    FakeMetadata metadata;
    metadata.Add(PlayerClass());
    brownie::game::OffsetTable table{metadata};

    static constexpr std::string_view kParameters[] = {"System.Int32"};

    // The shape is right and unique, and the name is not this build's. By
    // default that is a refusal: a method matched by a shape several methods
    // could share is one this module would call or detour through a prototype
    // that does not describe it, which is a crash rather than a wrong number.
    const brownie::game::MethodQuery renamed{
        {"", "Player", {}}, "WasCalledThisLastPatch", {}, "System.Void", kParameters};
    Check(!table.ResolveMethod("player.damage", renamed).ok(),
          "a renamed method does not resolve by its signature alone");

    // Unless the query says the shape identifies it, which is a claim somebody
    // makes deliberately about one method on one class.
    brownie::game::MethodQuery byShape = renamed;
    byShape.fingerprint = true;
    const auto resolved = table.ResolveMethod("player.damage", byShape);
    Check(resolved.ok(), "and does when the query says the shape identifies it");
    Check(resolved.value().provenance == brownie::game::Provenance::kFingerprint,
          "reported as recovered by fingerprint, so nobody mistakes it for a name");
}

void AnUnverifiedEntryPointIsNoEntryPoint() {
    FakeMetadata metadata;
    auto unverified = PlayerClass();
    unverified.methods[0].address = nullptr;  // the source could not verify it
    metadata.Add(std::move(unverified));
    brownie::game::OffsetTable table{metadata};

    static constexpr std::string_view kParameters[] = {"System.Int32"};
    const brownie::game::MethodQuery query{
        {"", "Player", {}}, "Damage", {}, "System.Void", kParameters};
    Check(!table.ResolveMethod("player.damage", query).ok(),
          "a method whose address could not be verified does not resolve");
}

/// A class whose own name says nothing, described by everything else about it.
FakeMetadata::Class ObfuscatedClass() {
    return FakeMetadata::Class{
        .name = "LKHPPBEGNOM",
        .fields =
            {
                {"AAA", "System.Int32", 0x40, false},
                {"BBB", "DecaGames.RotMG.Objects.Player", 0x48, false},
                {"CCC", "System.String", 0x50, false},
                {"DDD", "System.Int32", 0x00, true},
            },
        .methods =
            {
                {"EEE", "DecaGames.RotMG.Objects.Player", {"System.Int32"}, kEntryPoint},
            },
        .base = "UnityEngine.MonoBehaviour",
    };
}

void AClassIsDescribedByWhatItTouches() {
    FakeMetadata metadata;
    metadata.Add(ObfuscatedClass());

    const auto detail = brownie::app::Describe(metadata, "LKHPPBEGNOM");

    Check(detail.base == "UnityEngine.MonoBehaviour", "the base class is reported");
    Check(detail.members.size() == 5, "every field and method is a member");
    Check(detail.members[0].offset == "0x0040", "an instance field carries its offset");
    Check(detail.members[3].is_static && detail.members[3].offset.empty(),
          "a static field has no offset to show");
    Check(detail.members[4].is_method && detail.members[4].detail.starts_with(
              "DecaGames.RotMG.Objects.Player (System.Int32)"),
          "a method is shown as its signature");

    // The whole point of the panel: the name is noise, so what it stores and
    // returns has to identify it.
    Check(detail.touches.size() == 2, "types that say nothing are left out");
    Check(detail.touches[0] == "UnityEngine.MonoBehaviour", "the base counts as evidence");
    Check(detail.touches[1] == "DecaGames.RotMG.Objects.Player",
          "an informative type is noted once, however often it appears");
}

void AnAbsentClassSaysSoRatherThanLookingEmpty() {
    FakeMetadata metadata;
    metadata.Add(ObfuscatedClass());

    const auto detail = brownie::app::Describe(metadata, "Nothing.Like.This");

    Check(detail.name == "Nothing.Like.This", "the name asked about is echoed back");
    Check(detail.members.empty(), "a class that was not found has no members");
    // Lazy registration means absent and never-existed look identical, and a
    // blank panel would read as "this class is empty".
    Check(!detail.base.empty(), "not finding a class is said out loud");
}

void ASweepSkipsWhatMustNotBeWalked() {
    FakeMetadata metadata;
    metadata.Add(ObfuscatedClass());
    metadata.Add(FakeMetadata::Class{.name_space = "System.Collections.Generic",
                                     .name = "List`1"});
    metadata.Add(FakeMetadata::Class{.name = "Player[]"});
    metadata.Add(FakeMetadata::Class{.name = "<>c"});
    metadata.Add(FakeMetadata::Class{.name = "NotBuiltYet", .prepared = false});

    std::vector<std::string> chunks;
    const auto summary = brownie::app::ExportClasses(
        metadata, 1, [&chunks](const std::string& chunk) { chunks.push_back(chunk); });

    Check(summary.written == 1, "only the class that is safe to walk is described");
    // Counted rather than hidden: a sweep that quietly dropped four fifths of
    // the image would be read as a complete one.
    Check(summary.skipped == 4, "generics, arrays, closures and unbuilt classes are counted");
    Check(chunks.size() == 1, "a chunk goes out once it is full");
    Check(chunks[0].find("class LKHPPBEGNOM : UnityEngine.MonoBehaviour") != std::string::npos,
          "the dump carries the class heading");
    Check(chunks[0].find("  0x0040 AAA : System.Int32") != std::string::npos,
          "the dump carries each member");
}

void AnExportIsChunkedRatherThanSentPerClass() {
    FakeMetadata metadata;
    for (int i = 0; i < 8; ++i) {
        auto klass = ObfuscatedClass();
        klass.name += std::to_string(i);
        metadata.Add(std::move(klass));
    }

    std::vector<std::string> chunks;
    const auto summary = brownie::app::ExportClasses(
        metadata, 64u * 1024u, [&chunks](const std::string& chunk) { chunks.push_back(chunk); });

    Check(summary.written == 8, "every class is described");
    Check(chunks.size() == 1, "eight small classes travel as one chunk, not eight");
    Check(chunks[0].find("class LKHPPBEGNOM7") != std::string::npos,
          "the last class is in the chunk the sweep flushed at the end");
}

void AnObjectDumpStopsAtItsBuffer() {
    std::vector<std::string> lines;
    const brownie::app::LineSink say = [&lines](std::string_view line) {
        lines.emplace_back(line);
    };

    std::array<std::byte, 20> object{};
    brownie::app::DumpObject(object, say);
    // Four words a line, and the five remaining bytes are not four words: a
    // partial row would be a read past what the caller handed over.
    Check(lines.size() == 1, "a trailing partial row is not printed");

    lines.clear();
    brownie::app::DumpObject(std::span<const std::byte>{object.data(), 12}, say);
    Check(lines.empty(), "an object shorter than one row prints nothing");
}

void RecordsBecomeTargetsThatExpire() {
    const brownie::overlay::MoveCommand move{250, -100, 725, 200};
    const auto target = brownie::app::MoveTargetFrom(move, 1000);

    Check(target.wanted, "a move record is a target somebody wants");
    Check(std::fabs(target.x - 2.5F) < 0.001F && std::fabs(target.y + 1.0F) < 0.001F,
          "hundredths of a tile become tiles");
    Check(std::fabs(target.speed - 7.25F) < 0.001F, "so does the speed");
    // Stamped where it arrived, because the two sides do not share a clock.
    Check(target.expires_at_ms == 1200, "the hold is measured from arrival");

    const brownie::overlay::AimCommand aim{-50, 75, 300};
    const auto aimed = brownie::app::AimTargetFrom(aim, 5000);
    Check(std::fabs(aimed.x + 0.5F) < 0.001F && std::fabs(aimed.y - 0.75F) < 0.001F,
          "an aim record is converted the same way");
    Check(aimed.expires_at_ms == 5300, "and expires the same way");
}

/// A camera that is rotated and zoomed, as measured rather than as configured.
///
/// The basis is what three probes would have produced: a quarter turn of
/// rotation at thirty-two pixels to the tile, with the anchor drawn a hundred
/// pixels in from the corner. Written out by hand because the measuring needs a
/// game and the arithmetic does not — and the arithmetic is the half that turns
/// a click into a place on the map.
brownie::game::ScreenBasis TiltedCamera() {
    brownie::game::ScreenBasis basis;
    basis.anchor = brownie::game::WorldPoint{100.0F, 200.0F};
    basis.origin_x = 640.0F;
    basis.origin_y = 360.0F;
    // A quarter turn: east on the map runs down the screen, south runs left.
    basis.east_x = 0.0F;
    basis.east_y = 32.0F;
    basis.south_x = -32.0F;
    basis.south_y = 0.0F;
    basis.determinant = basis.east_x * basis.south_y - basis.east_y * basis.south_x;
    return basis;
}

void AProjectionInvertsItself() {
    const auto basis = TiltedCamera();

    float x = 0.0F;
    float y = 0.0F;
    brownie::game::ToScreen(basis, basis.anchor, x, y);
    Check(x == basis.origin_x && y == basis.origin_y, "the anchor is where it was measured");

    // Two tiles east and one south, under the rotation above.
    brownie::game::ToScreen(basis, brownie::game::WorldPoint{102.0F, 201.0F}, x, y);
    Check(std::fabs(x - 608.0F) < 0.01F && std::fabs(y - 424.0F) < 0.01F,
          "a rotated camera puts a tile where the rotation says");

    // **The round trip is the property that matters**: the cursor is turned
    // into tiles by one of these and drawn back by the other, and a pair that
    // disagree is a marker that does not sit where it was clicked.
    const auto back = brownie::game::ToWorld(basis, x, y);
    Check(std::fabs(back.x - 102.0F) < 0.001F && std::fabs(back.y - 201.0F) < 0.001F,
          "and reading it back gives the tile again");

    const auto corner = brownie::game::ToWorld(basis, 0.0F, 0.0F);
    brownie::game::ToScreen(basis, corner, x, y);
    Check(std::fabs(x) < 0.01F && std::fabs(y) < 0.01F, "the corner of the window round-trips too");
}

void AStepIsBoundedByTheFrameAndByTheCap() {
    Check(std::fabs(brownie::app::StepBudget(16, 7.0F) - 0.112F) < 0.001F,
          "an ordinary frame carries a frame's worth of travel");

    // A stall, a breakpoint or a minimised window can put a second between two
    // frames, and a second issued as one step is the teleport the server takes
    // back.
    Check(brownie::app::StepBudget(1000, 7.0F) <= brownie::app::kMaxStepTiles,
          "a frame that took a second is counted as one that took 100 ms");

    // The second guard, independent of the first: whatever speed arrives in the
    // record, one frame cannot command more than a walk's worth.
    Check(std::fabs(brownie::app::StepBudget(100, 500.0F) - brownie::app::kMaxStepTiles) < 0.001F,
          "an absurd speed is capped rather than trusted");
    Check(brownie::app::StepBudget(0, 7.0F) == 0.0F, "no time is no travel");
}

void AStepGivesWayToTheirOwnWalking() {
    constexpr float kBudget = 0.12F;

    Check(std::fabs(brownie::app::RoomToStep(kBudget, 0.0F, 0.0F, 1.0F, 0.0F) - kBudget) < 0.001F,
          "a player standing still leaves the whole frame to the step");

    // The complaint this exists for: the step is added to the game's own
    // movement, so a player walking the way they are being steered travels at
    // both speeds at once — and the server takes that back.
    Check(brownie::app::RoomToStep(kBudget, kBudget, 0.0F, 1.0F, 0.0F) == 0.0F,
          "a player already spending the whole limit that way leaves nothing");
    Check(std::fabs(brownie::app::RoomToStep(kBudget, kBudget / 2.0F, 0.0F, 3.0F, 0.0F) -
                    kBudget / 2.0F) < 0.001F,
          "and half of it leaves half");

    // Across their walking rather than along it, which is the ordinary dodge:
    // what is left is what keeps the two together inside the limit.
    const float across = brownie::app::RoomToStep(kBudget, kBudget / 2.0F, 0.0F, 0.0F, 1.0F);
    Check(std::fabs(std::sqrt((kBudget / 2.0F) * (kBudget / 2.0F) + across * across) - kBudget) <
              0.001F,
          "a step across their walking is left exactly the room to stay inside the limit");

    // Never *more* than the frame allows, however much of it they are walking
    // off: a correction is allowed to be partial and is never a snap-back.
    Check(brownie::app::RoomToStep(kBudget, -kBudget, 0.0F, 1.0F, 0.0F) == kBudget,
          "walking against the step buys no extra travel");

    // A knockback, a correction or a portal moves them further than they could
    // walk. There is nothing left to spend either way round.
    Check(brownie::app::RoomToStep(kBudget, 5.0F, 5.0F, 1.0F, 0.0F) == 0.0F,
          "a player thrown further than the limit leaves nothing at all");

    Check(brownie::app::RoomToStep(kBudget, 0.0F, 0.0F, 0.0F, 0.0F) == 0.0F,
          "nowhere to step is no step");
    Check(brownie::app::RoomToStep(0.0F, 0.0F, 0.0F, 1.0F, 0.0F) == 0.0F, "no budget is no step");
}

/// The classes the real player queries name, with the fields they ask for.
///
/// Built from `PlayerFieldQueries()` rather than spelled out, so that a rename
/// in `PlayerFields.cpp` moves this fake with it instead of leaving a test that
/// passes against names the game no longer has.
void AddPlayerClasses(FakeMetadata& metadata,
                      std::span<const brownie::game::KeyedFieldQuery> queries) {
    std::vector<FakeMetadata::Class> classes;
    for (const auto& entry : queries) {
        const auto& owner = entry.query.owner;
        auto* klass = static_cast<FakeMetadata::Class*>(nullptr);
        for (auto& candidate : classes) {
            if (candidate.name_space == owner.name_space && candidate.name == owner.name) {
                klass = &candidate;
                break;
            }
        }
        if (klass == nullptr) {
            classes.push_back(FakeMetadata::Class{.name_space = std::string{owner.name_space},
                                                  .name = std::string{owner.name}});
            klass = &classes.back();
        }
        // Non-zero and distinct, so a check on the offset says more than a
        // check on "resolved" alone.
        const auto offset = static_cast<std::uint32_t>(0x40 + 8 * klass->fields.size());
        klass->fields.push_back({std::string{entry.query.name},
                                 std::string{entry.query.type_name}, offset, false});
    }
    for (auto& klass : classes) {
        metadata.Add(std::move(klass));
    }
}

void PlayerFieldsAreNotGatedByAnotherModulesProgress() {
    const auto queries = brownie::game::PlayerFieldQueries();
    FakeMetadata metadata;
    AddPlayerClasses(metadata, queries);

    // Somebody else's class. The scene and the projectile modules resolve their
    // fields into the same table, and the player's stats class is built last of
    // the three — IL2CPP does not prepare it until the game has made a player.
    FakeMetadata::Class other{.name = "Other"};
    std::vector<std::string> names;
    for (std::size_t i = 0; i < queries.size(); ++i) {
        names.push_back("other" + std::to_string(i));
        other.fields.push_back(
            {names.back(), "System.Int32", static_cast<std::uint32_t>(0x100 + 4 * i), false});
    }
    metadata.Add(std::move(other));

    brownie::game::OffsetTable table{metadata};
    for (std::size_t i = 0; i < names.size(); ++i) {
        const brownie::game::FieldQuery query{{"", "Other", {}}, names[i], {}, {}, 0, 0};
        Check(table.ResolveField("other." + std::to_string(i), query).ok(),
              "another module's field resolves into the shared table");
    }

    Check(brownie::game::ResolvePlayerFields(table) == queries.size(),
          "the player's fields are still looked for once its class appears");
    for (const auto& entry : queries) {
        Check(table.FieldOffset(entry.key).has_value(), "and every key has an offset");
    }
}

void PlayerSkinUsesTheActiveOverride() {
    const auto queries = brownie::game::PlayerFieldQueries();
    const brownie::game::KeyedFieldQuery* skin = nullptr;
    for (const auto& entry : queries) {
        if (entry.key == brownie::game::kPlayerSkin) {
            skin = &entry;
            break;
        }
    }
    Check(skin != nullptr && skin->query.name == "BKMIHOGBMMC",
          "the skin reads the active override field");

    FakeMetadata metadata;
    FakeMetadata::Class local_player{.name = "FKALGHJIADI"};
    local_player.methods.push_back(
        {"MBKGLHCJBCD", "System.Void", {"System.Int32"}, kEntryPoint});
    metadata.Add(std::move(local_player));

    brownie::game::OffsetTable table{metadata};
    Check(brownie::game::ResolvePlayerMethods(table) == 1,
          "the active skin setter resolves by name");
    Check(table.MethodAddress(brownie::game::kSetPlayerSkin) == kEntryPoint,
          "the skin binds to the active override setter");
}

void TheGlowSetterIsNotTheSkinSetter() {
    // Both are `void(int)` on the same class, so a shape identifies neither and
    // the pair is exactly what a fingerprint would confuse. Resolving them
    // together is the check that each is found by its own name.
    FakeMetadata metadata;
    FakeMetadata::Class local_player{.name = "FKALGHJIADI"};
    local_player.methods.push_back(
        {"MBKGLHCJBCD", "System.Void", {"System.Int32"}, kEntryPoint});
    local_player.methods.push_back(
        {"JEDNHGGONPP", "System.Void", {"System.Int32"}, kOtherEntryPoint});
    metadata.Add(std::move(local_player));

    brownie::game::OffsetTable table{metadata};
    (void)brownie::game::ResolvePlayerMethods(table);
    Check(table.MethodAddress(brownie::game::kSetPlayerSkin) == kEntryPoint,
          "the skin setter is the one named for the skin");
    Check(table.MethodAddress(brownie::game::kSetPlayerGlow) == kOtherEntryPoint,
          "the glow setter is the one named for the glow");
}

void GlowStylesAreFoundOnTheirOwnClasses() {
    FakeMetadata metadata;
    FakeMetadata::Class aura{.name = "INPKDKIEDLB"};
    aura.fields.push_back({"PACDNKLMHAK", "UnityEngine.Color", 0x10, false});
    aura.fields.push_back({"APDEEPOICMN", "UnityEngine.Color", 0x20, false});
    metadata.Add(std::move(aura));

    FakeMetadata::Class outline{.name = "LDHFNAFNELO"};
    outline.fields.push_back({"PACDNKLMHAK", "UnityEngine.Color", 0x10, false});
    metadata.Add(std::move(outline));

    brownie::game::OffsetTable table{metadata};
    Check(brownie::game::ResolveGlowFields(table) == 2, "both glow styles resolve by name");
    // The aura's colour is its *second*, and the two are the same type: a query
    // that took the first would repaint the black every style is paired with
    // and leave the red alone.
    Check(table.FieldOffset(brownie::game::kGlowStyleColour) == 0x20,
          "the aura is recoloured by its second colour");
    Check(table.FieldOffset(brownie::game::kOutlineStyleColour) == 0x10,
          "the outline is recoloured by its only one");
}

void ArcaneStylesMatchTheLiveLibrary() {
    using brownie::game::MatchesArcaneStyle;
    Check(MatchesArcaneStyle("Brown Hologram Style", "Brown Hologram Style"),
          "an exact Arcane Style id matches");
    Check(MatchesArcaneStyle("Brown Hologram Style Stone", "Brown Hologram Style"),
          "a player Arcane Style matches its live library entry");
    Check(!MatchesArcaneStyle("Brown Hologram Style Stone Stone",
                              "Brown Hologram Style Stone"),
          "an existing Stone suffix is not appended twice");
    Check(!MatchesArcaneStyle("Brown Hologram Style Stone", "Brown Hologram"),
          "a partial Arcane Style id does not match");
    Check(!MatchesArcaneStyle(" Stone", ""), "an empty Arcane Style id does not match");
}

}  // namespace

int main() {
    std::printf("native self-check\n");
    FrameHeaderRoundTrips();
    FrameHeaderRejectsWhatItMust();
    SequenceNumbersBehave();
    FrameReaderReassembles();
    FrameReaderRefusesGarbage();
    JsonReadsWhatTheRuntimeWrites();
    JsonRoundTrips();
    HandshakeSignsUnambiguously();
    SessionKeysAreParsedStrictly();
    SessionKeyPathsRefuseToEscape();
    ResultCarriesTheReason();
    OffsetsResolveByName();
    AResolutionReportsTheShapeItFound();
    OffsetsRecoverFromARename();
    OffsetsRecoverFromAFingerprint();
    AFingerprintRefusesRatherThanGuess();
    StaticFieldsDoNotCountTowardsAFingerprint();
    AClassInAnUnknownNamespaceIsStillFound();
    ABareNameSharedByTwoClassesResolvesNeither();
    AMissingClassIsNotAnOffsetOfZero();
    MethodsResolveAndOverloadsAreRefused();
    AnArgumentCountPicksBetweenOverloads();
    AMethodSignatureDoesNotStandInForAName();
    AClassIsLookedForOnlyInItsOwnAssembly();
    PropertiesAreFoundByTypeAndBounded();
    TheGamesOwnMultiplierIsTakenOnceAndPutBack();
    AColourSurvivesBeingPacked();
    AnUnpreparedClassIsNotAskedAboutItsMembers();
    AnUnverifiedEntryPointIsNoEntryPoint();
    AClassIsDescribedByWhatItTouches();
    AnAbsentClassSaysSoRatherThanLookingEmpty();
    ASweepSkipsWhatMustNotBeWalked();
    AnExportIsChunkedRatherThanSentPerClass();
    AnObjectDumpStopsAtItsBuffer();
    PlayerFieldsAreNotGatedByAnotherModulesProgress();
    PlayerSkinUsesTheActiveOverride();
    TheGlowSetterIsNotTheSkinSetter();
    GlowStylesAreFoundOnTheirOwnClasses();
    ArcaneStylesMatchTheLiveLibrary();
    RecordsBecomeTargetsThatExpire();
    AProjectionInvertsItself();
    AStepIsBoundedByTheFrameAndByTheCap();
    AStepGivesWayToTheirOwnWalking();
    HooksDivertAndRestore();
    RemovingAHookIsScopeExit();
    TwoEnginesAreRefused();
    PresentResolvesToRealCode();
    WorldRecordsAreReadStrictly();
    WorldRecordsCarryBlastCounts();
    WeaponRecordsCarryTheName();
    MoveRecordsAreReadStrictly();
    AimRecordsAreReadStrictly();
    AimRedirectsOnlyWhatItWasGiven();
    TextRecordsCarryTheWholeMessage();
    ATileSwapPutsBackWhatItTook();
    ProjectileNoclipInstallsBothOrNeither();
    PlayerNoclipRefusesWhatItCannotDetour();
    UnbindableCallersStayQuiet();
    ReadCostIsMeasured();
    ControlFieldsRoundTrip();
    AControlSyncIsAllOrNothing();
    AControlSyncReplacesRatherThanMerges();
    ACommitOrdersPluginsByCategory();
    AFailedSetupIsTheOnlyPluginPutOutOfReach();
    AControlRecordThatSaysTooLittleIsRefused();
    SelectOptionsAndVisibilityAreRead();
    MultiSelectIsReadAsAChecklist();
    DodgePictureCommitsWholeSetsAndExpires();
    ActionQueueHandsInteractionsOver();
    ActionQueueKeepsTheNewestWhenFull();
    InputQueueHandsMessagesOver();
    InputQueueIsBoundedAndSaysSo();
    InputQueueWrapsWithoutLosingOrder();

    if (failures == 0) {
        std::printf("  all checks passed\n");
        return 0;
    }
    std::printf("  %d check(s) failed\n", failures);
    return 1;
}
