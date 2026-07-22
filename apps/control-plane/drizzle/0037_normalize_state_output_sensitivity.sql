UPDATE "state_versions" AS state_version
SET "outputs" = (
  SELECT jsonb_object_agg(
    output.key,
    CASE
      WHEN
        jsonb_typeof(output.value) = 'object'
        AND output.value ? 'value'
        AND NOT output.value ? 'sensitive'
      THEN output.value || '{"sensitive": false}'::jsonb
      ELSE output.value
    END
  )
  FROM jsonb_each(state_version."outputs") AS output
)
WHERE
  state_version."outputs" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_each(state_version."outputs") AS output
    WHERE
      jsonb_typeof(output.value) = 'object'
      AND output.value ? 'value'
      AND NOT output.value ? 'sensitive'
  );
