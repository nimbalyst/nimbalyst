import { net } from "electron";
import type { PageToolProjectSummary } from "@nimbalyst/collab-protocol";
import {
  getOrgScopedJwt,
  resolveTeamForWorkspace,
  type TeamDetails,
  type TeamProjectSummary,
} from "../../services/TeamService";
import { currentTeamProjectId } from "../../services/teamCurrentProject";
import { getCollabSyncHttpUrl } from "../../utils/collabSyncUrl";

/**
 * The `project` argument of the desktop page read tools (`listPages`,
 * `readCollabDoc`). The window shows one project; an agent reads another
 * project in the same org only by naming it. The current project (absent, or
 * named) is the live local session, as before. Another project is read through
 * the sync server's `POST /api/teams/{orgId}/projects/{projectId}/pages/read`,
 * which runs the remote Pages tool for that project, so types, typed pages and
 * item bodies come back at the same fidelity, and its result is passed through
 * unchanged. The server decides whether the member can read the project.
 *
 * Writes always go to the current project; `refuseOtherProjectWrite` turns a
 * write that names another one away.
 */

type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
};

export type PageReadTool = "listPages" | "readCollabDoc" | "searchPages";

/** Runs the tool on the local session; `extra` is merged into a listPages result. */
export type LocalPageRead<T> = (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<T>;

type ProjectResolution =
  | { kind: "own" }
  | { kind: "other"; orgId: string; project: PageToolProjectSummary }
  | { kind: "refused"; message: string };

const errorResult = (text: string): McpToolResult => ({ content: [{ type: "text", text }], isError: true });

const summary = (project: TeamProjectSummary): PageToolProjectSummary => ({
  projectId: project.teamProjectId,
  projectName: project.name ?? project.slug ?? null,
});

const projectLabel = (project: PageToolProjectSummary) =>
  project.projectName ? `${project.projectName} (${project.projectId})` : project.projectId;

const isNamed = (project: unknown) => project !== undefined && project !== null && project !== "";

/** The workspace's team, or null when it has none. Throws while the directory is unavailable. */
async function findTeam(workspacePath: string | undefined): Promise<TeamDetails | null> {
  if (!workspacePath) return null;
  const resolution = await resolveTeamForWorkspace(workspacePath);
  if (!resolution.complete) throw new Error("The team directory is unavailable. Try again later.");
  return resolution.team;
}

/** The project listed, and the org's others an agent can pass as `project`. */
function projectsOf(team: TeamDetails): { project?: PageToolProjectSummary; otherProjects: PageToolProjectSummary[] } {
  const own = currentTeamProjectId(team);
  const projects = team.projects ?? [];
  const current = projects.find((project) => project.teamProjectId === own);
  return {
    ...(current ? { project: summary(current) } : own ? { project: { projectId: own, projectName: null } } : {}),
    otherProjects: projects.filter((project) => project.teamProjectId !== own).map(summary),
  };
}

/**
 * The project `project` names: an id (the routing key or the registry id), or
 * a name or slug, matched without case. An ambiguous or unknown name is
 * refused, never guessed.
 */
export function resolvePageProject(team: TeamDetails | null, project: unknown): ProjectResolution {
  if (!isNamed(project)) return { kind: "own" };
  if (typeof project !== "string") return { kind: "refused", message: "`project` is a project id or name in this workspace's team." };
  if (!team) return { kind: "refused", message: "This workspace has no team, so there is no other project to read." };
  const wanted = project.trim();
  const own = currentTeamProjectId(team);
  const projects = team.projects ?? [];
  const target = (match: TeamProjectSummary): ProjectResolution =>
    match.teamProjectId === own ? { kind: "own" } : { kind: "other", orgId: team.orgId, project: summary(match) };

  const byId = projects.find((candidate) => candidate.teamProjectId === wanted || candidate.projectId === wanted);
  if (byId) return target(byId);
  if (own && wanted === own) return { kind: "own" };
  const lower = wanted.toLowerCase();
  const byName = projects.filter((candidate) =>
    candidate.name?.trim().toLowerCase() === lower || candidate.slug?.toLowerCase() === lower);
  if (byName.length === 1) return target(byName[0]);
  if (byName.length > 1) {
    return {
      kind: "refused",
      message: `"${wanted}" names ${byName.length} projects in ${team.name}: ${byName.map((candidate) => projectLabel(summary(candidate))).join(", ")}. Pass the project id.`,
    };
  }
  const known = projects.map((candidate) => projectLabel(summary(candidate))).join(", ");
  return { kind: "refused", message: `No project "${wanted}" in ${team.name}.${known ? ` Its projects: ${known}.` : ""}` };
}

/** One read tool run by the sync server in another project. */
async function readInProject(
  orgId: string,
  projectId: string,
  tool: PageReadTool,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  // Team collaboration: the org-scoped team JWT, never the personal one.
  const jwt = await getOrgScopedJwt(orgId);
  const url = `${getCollabSyncHttpUrl()}/api/teams/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/pages/read`;
  let response: Response;
  try {
    response = await net.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ tool, args }),
    });
  } catch (error) {
    return { ok: false, error: `Could not reach the sync server: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON answer is reported by its status below.
  }
  if (!response.ok) {
    // The server's code and message, e.g. 403 project_not_accessible for a project without a grant.
    const refusal = body as { error?: string; error_description?: string } | null;
    const code = refusal?.error ?? `HTTP ${response.status}`;
    return { ok: false, error: refusal?.error_description ? `${code}: ${refusal.error_description}` : code };
  }
  return { ok: true, data: body };
}

/** Run a page read tool in the project its `project` argument names. */
export async function routePageRead<T>(
  tool: PageReadTool,
  args: Record<string, unknown> | undefined,
  workspacePath: string | undefined,
  readLocal: LocalPageRead<T>,
): Promise<T | McpToolResult> {
  const { project, ...rest } = args ?? {};
  const named = isNamed(project);
  if (named && rest.section === "personal") {
    return errorResult(`${tool}: \`project\` names a team project; Local (personal) pages belong to this project only.`);
  }
  // Only a team listPages names its projects; anything else unnamed is a plain local read.
  if (!named && (tool !== "listPages" || rest.section === "personal")) return readLocal(rest);

  let team: TeamDetails | null;
  try {
    team = await findTeam(workspacePath);
  } catch (error) {
    if (!named) return readLocal(rest);
    return errorResult(`${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const target = resolvePageProject(team, project);
  if (target.kind === "refused") return errorResult(`${tool}: ${target.message}`);
  if (target.kind === "own") return tool === "listPages" && team ? readLocal(rest, projectsOf(team)) : readLocal(rest);

  const result = await readInProject(target.orgId, target.project.projectId, tool, rest);
  if (!result.ok) return errorResult(`${tool} in ${projectLabel(target.project)} failed: ${result.error}`);
  return { content: [{ type: "text", text: JSON.stringify(result.data) }], isError: false };
}

/** Why a page write naming `project` is refused, or null when it names the current project (or none). */
export async function refuseOtherProjectWrite(
  tool: string,
  args: Record<string, unknown> | undefined,
  workspacePath: string | undefined,
): Promise<string | null> {
  if (!isNamed(args?.project)) return null;
  let team: TeamDetails | null;
  try {
    team = await findTeam(workspacePath);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const target = resolvePageProject(team, args?.project);
  if (target.kind === "own") return null;
  if (target.kind === "refused") return target.message;
  return `${tool} changes the current project only; ${projectLabel(target.project)} can be read with listPages and readCollabDoc but not changed from this workspace.`;
}
