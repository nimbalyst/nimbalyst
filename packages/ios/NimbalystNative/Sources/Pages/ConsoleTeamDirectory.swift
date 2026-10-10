import Foundation

/// One org from `GET /api/teams` (collabv3 `teamDirectory.ts`), reduced to
/// what the phone needs to find a project's team.
public struct ConsoleTeamSummary: Decodable, Equatable, Sendable {
    public struct TeamProject: Decodable, Equatable, Sendable {
        public let projectId: String
        public let teamProjectId: String
        public let gitRemoteHash: String?
        public let name: String?

        public init(projectId: String, teamProjectId: String, gitRemoteHash: String?, name: String? = nil) {
            self.projectId = projectId
            self.teamProjectId = teamProjectId
            self.gitRemoteHash = gitRemoteHash
            self.name = name
        }
    }

    public let orgId: String
    public let name: String
    public let membershipType: String?
    /// Single-project teams created before the project registry.
    public let gitRemoteHash: String?
    public let teamProjectId: String?
    public let projects: [TeamProject]

    public init(orgId: String, name: String, membershipType: String? = "active_member", gitRemoteHash: String? = nil, teamProjectId: String? = nil, projects: [TeamProject] = []) {
        self.orgId = orgId
        self.name = name
        self.membershipType = membershipType
        self.gitRemoteHash = gitRemoteHash
        self.teamProjectId = teamProjectId
        self.projects = projects
    }

    private enum CodingKeys: String, CodingKey {
        case orgId, name, membershipType, gitRemoteHash, teamProjectId, projects
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        orgId = try container.decode(String.self, forKey: .orgId)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Team"
        membershipType = try container.decodeIfPresent(String.self, forKey: .membershipType)
        gitRemoteHash = try container.decodeIfPresent(String.self, forKey: .gitRemoteHash)
        teamProjectId = try container.decodeIfPresent(String.self, forKey: .teamProjectId)
        projects = try container.decodeIfPresent([TeamProject].self, forKey: .projects) ?? []
    }
}

struct ConsoleTeamsResponse: Decodable {
    let teams: [ConsoleTeamSummary]
}

/// A phone project's team project in one org.
public struct ConsoleTeamProjectMatch: Hashable, Sendable, Identifiable {
    public let orgId: String
    public let orgName: String
    public let teamProjectId: String

    public var id: String { "\(orgId)/\(teamProjectId)" }
    public var wikiRoute: ConsoleRoute? { ConsoleRoute.wiki(orgId: orgId, teamProjectId: teamProjectId) }
    public var trackersRoute: ConsoleRoute? { ConsoleRoute.trackers(orgId: orgId, teamProjectId: teamProjectId) }

    public init(orgId: String, orgName: String, teamProjectId: String) {
        self.orgId = orgId
        self.orgName = orgName
        self.teamProjectId = teamProjectId
    }
}

/// Whether a phone project has a team project, and which.
public enum ConsoleProjectMapping: Equatable, Sendable {
    case unmapped
    case mapped(ConsoleTeamProjectMatch)
    /// The same remote is shared in several orgs and the user has not picked one.
    case needsChoice([ConsoleTeamProjectMatch])
}

/// Phone project -> (orgId, teamProjectId). Pure.
public enum ConsoleTeamResolver {
    /// Every team project with this remote, in orgs the user is an active member
    /// of (the console-session mint refuses any other membership).
    public static func matches(gitRemoteHash: String?, teams: [ConsoleTeamSummary]) -> [ConsoleTeamProjectMatch] {
        guard let hash = gitRemoteHash?.trimmingCharacters(in: .whitespaces), !hash.isEmpty else { return [] }
        var seen = Set<String>()
        var result: [ConsoleTeamProjectMatch] = []
        for team in teams where (team.membershipType ?? "active_member") == "active_member" {
            var candidates = team.projects
                .filter { $0.gitRemoteHash == hash && !$0.teamProjectId.isEmpty }
                .map(\.teamProjectId)
            if team.gitRemoteHash == hash, let legacy = team.teamProjectId, !legacy.isEmpty {
                candidates.append(legacy)
            }
            for teamProjectId in candidates {
                let match = ConsoleTeamProjectMatch(orgId: team.orgId, orgName: team.name, teamProjectId: teamProjectId)
                guard match.wikiRoute != nil, seen.insert(match.id).inserted else { continue }
                result.append(match)
            }
        }
        return result
    }

    public static func mapping(gitRemoteHash: String?, teams: [ConsoleTeamSummary], rememberedOrgId: String?) -> ConsoleProjectMapping {
        let all = matches(gitRemoteHash: gitRemoteHash, teams: teams)
        switch all.count {
        case 0: return .unmapped
        case 1: return .mapped(all[0])
        default:
            if let rememberedOrgId, let chosen = all.first(where: { $0.orgId == rememberedOrgId }) {
                return .mapped(chosen)
            }
            return .needsChoice(all)
        }
    }
}

/// The org a user picked for a project whose remote is shared in several orgs.
public struct ConsoleOrgChoiceStore: @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(accountId: String, projectId: String) -> String {
        "consolePages.orgChoice.\(accountId).\(projectId)"
    }

    public func orgId(accountId: String, projectId: String) -> String? {
        defaults.string(forKey: key(accountId: accountId, projectId: projectId))
    }

    public func remember(orgId: String, accountId: String, projectId: String) {
        defaults.set(orgId, forKey: key(accountId: accountId, projectId: projectId))
    }

    public func forgetAccount(_ accountId: String) {
        let prefix = "consolePages.orgChoice.\(accountId)."
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
            defaults.removeObject(forKey: key)
        }
    }
}
