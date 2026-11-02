-- Discover only the verified actor's own memberships before choosing a workspace.
CREATE POLICY membership_self_read ON "Membership" FOR SELECT USING ("userId" = current_setting('app.actor_id',true));
