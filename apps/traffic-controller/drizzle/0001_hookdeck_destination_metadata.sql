ALTER TABLE traffic_control.routeable_deployments
  ADD COLUMN IF NOT EXISTS hookdeck_destination_id text,
  ADD COLUMN IF NOT EXISTS hookdeck_destination_name text,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_sync_error text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS tc_routeable_deployments_hookdeck_destination_id_idx
  ON traffic_control.routeable_deployments USING btree (hookdeck_destination_id);--> statement-breakpoint
