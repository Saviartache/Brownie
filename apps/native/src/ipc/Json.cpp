#include "ipc/Json.h"

#include <cstdint>

namespace brownie::ipc::json {
namespace {

/// Finds `"field":` and returns where its value starts, skipping whitespace.
Result<std::size_t> ValueStart(std::string_view document, std::string_view field) {
    std::string needle;
    needle.reserve(field.size() + 3);
    needle.push_back('"');
    needle.append(field);
    needle.append("\":");

    const auto at = document.find(needle);
    if (at == std::string_view::npos) {
        return Error{ErrorCode::kProtocol, "a required field is missing"};
    }
    auto value = at + needle.size();
    while (value < document.size() && (document[value] == ' ' || document[value] == '\t')) {
        ++value;
    }
    if (value >= document.size()) {
        return Error{ErrorCode::kProtocol, "a field has no value"};
    }
    return value;
}

}  // namespace

Result<std::string> String(std::string_view document, std::string_view field) {
    auto start = ValueStart(document, field);
    if (!start.ok()) return start.error();
    std::size_t at = start.value();
    if (document[at] != '"') {
        return Error{ErrorCode::kProtocol, "a field that must be a string is not one"};
    }

    std::string value;
    for (++at; at < document.size(); ++at) {
        const char c = document[at];
        if (c == '"') {
            return value;
        }
        if (c != '\\') {
            value.push_back(c);
            continue;
        }
        if (++at >= document.size()) {
            break;
        }
        switch (document[at]) {
            case 'n':
                value.push_back('\n');
                break;
            case 't':
                value.push_back('\t');
                break;
            case 'r':
                value.push_back('\r');
                break;
            // Unicode escapes are not decoded. Nothing the runtime's encoder
            // produces for this protocol contains one, and half-implementing it
            // — accepting the sequence and storing something else — would be
            // worse than refusing and naming the case that is unhandled.
            case 'u':
                return Error{ErrorCode::kUnsupported, "unicode escapes are not decoded"};
            default:
                value.push_back(document[at]);
                break;
        }
    }
    return Error{ErrorCode::kProtocol, "an unterminated string"};
}

Result<std::int64_t> Integer(std::string_view document, std::string_view field) {
    auto start = ValueStart(document, field);
    if (!start.ok()) return start.error();

    std::size_t at = start.value();
    const bool negative = document[at] == '-';
    if (negative) {
        ++at;
    }

    std::int64_t value = 0;
    std::size_t digits = 0;
    for (; at < document.size() && document[at] >= '0' && document[at] <= '9'; ++at, ++digits) {
        // Refused rather than wrapped: a number too large to represent is a
        // peer sending something this build cannot mean, not a value to guess.
        if (value > (INT64_MAX - 9) / 10) {
            return Error{ErrorCode::kProtocol, "a number too large to represent"};
        }
        value = value * 10 + (document[at] - '0');
    }
    if (digits == 0) {
        return Error{ErrorCode::kProtocol, "a field that must be a number is not one"};
    }
    return negative ? -value : value;
}

Result<std::string> Value(std::string_view document, std::string_view field) {
    auto start = ValueStart(document, field);
    if (!start.ok()) return start.error();

    const std::size_t at = start.value();
    if (document[at] == '"') {
        return String(document, field);
    }

    // A bare token runs to the end of the value: this protocol's objects are
    // flat, so the first separator that follows is the end of it.
    const std::string_view rest = document.substr(at);
    const auto end = rest.find_first_of(",}");
    const std::string_view token = rest.substr(0, end);
    const auto last = token.find_last_not_of(" \t");
    if (last == std::string_view::npos) {
        return Error{ErrorCode::kProtocol, "a field has no value"};
    }
    return std::string{token.substr(0, last + 1)};
}

Result<bool> Boolean(std::string_view document, std::string_view field) {
    auto start = ValueStart(document, field);
    if (!start.ok()) return start.error();

    const std::string_view rest = document.substr(start.value());
    if (rest.starts_with("true")) return true;
    if (rest.starts_with("false")) return false;
    return Error{ErrorCode::kProtocol, "a field that must be a boolean is not one"};
}

void Writer::Separate() {
    if (empty_) {
        empty_ = false;
        return;
    }
    body_.push_back(',');
}

Writer& Writer::Str(std::string_view field, std::string_view value) {
    Separate();
    body_.push_back('"');
    body_.append(field);
    body_.append("\":\"");
    for (const char c : value) {
        // Only what this protocol can carry: identifiers, hex, and record text
        // that is already percent-encoded. The two characters that would break
        // the document are escaped; nothing else needs to be.
        if (c == '"' || c == '\\') {
            body_.push_back('\\');
        }
        body_.push_back(c);
    }
    body_.push_back('"');
    return *this;
}

Writer& Writer::Int(std::string_view field, std::int64_t value) {
    Separate();
    body_.push_back('"');
    body_.append(field);
    body_.append("\":");
    body_.append(std::to_string(value));
    return *this;
}

Writer& Writer::Bool(std::string_view field, bool value) {
    Separate();
    body_.push_back('"');
    body_.append(field);
    body_.append("\":");
    body_.append(value ? "true" : "false");
    return *this;
}

std::string Writer::Finish() {
    // Single-use, and it says so: a writer reused after finishing would append
    // to a document somebody already sent.
    if (finished_) return "{}";
    finished_ = true;
    return "{" + body_ + "}";
}

}  // namespace brownie::ipc::json
