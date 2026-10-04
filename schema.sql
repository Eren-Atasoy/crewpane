-- ============================================================================
-- CrewPane (CrewPane) Local Supabase Schema
-- Generated for local and self-hosted environments
-- ============================================================================

-- 1. COMPANIES & ORGANIZATION
CREATE TABLE IF NOT EXISTS public.companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE DEFAULT 'default-org',
    name TEXT NOT NULL DEFAULT 'Default Workspace',
    settings JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Insert a default company if none exists
INSERT INTO public.companies (id, slug, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'CrewPane Workspace')
ON CONFLICT (id) DO NOTHING;

-- 2. DEPARTMENTS
CREATE TABLE IF NOT EXISTS public.departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.departments (slug, name)
VALUES 
    ('engineering', 'Engineering'),
    ('product', 'Product'),
    ('design', 'Design'),
    ('operations', 'Operations'),
    ('marketing', 'Marketing')
ON CONFLICT (slug) DO NOTHING;

-- 3. TEAMS
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    slug TEXT UNIQUE NOT NULL,
    wing_slug TEXT,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.teams (slug, name, wing_slug)
VALUES 
    ('core', 'Core Team', 'engineering'),
    ('frontend', 'Frontend Team', 'engineering'),
    ('backend', 'Backend Team', 'engineering')
ON CONFLICT (slug) DO NOTHING;

-- 4. PROJECTS
CREATE TABLE IF NOT EXISTS public.projects (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    default_branch TEXT DEFAULT 'main',
    isolation TEXT DEFAULT 'shared',
    merge_approval TEXT DEFAULT 'auto',
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.projects (slug, name, description)
VALUES ('crewpane', 'CrewPane Main', 'Main workspace project')
ON CONFLICT (slug) DO NOTHING;

-- 5. AGENTS
CREATE TABLE IF NOT EXISTS public.agents (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    department TEXT,
    role TEXT,
    status TEXT DEFAULT 'idle',
    last_updated TIMESTAMPTZ DEFAULT now(),
    current_task_id TEXT,
    current_project TEXT,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. EMPLOYEES
CREATE TABLE IF NOT EXISTS public.employees (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    agent_id TEXT REFERENCES public.agents(id) ON DELETE CASCADE,
    team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
    role_template_id TEXT,
    display_name TEXT,
    pane TEXT,
    project TEXT,
    engine TEXT DEFAULT 'claude',
    model TEXT DEFAULT 'sonnet',
    effort TEXT DEFAULT 'medium',
    provider TEXT,
    sprite TEXT,
    desk_position JSONB,
    desk_position_seed TEXT,
    expertise TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 6b. COMPANY MEMBERS
CREATE TABLE IF NOT EXISTS public.company_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    user_id UUID,
    role TEXT DEFAULT 'owner',
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT company_members_company_user_key UNIQUE (company_id, user_id)
);

-- 6c. AGENT PRESENCE
CREATE TABLE IF NOT EXISTS public.agent_presence (
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    agent_id TEXT NOT NULL,
    status TEXT DEFAULT 'idle',
    activity TEXT,
    current_task_id TEXT,
    pane TEXT,
    owner_client_id TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (company_id, agent_id)
);

-- 7. TASKS (KANBAN)
CREATE TABLE IF NOT EXISTS public.tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog', 'todo', 'in_progress', 'review', 'done')),
    priority INTEGER DEFAULT 3,
    project TEXT REFERENCES public.projects(slug) ON DELETE CASCADE DEFAULT 'crewpane',
    sprint TEXT,
    assigned_agent_id TEXT,
    department_id UUID,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    merge_state TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 8. TASK ATTACHMENTS
CREATE TABLE IF NOT EXISTS public.task_attachments (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    task_id TEXT REFERENCES public.tasks(id) ON DELETE CASCADE,
    cover BOOLEAN DEFAULT false,
    local_rel_path TEXT,
    thumb_data_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. TASK COMMENTS
CREATE TABLE IF NOT EXISTS public.task_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id TEXT REFERENCES public.tasks(id) ON DELETE CASCADE,
    author TEXT,
    content TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 10. AGENT MEMORIES
CREATE TABLE IF NOT EXISTS public.agent_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope TEXT NOT NULL CHECK (scope IN ('agent', 'company')),
    agent_id TEXT,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    department TEXT,
    kind TEXT DEFAULT 'note' CHECK (kind IN ('note', 'fact', 'preference', 'outcome')),
    content TEXT NOT NULL,
    source_slug TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 11. CREWPANE FILES (WORKSPACE SYNC)
CREATE TABLE IF NOT EXISTS public.crewpane_files (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    class TEXT NOT NULL CHECK (class IN ('memory', 'memory-global', 'skill', 'prefs')),
    rel_path TEXT NOT NULL,
    sha256 TEXT,
    size_bytes BIGINT DEFAULT 0,
    body TEXT,
    body_encoding TEXT DEFAULT 'utf8',
    rev INTEGER DEFAULT 1,
    origin_device TEXT,
    workspace_key TEXT DEFAULT 'global',
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    deleted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 12. SYNC CONFLICTS
CREATE TABLE IF NOT EXISTS public.sync_conflicts (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    rel_path TEXT NOT NULL,
    class TEXT NOT NULL,
    loser_sha256 TEXT,
    loser_body TEXT,
    workspace_key TEXT DEFAULT 'global',
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 13. WORKSPACES
CREATE TABLE IF NOT EXISTS public.crewpane_workspaces (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    workspace_key TEXT UNIQUE NOT NULL,
    name TEXT,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000001',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 14. APP INSTALLS & TELEMETRY
CREATE TABLE IF NOT EXISTS public.app_installs (
    install_id TEXT PRIMARY KEY,
    platform TEXT,
    app_version TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_seen_at TIMESTAMPTZ DEFAULT now()
);

-- 15. DEVICES
CREATE TABLE IF NOT EXISTS public.devices (
    id TEXT PRIMARY KEY,
    name TEXT,
    platform TEXT,
    user_id UUID,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 16. ENGINES SEED TABLE
CREATE TABLE IF NOT EXISTS public.engines (
    id TEXT PRIMARY KEY,
    label TEXT,
    command TEXT,
    enabled BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0
);

INSERT INTO public.engines (id, label, command, enabled, sort_order)
VALUES 
    ('claude', 'Claude Code', 'claude', true, 1),
    ('codex', 'Codex', 'codex', true, 2),
    ('gemini', 'Gemini CLI', 'gemini', true, 3),
    ('opencode', 'OpenCode', 'opencode', true, 4)
ON CONFLICT (id) DO NOTHING;

-- 17. ROLE TEMPLATES
CREATE TABLE IF NOT EXISTS public.role_templates (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    slug TEXT UNIQUE,
    name TEXT,
    description TEXT,
    category TEXT,
    default_engine TEXT,
    default_sprite TEXT,
    preset JSONB,
    system_prompt TEXT
);

-- ============================================================================
-- RPC FUNCTIONS
-- ============================================================================

-- set_task_cover RPC
CREATE OR REPLACE FUNCTION public.set_task_cover(p_task_id TEXT, p_attachment_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE public.task_attachments SET cover = false WHERE task_id = p_task_id;
    UPDATE public.task_attachments SET cover = true WHERE id = p_attachment_id AND task_id = p_task_id;
    RETURN jsonb_build_object('ok', true);
END;
$$;

-- crewpane_file_tombstone RPC
CREATE OR REPLACE FUNCTION public.crewpane_file_tombstone(p_file_id TEXT, p_restore BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_restore THEN
        UPDATE public.crewpane_files SET deleted_at = NULL WHERE id = p_file_id;
    ELSE
        UPDATE public.crewpane_files SET deleted_at = now() WHERE id = p_file_id;
    END IF;
    RETURN jsonb_build_object('ok', true);
END;
$$;

-- crewpane_e2e_residue RPC
CREATE OR REPLACE FUNCTION public.crewpane_e2e_residue()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================================
-- GRANTS: Give anonymous and authenticated roles full read/write access locally
-- ============================================================================
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, postgres, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, postgres, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO anon, authenticated, postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, postgres, service_role;
