export {
  buildInfoId,
  buildProbeId,
  buildServiceId,
  buildWidgetId,
  type BuildInfoIdInput,
  type BuildProbeIdInput,
  type BuildServiceIdInput,
  type BuildWidgetIdInput,
} from "./builders.js";

export {
  CANONICAL_FIELD_SEP,
  CANONICAL_VERSION,
  buildInfoCanonical,
  buildProbeCanonical,
  buildServiceCanonical,
  buildWidgetCanonical,
  joinCanonicalParts,
  type EmptyTargetIdentity,
  type InfoCanonicalInput,
  type InfoTargetIdentity,
  type OpenMeteoTargetIdentity,
  type ProbeCanonicalInput,
  type ResourcesTargetIdentity,
  type ServiceCanonicalInput,
  type WidgetCanonicalInput,
} from "./canonical.js";

export {
  STABLE_ID_HASH_HEX_LENGTH,
  STABLE_ID_PREFIX,
  buildStableId,
  sha256Hex,
  type StableIdKind,
} from "./hash.js";

export {
  normalizeAbsoluteHttpUrl,
  normalizeCoordinate,
  normalizeDiskPathIdentity,
  normalizeDiskPathSet,
  normalizeTypeToken,
} from "./normalize.js";

export {
  assignStableIdsFromFixture,
  collectPublicIdSurfaces,
  findMissedAllowListIdsFromResults,
  serializeFourIdSets,
  type FixtureInfoWidget,
  type FixtureServiceItem,
  type FixtureServiceWidget,
  type FourIdSets,
  type IdAssignmentFixture,
  type IdAssignmentResult,
  type InfoAllowEntry,
  type ProbeAllowEntry,
  type SimulatedAllowList,
  type WidgetAllowEntry,
} from "./assign-from-fixture.js";
