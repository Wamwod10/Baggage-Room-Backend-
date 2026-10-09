const assert = require('node:assert/strict');
const spec = require('../src/integrations/jarvis/openapi.json');

// Validate the subset used by this API against actual HTTP responses, not mocks.
function assertSchema(value, schema, label = 'response') {
  if (schema.$ref) return assertSchema(value, spec.components.schemas[schema.$ref.split('/').pop()], label);
  if (value === null && schema.nullable) return;
  if (schema.enum) assert.ok(schema.enum.includes(value), `${label}: invalid enum`);
  switch (schema.type) {
    case 'object':
      assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
      for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${label}.${key}: required`);
      for (const [key, item] of Object.entries(value)) {
        if (schema.additionalProperties === false) assert.ok(Object.hasOwn(schema.properties, key), `${label}.${key}: unexpected field`);
        if (schema.properties?.[key]) assertSchema(item, schema.properties[key], `${label}.${key}`);
      }
      break;
    case 'array': assert.ok(Array.isArray(value), `${label}: array required`); value.forEach((item, n) => assertSchema(item, schema.items, `${label}[${n}]`)); break;
    case 'integer': assert.ok(Number.isSafeInteger(value), `${label}: integer required`); break;
    case 'boolean': assert.equal(typeof value, 'boolean', `${label}: boolean required`); break;
    case 'string':
      assert.equal(typeof value, 'string', `${label}: string required`);
      if (schema.pattern) assert.match(value, new RegExp(schema.pattern), label);
      if (schema.format === 'date-time') assert.ok(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), `${label}: timestamp required`);
      if (schema.format === 'date') assert.match(value, /^\d{4}-\d{2}-\d{2}$/, label);
      if (schema.format === 'uuid') assert.match(value, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i, label);
      break;
    default: throw new Error(`Unsupported contract schema type: ${schema.type}`);
  }
  if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, label);
  if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, label);
}

function assertResponse(endpoint, status, body) {
  const schema = spec.paths['/' + endpoint].get.responses[String(status)].content['application/json'].schema;
  assertSchema(body, schema, endpoint);
}
module.exports = { assertResponse };
