import type { FieldValue, ObjectSchema, PacketSchema } from './types.js';

/**
 * The value the game assumes when a trailing optional field is absent.
 *
 * The decoder deliberately does *not* apply this: on the wire, absent and
 * "present, holding the default" are different, and only keeping them apart
 * lets an untouched packet re-encode to the same bytes. Callers that want the
 * game's assumption ask for it here.
 */
export function fieldDefault(
  schema: PacketSchema | ObjectSchema,
  fieldName: string,
): FieldValue | undefined {
  return schema.fields.find((field) => field.name === fieldName)?.defaultValue;
}

/**
 * Reads a field, falling back to its schema default when the packet did not
 * carry it. This is the accessor most callers actually want.
 */
export function fieldOr(
  schema: PacketSchema | ObjectSchema,
  fields: Readonly<Record<string, FieldValue | undefined>>,
  fieldName: string,
): FieldValue | undefined {
  return fields[fieldName] ?? fieldDefault(schema, fieldName);
}
