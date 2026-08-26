// What the player features need to read, and where it lives.
//
// **The game is obfuscated, and only partly.** It ships through Beebyte, which
// renames a large share of its classes, fields and methods to eleven-letter
// nonsense — but not all of them: `ObjectProperties` and
// `collisionRadiusMultiplier` survive intact while the class holding the
// player's health does not. So a query here names whatever the live build calls
// the thing, obfuscated or not, and the difference is not visible from the name.
//
// Two consequences shape everything below.
//
// **The fingerprint is not a fallback, it is the plan.** For a renamed field,
// the name is only good until the next rebuild renames it again. Shape — a
// field's declared type and its position among the fields of that type — is
// what survives, so it is what a rename is recovered from. That is the reverse
// of the usual case, where a fingerprint is the last resort.
//
// **A fingerprint may only be written from a game that was running.** It is a
// claim about a class's layout, and one invented at a desk is exactly the guess
// invariant 5 forbids. So the queries start with names alone, and every
// resolution reports the shape the live class gave it — see `FieldResolution`.
// Those numbers are transcribed back into this file once a live run has said
// them, and not before.
//
// The names came from the reference implementation, which found them by
// inspection; the Beebyte map it carries does not cover them, so there is no
// deobfuscated name to prefer and nothing here pretends otherwise.
//
// **The offsets below are not where the values are, and that is settled.** The
// game's anti-tamper moves the stat block: health and maximum health sit at
// their declared offsets plus `0x50`, measured live against what the server
// said rather than taken from the reference implementation's constant. And the
// block is *rearranged*, not merely moved — defence turned up at the offset the
// metadata assigns to maximum health, so it is located by its value too. See
// `PlayerHandle`, which does both and trusts neither for longer than they keep
// agreeing with the packet stream.

#pragma once

#include <span>
#include <string_view>

#include "game/OffsetTable.h"

namespace brownie::game {

/// Keys the rest of the module asks for. Literals, because a key that does not
/// resolve is shown in the overlay under exactly this text.
inline constexpr std::string_view kPlayerHp = "self.hp";
inline constexpr std::string_view kPlayerMaxHp = "self.maxHp";
inline constexpr std::string_view kPlayerDefense = "self.defense";
inline constexpr std::string_view kPlayerObjectId = "self.objectId";
inline constexpr std::string_view kPlayerX = "self.x";
inline constexpr std::string_view kPlayerY = "self.y";
inline constexpr std::string_view kPlayerSkin = "self.skin";
inline constexpr std::string_view kPlayerShaderProperties = "self.shaderProperties";

/// Whether the game draws a glow around this player, which is the whole of what
/// the field says: every value but `-1` means "glowing" and none of them is a
/// colour. What colour it is comes from the styles in `GlowFields.h`.
inline constexpr std::string_view kPlayerGlow = "self.glow";

/// The two hops that lead to the player object. See `PlayerHandle.h`.
inline constexpr std::string_view kWorldManager = "world.manager";
inline constexpr std::string_view kLocalPlayer = "world.localPlayer";

/// The world manager's map objects, by object id.
///
/// **Two of them, because the class declares two and nothing here knows which
/// is which.** Both are `Dictionary<int, MapObject>` and neither name says
/// anything. They are not guessed between: a lookup asks each in turn and takes
/// the answer whose stored object agrees about its own id, which is the same
/// key it was filed under. A wrong table cannot pass that, and neither can a
/// wrong idea of how a dictionary is laid out. See `MapObjects.h`.
inline constexpr std::string_view kWorldObjects = "world.objects";
inline constexpr std::string_view kWorldObjectsAlt = "world.objects.alt";

/// The game's own "walk towards here".
///
/// **The first thing this project calls rather than reads.** Movement is
/// applied by asking the game to move, not by writing a position: the reference
/// implementation tried the write and recorded what it cost — "the old raw-write
/// teleport caused anti-cheat issues; this doesn't" — because a position the
/// client never agreed to is a position the server sees appear from nowhere.
/// Going through the game's own method means the client walks, renders and
/// reports itself exactly as it would have anyway.
inline constexpr std::string_view kPlayerMoveTo = "self.moveTo";

/// The two methods silent aim detours — see `AimHook.h`.
///
/// **Neither is called; both are intercepted.** The first is where the client
/// works out which way the shot goes, from the cursor; the second is the shot
/// itself. Changing the angle inside them is what makes the projectile the
/// player sees, the packet the server gets and the hits the client reports all
/// describe the same shot.
///
/// The names came from the reference implementation, which found them by
/// inspection, and the signatures with them — so a rename is recovered from the
/// shape, and an overload that two methods match is refused rather than picked.
inline constexpr std::string_view kComputeShootAngle = "self.computeShootAngle";
inline constexpr std::string_view kShootWithAngle = "self.shootWithAngle";
inline constexpr std::string_view kSetPlayerSkin = "self.setSkin";
inline constexpr std::string_view kSetPlayerShader = "self.setShaderProperties";

/// The setter for {@link kPlayerGlow}, which is called rather than the field
/// written: it rebuilds the player's visual, and the glow does not appear until
/// something does. Called only when the value has actually changed — a rebuild
/// asked for on a loop is an animation restarted on a loop.
inline constexpr std::string_view kSetPlayerGlow = "self.setGlow";

/// Resolves what the module calls into the game. Same rules as the fields:
/// exact name, then alias, then the signature as a fingerprint.
std::size_t ResolvePlayerMethods(OffsetTable& table);

/// What this build calls the class the player's stats live on.
///
/// Exposed because it is the answer to "which class do I look in", and every
/// unresolved player key is found by looking in it. The name itself is
/// obfuscator output and changes with the build, so anything that wants to show
/// it — the overlay's one-click export — has to ask rather than carry a copy.
[[nodiscard]] std::string_view PlayerClassName() noexcept;

/// Every player field, with the key it is recorded under.
struct KeyedFieldQuery {
    std::string_view key;
    FieldQuery query;
};

[[nodiscard]] std::span<const KeyedFieldQuery> PlayerFieldQueries() noexcept;

/// Resolves whatever is still missing.
///
/// **Meant to be called repeatedly, and cheap when there is nothing to do.** A
/// key that already resolved is skipped; one that failed is tried again,
/// because IL2CPP registers classes lazily and a class the game has not
/// instantiated yet is missing in exactly the way a renamed one is. Only a key
/// still unresolved after real play has proved anything at all.
///
/// @returns how many keys resolved on this call, so a caller can tell "nothing
///   to do" from "something just appeared" without diffing the report.
std::size_t ResolvePlayerFields(OffsetTable& table);

}  // namespace brownie::game
