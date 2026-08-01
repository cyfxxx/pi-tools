export const Type = {
  String(options?: Record<string, unknown>) { return { type: 'string', ...options } as const },
  Number(options?: Record<string, unknown>) { return { type: 'number', ...options } as const },
  Boolean(options?: Record<string, unknown>) { return { type: 'boolean', ...options } as const },
  Array(schema: unknown, options?: Record<string, unknown>) { return { type: 'array', items: schema, ...options } as const },
  Object(schema: Record<string, unknown>, options?: Record<string, unknown>) { return { type: 'object', properties: schema, ...options } as const },
  Union(schemas: unknown[]) { return { anyOf: schemas } as const },
  Optional(schema: unknown) { return schema },
  Record(key: unknown, value: unknown) { return { type: 'object', additionalProperties: value } as const },
}
