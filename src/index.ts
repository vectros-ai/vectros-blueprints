/**
 * @vectros-ai/blueprints — the Blueprint format + the curated bundled
 * library. Data + structural validation only; the scope gate (enforcement)
 * lives in @vectros-ai/cli.
 */
export {
  BlueprintSchema,
  BlueprintValidationError,
  parseBlueprint,
  parseBlueprintJson,
  contextNameOf,
  type Blueprint,
  type BlueprintFieldDef,
  type BlueprintSchemaDef,
  type BlueprintSeed,
  type BlueprintRecordSeed,
  type BlueprintDocumentSeed,
  type BlueprintSeedRecord,
  type BlueprintValidationRules,
  type BlueprintRenderHints,
  type BlueprintLookupField,
  type BlueprintRoleClause,
  type BlueprintRoles,
  type IdentityDecl,
  type IdentitiesDecl,
  type BlueprintIssue,
} from './types.js';

export {
  resolveBlueprintIdentities,
  collectIdentityReferences,
  BlueprintIdentityError,
  type IdentityResolver,
} from './identities.js';

export {
  InputsDeclSchema,
  BlueprintInputError,
  resolveBlueprintInputs,
  deriveSuffix,
  type InputDecl,
  type InputsDecl,
  type InputScalar,
} from './inputs.js';

import type { Blueprint } from './types.js';
import taskManagement from './blueprints/task-management.js';
import codingAgentMemory from './blueprints/coding-agent-memory.js';
import agenticSdlc from './blueprints/agentic-sdlc.js';
import secondBrain from './blueprints/second-brain.js';
import clinicalIntake from './blueprints/clinical-intake.js';

/**
 * The curated blueprints bundled with the library, in menu-display order.
 * To add one: drop a `blueprints/<name>.ts` exporting a `Blueprint`
 * default, import it here, and add it to this array.
 */
export const BUNDLED_BLUEPRINTS: readonly Blueprint[] = [
  taskManagement,
  codingAgentMemory,
  agenticSdlc,
  secondBrain,
  clinicalIntake,
];

/** Names available for `--blueprint <name>`. */
export const BLUEPRINT_NAMES: readonly string[] = BUNDLED_BLUEPRINTS.map((b) => b.name);

/** Look up a bundled blueprint by name; `undefined` if none matches. */
export function getBlueprint(name: string): Blueprint | undefined {
  return BUNDLED_BLUEPRINTS.find((b) => b.name === name);
}
