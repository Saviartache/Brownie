/**
 * The hop: one frame's worth of movement, spent all at once.
 *
 * **It is not a teleport, and the distinction is the whole reason it is safe.**
 * The module already carries a walk as a target the frame steps towards, capped
 * at what one frame of the character's own speed allows; the cap is there
 * because anything past it is a position the client never walked to, which the
 * server takes back. A hop asks for the whole of that cap on a single frame
 * instead of a fraction of it — the same call into the game's own movement, the
 * same clamp, the same packets. What it spends is a frame of speed, not a rule.
 *
 * So {@link MAX_HOP_TILES} is not a preference. It is the module's own
 * `kMaxStepTiles`, and asking for more does not carry the character further; it
 * makes the two sides disagree about what was asked for, which is how a landing
 * place gets chosen that nothing ever reaches.
 *
 * **What a hop is *for* changed with this generation, and it is the more
 * interesting half.** It used to be the emergency — the answer to a shot landing
 * before a step of walking could finish. It is still that, and it is now also
 * the *precise* action: a walk is published as an offset the frame resolves
 * against the character's live position and steps along at whatever budget the
 * frame has, so a walk of a twentieth of a tile is not a thing the module can
 * deliver, while a hop of a twentieth of a tile is exactly a twentieth of a
 * tile. Every micro-dodge in this feature is therefore a hop, and the optimizer
 * ranks the two actions on one scale rather than treating either as a fallback.
 * See `TrajectoryPlanner`.
 *
 * **Nothing here decides anything**, which is why the file is four constants
 * long: where to hop is a candidate like any other and belongs to the optimizer,
 * and whether one may be spent at all is the planner's, because it is the thing
 * holding the clock.
 */

/**
 * The furthest a single hop may carry, in tiles.
 *
 * **The module's own per-frame limit, restated here because this side is the one
 * that has to respect it.** `app::kMaxStepTiles` bounds what one frame may
 * command whatever speed is asked for, so a hop longer than this is a hop the
 * module quietly shortens — and a planner believing its own number would be
 * choosing a landing place the character never arrives at.
 */
export const MAX_HOP_TILES = 0.7;

/**
 * The speed a hop is commanded at, in tiles per second.
 *
 * Sized so the module spends its whole per-frame allowance on the frame the
 * command lands, at any frame rate a person plays at: at a hundred and forty
 * frames a second a frame is seven milliseconds, and {@link MAX_HOP_TILES} over
 * that is a hundred tiles a second. The module clamps to its own cap regardless,
 * so this only has to be large enough to reach it.
 */
export const HOP_SPEED_TILES_PER_SECOND = 120;
