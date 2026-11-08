import {
  observationCapabilities,
  observationUnavailable,
} from "@lyraseo/visibility";
import type { ObservationContext } from "./contracts";
export { observationCapabilities };
/** No live admission producer exists in phase one. Flags/caller qualification objects
 * cannot mint account, rights, bounded billing or verified principal qualification. */
export function buildObservationRequest(
  context: ObservationContext,
  _qualification?: unknown,
) {
  void _qualification; // Untrusted qualification-shaped values confer no authority.
  return observationUnavailable(context.profile);
}
