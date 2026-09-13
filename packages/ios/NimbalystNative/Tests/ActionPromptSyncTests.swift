import XCTest
@testable import NimbalystNative

/// Tests for the action-prompt half of the project config blob.
///
/// The interesting cases are all compatibility ones: the blob is shared with
/// slash commands and is written by desktops of varying vintage, so decoding
/// must survive a missing `actions` key and must never lose the commands.
final class ActionPromptSyncTests: XCTestCase {

    func testDecodesCommandsAndActionsTogether() {
        let json = """
        {
          "commands": [{"name": "review", "description": "Review", "source": "project"}],
          "lastCommandsUpdate": 100,
          "actions": [{"id": "plan", "label": "Plan", "body": "plan it"}],
          "lastActionsUpdate": 200
        }
        """

        let decoded = decodeProjectConfig(fromJson: json)

        XCTAssertNotNil(decoded.commandsJson)
        XCTAssertNotNil(decoded.actionsJson)

        let project = Project(
            id: "/tmp/p", name: "p",
            commandsJson: decoded.commandsJson,
            actionsJson: decoded.actionsJson
        )
        XCTAssertEqual(project.commands.map(\.name), ["review"])
        XCTAssertEqual(project.actions.map(\.id), ["plan"])
        XCTAssertEqual(project.actions.first?.body, "plan it")
    }

    /// An older desktop sends no `actions` key at all. The phone must still get
    /// its commands, and must read actions as empty rather than failing decode.
    func testOlderDesktopWithoutActionsKeyStillDecodesCommands() {
        let json = """
        {
          "commands": [{"name": "review", "description": "Review", "source": "project"}],
          "lastCommandsUpdate": 100
        }
        """

        let decoded = decodeProjectConfig(fromJson: json)

        XCTAssertNotNil(decoded.commandsJson)
        XCTAssertNil(decoded.actionsJson)

        let project = Project(id: "/tmp/p", name: "p", commandsJson: decoded.commandsJson, actionsJson: nil)
        XCTAssertEqual(project.commands.count, 1)
        XCTAssertTrue(project.actions.isEmpty)
    }

    /// A workspace with actions and no slash commands. The desktop used to
    /// publish nothing at all in this case; now that it does, the phone has to
    /// handle an empty command list beside a populated action list.
    func testActionsWithoutCommands() {
        let json = """
        {
          "commands": [],
          "lastCommandsUpdate": 0,
          "actions": [{"id": "plan", "label": "Plan", "body": "plan it"}],
          "lastActionsUpdate": 200
        }
        """

        let decoded = decodeProjectConfig(fromJson: json)
        let project = Project(
            id: "/tmp/p", name: "p",
            commandsJson: decoded.commandsJson,
            actionsJson: decoded.actionsJson
        )

        XCTAssertTrue(project.commands.isEmpty)
        XCTAssertEqual(project.actions.map(\.id), ["plan"])
    }

    /// Unknown keys from a newer desktop must not break decoding on an older
    /// build's shape. Swift synthesizes a decoder that ignores them; this pins
    /// that so a future field addition is not a silent client break.
    func testUnknownKeysAreIgnored() {
        let json = """
        {
          "commands": [],
          "lastCommandsUpdate": 0,
          "actions": [{"id": "plan", "label": "Plan", "body": "b", "somethingNew": 42}],
          "lastActionsUpdate": 1,
          "aFutureField": {"nested": true}
        }
        """

        let decoded = decodeProjectConfig(fromJson: json)
        let project = Project(id: "/tmp/p", name: "p", actionsJson: decoded.actionsJson)

        XCTAssertEqual(project.actions.map(\.id), ["plan"])
    }

    func testMalformedBlobYieldsEmptyRatherThanCrashing() {
        let decoded = decodeProjectConfig(fromJson: "not json at all")

        XCTAssertNil(decoded.commandsJson)
        XCTAssertNil(decoded.actionsJson)
    }

    func testLaunchMetadataDrivesMobileBehavior() {
        let json = """
        {
          "commands": [],
          "lastCommandsUpdate": 0,
          "actions": [
            {"id": "same", "label": "Same", "body": "b"},
            {"id": "new", "label": "New", "body": "b", "launch": "new-session", "model": "claude-code:opus"},
            {"id": "tree", "label": "Tree", "body": "b", "launch": "new-session", "worktree": true}
          ],
          "lastActionsUpdate": 1
        }
        """

        let project = Project(id: "/tmp/p", name: "p", actionsJson: decodeProjectConfig(fromJson: json).actionsJson)
        let actions = project.actions

        XCTAssertFalse(actions[0].launchesNewSession)
        XCTAssertTrue(actions[1].launchesNewSession)
        XCTAssertEqual(actions[1].model, "claude-code:opus")
        // Worktree launches need a worktree created first, which the phone
        // cannot drive; they must not be offered as launchers.
        XCTAssertTrue(actions[1].isSupportedOnMobile)
        XCTAssertFalse(actions[2].isSupportedOnMobile)
    }
}
