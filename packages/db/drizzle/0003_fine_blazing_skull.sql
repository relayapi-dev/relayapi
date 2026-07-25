CREATE INDEX "invitation_email_status_expires_idx" ON "auth"."invitation" USING btree (lower("email"),"status","expiresAt");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expires_idx" ON "auth"."verification" USING btree ("expiresAt");