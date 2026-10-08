-- Migration 041: permite 'lab' como ambiente do cadastro de Deploys
-- (componentes de teste da integração SmartOne rodam no ambiente Lab).
ALTER TABLE deploy_apps DROP CONSTRAINT IF EXISTS deploy_apps_environment_check;
ALTER TABLE deploy_apps ADD CONSTRAINT deploy_apps_environment_check
  CHECK (environment IN ('production','staging','development','sandbox','lab'));
