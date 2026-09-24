import type { FastifyInstance } from "fastify";

/**
 * MFA has been removed from Super Admin authentication.
 *
 * This no-op export is kept temporarily so older imports or deployment bundles
 * fail safely during rolling upgrades. The API server no longer registers it.
 */
export async function adminAuthRoutes(_app: FastifyInstance): Promise<void> {
  // Intentionally empty.
}
