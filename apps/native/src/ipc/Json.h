// A reader and writer for the flat JSON objects this protocol uses.
//
// Not a JSON library, and it must not become one. Every payload it sees is
// produced by the runtime's own encoder and is described field by field in
// `docs/ipc.md`: a flat object whose values are strings, numbers or booleans.
// No nesting, no arrays of objects, no exotic escapes.
//
// That narrowness is the whole justification. A general parser would be a
// dependency, a build step and an attack surface, for a job that is "read four
// named fields out of something we wrote ourselves".

#pragma once

#include <cstdint>
#include <string>
#include <string_view>

#include "core/Result.h"

namespace brownie::ipc::json {

/// Reads a string field. Handles the escapes the encoder can emit.
Result<std::string> String(std::string_view document, std::string_view field);

/// Reads an integer field.
Result<std::int64_t> Integer(std::string_view document, std::string_view field);

/// Reads a boolean field.
Result<bool> Boolean(std::string_view document, std::string_view field);

/// Reads a field as text whatever its type is: a string's contents unescaped, or
/// the bare token — `true`, `false`, a number — exactly as it was written.
///
/// For the one message whose value is genuinely of no fixed type. `SetFeature`
/// carries whatever a plugin gave it and the feature that consumes it knows its
/// own shape, so this layer must not decide: reading it with {@link String}
/// turned every boolean a plugin sent into a refusal, and a refusal there is a
/// switch that silently does nothing.
Result<std::string> Value(std::string_view document, std::string_view field);

/// Builds a flat object one field at a time.
///
/// Deliberately append-only and stringly typed: the alternative is a document
/// model, which is a library, which is the thing this file exists not to be.
class Writer {
  public:
    Writer& Str(std::string_view field, std::string_view value);
    Writer& Int(std::string_view field, std::int64_t value);
    Writer& Bool(std::string_view field, bool value);

    /// The finished object. The writer may not be used afterwards.
    [[nodiscard]] std::string Finish();

  private:
    void Separate();

    std::string body_;
    bool empty_ = true;
    bool finished_ = false;
};

}  // namespace brownie::ipc::json
