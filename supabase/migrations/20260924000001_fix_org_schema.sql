-- Migration to fix Org schema: employees.company_id, company_members, agent_presence, etc.

-- 1. Fix employees table
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS company_id UUID DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS role_template_id TEXT;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS pane TEXT;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS project TEXT;

UPDATE public.employees SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;

-- 2. Create company_members table if not exists
CREATE TABLE IF NOT EXISTS public.company_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID,
    role TEXT DEFAULT 'owner',
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT company_members_company_user_key UNIQUE (company_id, user_id)
);

-- Seed company_members for default workspace
INSERT INTO public.company_members (company_id, user_id, role)
VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner')
ON CONFLICT (company_id, user_id) DO NOTHING;

-- 3. Create agent_presence table if not exists
CREATE TABLE IF NOT EXISTS public.agent_presence (
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    status TEXT DEFAULT 'idle',
    activity TEXT,
    current_task_id TEXT,
    pane TEXT,
    owner_client_id TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (company_id, agent_id)
);

-- 4. Ensure teams has wing_slug and company_id
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS wing_slug TEXT;
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS company_id UUID DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.companies(id) ON DELETE CASCADE;
UPDATE public.teams SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;

-- 5. Ensure role_templates has all queried fields
ALTER TABLE public.role_templates ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.role_templates ADD COLUMN IF NOT EXISTS default_engine TEXT;
ALTER TABLE public.role_templates ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE public.role_templates ADD COLUMN IF NOT EXISTS preset JSONB;

-- 6. Ensure companies settings has onboarded: true
UPDATE public.companies 
SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{onboarded}', 'true'::jsonb, true)
WHERE id = '00000000-0000-0000-0000-000000000001';

-- 7. Seed default team and employee if empty
INSERT INTO public.teams (id, company_id, name, slug, wing_slug)
VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Core Team', 'core-team', 'core')
ON CONFLICT (slug) DO NOTHING;

-- agents.name was added by hand on the original local stack and never captured in a
-- migration; the seed below needs it, so make this migration reproducible on a fresh DB.
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS name TEXT;

INSERT INTO public.agents (id, company_id, name, display_name, role, department)
VALUES ('lead-agent', '00000000-0000-0000-0000-000000000001', 'Agent X', 'Agent X', 'Team Lead', 'Engineering')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.employees (id, company_id, team_id, agent_id, display_name, engine, model, effort, sprite)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'lead-agent',
    'Agent X',
    'claude',
    'sonnet',
    'medium',
    'char_01'
)
ON CONFLICT (id) DO NOTHING;

-- Grant permissions for anon and authenticated
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
