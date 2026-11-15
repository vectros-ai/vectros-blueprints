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
  companyNameOf,
  isRestrictedToDomainName,
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
  type BlueprintRoleAssumable,
  type BlueprintRoleAssumableMap,
  type BlueprintRoles,
  type BlueprintFragments,
  type IdentityDecl,
  type IdentitiesDecl,
  type BlueprintIssue,
  type BlueprintIssuer,
  type BlueprintNamespace,
  type BlueprintScriptEntry,
  type BlueprintScripts,
  type BlueprintAgents,
  type BlueprintAgent,
  type LoaderPhase,
  BLUEPRINT_FIELD_PHASES,
  BLUEPRINT_FORMAT_VERSION,
  assertSupportedFormatVersion,
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

export {
  composeBlueprint,
  readIncludeDirective,
  mergeStacks,
  parseIssuePath,
  BlueprintCompositionError,
  BLUEPRINT_PART_KEYS,
  BLUEPRINT_ROOT_ONLY_KEYS,
  ROOT_STACK,
  type BlueprintPartKey,
  type BlueprintSource,
  type BlueprintIncludeDirective,
  type ComposedBlueprint,
  type StackContents,
} from './compose.js';

import type { Blueprint } from './types.js';
import taskManagement from './blueprints/task-management.js';
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
export { inputSchemaIssue, storedInputSchemaForm, sameJson } from './script-input-schema.js';
