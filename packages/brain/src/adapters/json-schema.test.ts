import {
  actionDecisionSchema,
  screenSummarySchema,
  testPlanSchema,
  toJsonSchema,
} from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { strictSchema } from './json-schema'

/** Every node of a schema, depth first. */
function nodes(schema: unknown): Record<string, unknown>[] {
  if (typeof schema !== 'object' || schema === null) return []
  if (Array.isArray(schema)) return schema.flatMap(nodes)
  const node = schema as Record<string, unknown>
  return [node, ...Object.values(node).flatMap(nodes)]
}

describe('strictSchema (structured output subset, research R2)', () => {
  it.each([
    ['nextAction', actionDecisionSchema],
    ['describeScreen', screenSummarySchema],
    ['writeTest', testPlanSchema],
  ])('converts the %s answer: objects closed, no unsupported constraint left', (_, zod) => {
    const schema = strictSchema(toJsonSchema(zod))
    expect(schema).toBeDefined()
    const all = nodes(schema)
    for (const node of all) {
      for (const key of ['$schema', 'oneOf', 'minimum', 'maximum', 'minLength', 'maxLength']) {
        expect(node).not.toHaveProperty(key)
      }
      if (node.type === 'object') expect(node.additionalProperties).toBe(false)
    }
  })

  it('keeps enum, const and anyOf; moves ranges and lengths into the description', () => {
    expect(
      strictSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        oneOf: [
          {
            type: 'object',
            properties: {
              action: { type: 'string', const: 'tap' },
              element: { type: 'integer', minimum: 1, maximum: 999 },
              when: { type: 'string', format: 'date-time' },
              slug: { type: 'string', pattern: '^[a-z]+$', format: 'slug' },
              items: { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1, maxItems: 3 },
            },
            required: ['action', 'element'],
            additionalProperties: true,
          },
        ],
      }),
    ).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'tap' },
            element: { type: 'integer', description: '{minimum: 1, maximum: 999}' },
            when: { type: 'string', format: 'date-time' },
            slug: { type: 'string', description: '{pattern: "^[a-z]+$", format: "slug"}' },
            items: {
              type: 'array',
              items: { enum: ['a', 'b'] },
              minItems: 1,
              description: '{maxItems: 3}',
            },
          },
          required: ['action', 'element'],
          additionalProperties: false,
        },
      ],
    })
  })

  it('turns a tuple into an array of its item type', () => {
    expect(
      strictSchema({
        type: 'array',
        prefixItems: [
          { type: 'number', minimum: 0, maximum: 1 },
          { type: 'number', minimum: 0, maximum: 1 },
        ],
        items: false,
        minItems: 2,
        maxItems: 2,
      }),
    ).toEqual({
      type: 'array',
      items: { type: 'number', description: '{minimum: 0, maximum: 1}' },
      description: '{items: "2 items", minItems: 2, maxItems: 2}',
    })
  })

  it('writes const as a one-value enum when asked (Gemini)', () => {
    expect(
      strictSchema(
        { type: 'object', properties: { action: { type: 'string', const: 'back' } } },
        { constAsEnum: true },
      ),
    ).toEqual({
      type: 'object',
      properties: { action: { type: 'string', enum: ['back'] } },
      additionalProperties: false,
    })
  })

  it('gives up on references and on nodes without a type', () => {
    expect(strictSchema({ $ref: '#/$defs/node', $defs: { node: { type: 'object' } } })).toBe(
      undefined,
    )
    expect(strictSchema({ type: 'object', properties: { anything: {} } })).toBe(undefined)
    expect(strictSchema('string')).toBe(undefined)
  })
})
